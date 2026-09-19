import type { GeneratedFile } from '../../generate/output-schema';
import type { PatchApplyResult, WritePlanEntry, WorkspaceFileSystem } from '../write-types';

/**
 * 增量补丁策略（T4-05 要点 1：patch）。
 *
 * 支持 **unified diff**（`@@ -a,b +c,d @@` + 上下文行 + `-`/`+` 行）。
 *
 * 两个刻意的设计：
 * 1. **容忍行号漂移**：模型给的行号常常与磁盘对不上（尤其此前已被别的补丁改过）。
 *    因此应用时先用「上下文行」在原文里定位 hunk，定位成功后再按内容替换，
 *    而不是迷信 `@@` 里的行号。
 * 2. **宁拒绝不猜**：定位失败就返回明确错误（`ok=false`），由 UI 提示重新生成；
 *    绝不做"尽力而为的部分应用"，因为半成品补丁比不应用更危险。
 */

const HUNK_HEADER = /^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/;

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** 原始行（含前缀字符 ' ' / '-' / '+'） */
  lines: string[];
}

export interface ParsedPatch {
  hunks: PatchHunk[];
  /** 不是合法 unified diff（没有 @@ 头） */
  malformed: boolean;
}

/** 解析 unified diff；\ No newline at end of file 标记会被忽略 */
export function parseUnifiedPatch(patch: string): ParsedPatch {
  const lines = patch.replace(/\r\n?/g, '\n').split('\n');
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;

  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('\\')) continue;
    if (/^[ +-]/.test(line) || line.length === 0) {
      current.lines.push(line.length === 0 ? ' ' : line);
    }
  }

  return { hunks, malformed: hunks.length === 0 };
}

/** 从 hunk 里拆出「原文片段」与「新文片段」 */
export function hunkSides(hunk: PatchHunk): { oldLines: string[]; newLines: string[] } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of hunk.lines) {
    const prefix = line[0] ?? ' ';
    const body = line.slice(1);
    if (prefix === '-') oldLines.push(body);
    else if (prefix === '+') newLines.push(body);
    else {
      oldLines.push(body);
      newLines.push(body);
    }
  }
  return { oldLines, newLines };
}

/** 在一行数组中从 from 开始找到 pattern 的位置 */
function indexOfSequence(
  haystack: readonly string[],
  pattern: readonly string[],
  from: number,
): number {
  if (pattern.length === 0) return Math.min(from, haystack.length);
  for (let index = Math.max(0, from); index + pattern.length <= haystack.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (haystack[index + offset] !== pattern[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

/** 应用一个 hunk（按上下文定位，忽略声明的行号） */
function applyHunk(
  lines: string[],
  hunk: PatchHunk,
  cursor: number,
): { ok: boolean; lines: string[]; cursor: number; error?: string } {
  const { oldLines, newLines } = hunkSides(hunk);
  const contextOnly = hunk.lines.every((line) => (line[0] ?? ' ') === ' ');
  if (contextOnly && oldLines.length > 0) {
    // 纯上下文 hunk：无需改动，只前进游标
    const found = indexOfSequence(lines, oldLines, cursor);
    return { ok: true, lines, cursor: found < 0 ? cursor : found + oldLines.length };
  }

  // 优先按 declared 行号（1-based）附近找，失败则全文件搜索
  const declared = Math.max(0, hunk.oldStart - 1);
  let position = indexOfSequence(lines, oldLines, declared);
  if (position < 0) position = indexOfSequence(lines, oldLines, 0);
  if (position < 0) {
    return {
      ok: false,
      lines,
      cursor,
      error: `补丁片段在文件中找不到对应内容（hunk @@ -${hunk.oldStart}）`,
    };
  }

  const next = [
    ...lines.slice(0, position),
    ...newLines,
    ...lines.slice(position + oldLines.length),
  ];
  return { ok: true, lines: next, cursor: position + newLines.length };
}

/** 应用整份补丁 */
export function applyUnifiedPatch(before: string, patch: string): PatchApplyResult {
  const parsed = parseUnifiedPatch(patch);
  if (parsed.malformed) {
    return {
      ok: false,
      after: null,
      hunks: 0,
      error: '补丁不是合法的 unified diff（缺少 @@ 片段头），请要求 AI 重新生成 patch',
    };
  }

  let lines = before.length === 0 ? [] : before.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let cursor = 0;

  for (const hunk of parsed.hunks) {
    const applied = applyHunk(lines, hunk, cursor);
    if (!applied.ok)
      return {
        ok: false,
        after: null,
        hunks: parsed.hunks.length,
        error: applied.error ?? '补丁应用失败',
      };
    lines = applied.lines;
    cursor = applied.cursor;
  }

  // 保留末尾换行：代码文件的常规形态
  return { ok: true, after: `${lines.join('\n')}\n`, hunks: parsed.hunks.length, error: null };
}

/** 新建文件策略：目标已存在则拒绝（改为走 patch），避免静默覆盖他人代码 */
export async function planCreate(
  fs: WorkspaceFileSystem,
  file: GeneratedFile,
  selected: boolean,
): Promise<WritePlanEntry> {
  const exists = await fs.exists(file.path);
  const before = exists ? await fs.readText(file.path) : null;

  if (exists) {
    return {
      path: file.path,
      action: 'create',
      language: file.language,
      content: file.content,
      before,
      after: null,
      blocked: true,
      blockReason: '目标文件已存在：请改为增量补丁（patch）或先删除该文件，避免静默覆盖既有实现。',
      changed: false,
      selected,
    };
  }

  return {
    path: file.path,
    action: 'create',
    language: file.language,
    content: file.content,
    before: null,
    after: normaliseEnding(file.content),
    blocked: false,
    blockReason: null,
    changed: file.content.length > 0,
    selected,
  };
}

/** 增量补丁策略：读取现状 → 应用 patch → 得到 after */
export async function planPatch(
  fs: WorkspaceFileSystem,
  file: GeneratedFile,
  selected: boolean,
): Promise<WritePlanEntry> {
  const exists = await fs.exists(file.path);
  const before = exists ? ((await fs.readText(file.path)) ?? '') : null;

  if (before === null) {
    return {
      path: file.path,
      action: 'patch',
      language: file.language,
      content: file.content,
      before: null,
      after: null,
      blocked: true,
      blockReason: '补丁目标文件不存在：请改为 create，或确认路径是否正确。',
      changed: false,
      selected,
    };
  }

  const applied = applyUnifiedPatch(before, file.content);
  if (!applied.ok) {
    return {
      path: file.path,
      action: 'patch',
      language: file.language,
      content: file.content,
      before,
      after: null,
      blocked: true,
      blockReason: applied.error ?? '补丁应用失败',
      changed: false,
      selected,
    };
  }

  return {
    path: file.path,
    action: 'patch',
    language: file.language,
    content: file.content,
    before,
    after: applied.after,
    blocked: false,
    blockReason: null,
    changed: applied.after !== before,
    selected,
  };
}

/** 删除策略：目标不存在时视为已完成（幂等） */
export async function planDelete(
  fs: WorkspaceFileSystem,
  file: GeneratedFile,
  selected: boolean,
): Promise<WritePlanEntry> {
  const exists = await fs.exists(file.path);
  const before = exists ? await fs.readText(file.path) : null;
  return {
    path: file.path,
    action: 'delete',
    language: file.language,
    content: '',
    before,
    after: '',
    blocked: false,
    blockReason: null,
    changed: exists,
    selected,
  };
}

/** 统一行尾为 \n（Windows 上避免生成物混用 CRLF） */
export function normaliseEnding(content: string): string {
  const normalised = content.replace(/\r\n?/g, '\n');
  return normalised.endsWith('\n') ? normalised : `${normalised}\n`;
}
