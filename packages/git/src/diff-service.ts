import {
  BIG_FILE_THRESHOLD_BYTES,
  type DiffLineKind,
  type FileStatus,
  type GitDiffFile,
  type GitDiffHunk,
  type GitDiffLine,
  type SideBySideRow,
} from './models';
import type { DiffFileEntry } from './backend/types';

/**
 * diff 解析服务（T6-02 要点 1）。
 *
 * 输入是 git 的 unified diff 文本，输出是**文件级 + hunk 级**的结构化模型，
 * 同时给出并排（side-by-side）与内联（inline）两种渲染所需的行模型。
 *
 * 两个易错点在这里被显式处理：
 * 1. **重命名 / 含空格路径**：`diff --git a/x b/y` 这行在路径含空格时是有歧义的
 *    （实测 `diff --git a/my file.txt b/改 名.txt`），因此解析器**优先采信**
 *    调用方传入的 `entries`（来自 `git diff --name-status -z`，NUL 分隔、无歧义），
 *    只有拿不到时才回退解析 git 头。
 * 2. **大文件跳过**：`>1MB` 的文件给出 `skipped` + 中文提示，不解析内容，
 *    但仍如实报告状态；体积由调用方提供（`sizes`），避免在解析层读磁盘。
 */

export interface DiffParseOptions {
  /** 权威文件清单（`git diff --name-status -z`），按顺序与 patch 块一一对应 */
  entries?: readonly DiffFileEntry[] | undefined;
  /** 文件体积（字节），用于大文件判定；key 为变更后的路径 */
  sizes?: Readonly<Record<string, number | null>> | undefined;
  /** 大文件阈值，默认 1MB */
  skipThresholdBytes?: number | undefined;
}

export interface ParsedDiff {
  files: GitDiffFile[];
  additions: number;
  deletions: number;
  skippedFiles: number;
}

interface RawBlock {
  headerLines: string[];
  hunkLines: string[];
  /** 头部声明的路径（回退解析用） */
  headerPath: string | null;
  headerOldPath: string | null;
  headerStatus: FileStatus | null;
  binary: boolean;
}

export function parseUnifiedDiff(patch: string, options: DiffParseOptions = {}): ParsedDiff {
  const threshold = options.skipThresholdBytes ?? BIG_FILE_THRESHOLD_BYTES;
  const blocks = splitBlocks(patch);
  const files: GitDiffFile[] = [];
  let additions = 0;
  let deletions = 0;

  blocks.forEach((block, index) => {
    const authoritative = options.entries?.[index];
    const path = authoritative?.path ?? block.headerPath ?? `未命名文件-${index + 1}`;
    const oldPath = authoritative?.oldPath ?? block.headerOldPath;
    const status = authoritative?.status ?? block.headerStatus ?? 'modified';
    const size = options.sizes?.[path] ?? null;

    const file: GitDiffFile = {
      path,
      oldPath,
      status,
      binary: block.binary,
      skipped: false,
      skipReason: null,
      additions: 0,
      deletions: 0,
      size,
      hunks: [],
    };

    if (block.binary) {
      file.skipped = true;
      file.skipReason = '二进制文件，不展示内容差异';
      files.push(file);
      return;
    }

    if (size !== null && size > threshold) {
      file.skipped = true;
      file.skipReason = `文件体积 ${formatBytes(size)}，超过 ${formatBytes(threshold)} 上限，已跳过内容差异`;
      files.push(file);
      return;
    }

    const hunks = parseHunks(block.hunkLines);
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'add') file.additions += 1;
        else if (line.kind === 'del') file.deletions += 1;
      }
    }
    file.hunks = hunks;
    additions += file.additions;
    deletions += file.deletions;
    files.push(file);
  });

  return {
    files,
    additions,
    deletions,
    skippedFiles: files.filter((file) => file.skipped).length,
  };
}

/* -------------------------------------------------------------------------- */
/* 解析：patch → 块 → hunk → 行                                                */
/* -------------------------------------------------------------------------- */

function splitBlocks(patch: string): RawBlock[] {
  const lines = patch.split(/\r?\n/);
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current !== null) blocks.push(current);
      const header = parseGitHeader(line);
      current = {
        headerLines: [],
        hunkLines: [],
        headerPath: header.path,
        headerOldPath: header.oldPath,
        headerStatus: null,
        binary: false,
      };
      continue;
    }
    if (current === null) continue;

    if (line.startsWith('@@')) {
      current.hunkLines.push(line);
      continue;
    }
    if (current.hunkLines.length > 0) {
      current.hunkLines.push(line);
      continue;
    }
    current.headerLines.push(line);
    if (line.startsWith('new file mode')) current.headerStatus = 'added';
    else if (line.startsWith('deleted file mode')) current.headerStatus = 'deleted';
    else if (line.startsWith('rename from ')) {
      current.headerOldPath = line.slice('rename from '.length).trim();
      current.headerStatus = 'renamed';
    } else if (line.startsWith('rename to ')) {
      current.headerPath = line.slice('rename to '.length).trim();
      current.headerStatus = 'renamed';
    } else if (line.startsWith('copy from ')) {
      current.headerOldPath = line.slice('copy from '.length).trim();
      current.headerStatus = 'copied';
    } else if (line.startsWith('copy to ')) {
      current.headerPath = line.slice('copy to '.length).trim();
      current.headerStatus = 'copied';
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true;
    } else if (line.startsWith('--- ')) {
      const from = line.slice(4).replace(/\t.*$/, '').trim();
      if (from === '/dev/null') current.headerStatus = 'added';
    } else if (line.startsWith('+++ ')) {
      const to = line.slice(4).replace(/\t.*$/, '').trim();
      if (to === '/dev/null') current.headerStatus = 'deleted';
      else current.headerPath = stripPrefix(to);
    }
  }
  if (current !== null) blocks.push(current);
  return blocks;
}

/** 从 `diff --git a/x b/y` 里尽力取路径（有歧义时以 rename/---/+++ 行为准） */
function parseGitHeader(line: string): { path: string | null; oldPath: string | null } {
  const rest = line.slice('diff --git '.length).trim();
  const match = /^a\/(.*?) b\/(.*)$/.exec(rest);
  if (match === null) return { path: null, oldPath: null };
  return { path: match[2] ?? null, oldPath: match[1] ?? null };
}

function stripPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

export function parseHunks(lines: readonly string[]): GitDiffHunk[] {
  const hunks: GitDiffHunk[] = [];
  let current: GitDiffHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const header = parseHunkHeader(line);
      oldNumber = header.oldStart;
      newNumber = header.newStart;
      current = {
        index: hunks.length + 1,
        header: header.raw,
        oldStart: header.oldStart,
        oldLines: header.oldLines,
        newStart: header.newStart,
        newLines: header.newLines,
        section: header.section,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === null) continue;
    // `\ No newline at end of file` 这类元信息行不占行号
    if (line.startsWith('\\')) {
      current.lines.push({ kind: 'meta', text: line, oldNumber: null, newNumber: null });
      continue;
    }
    const kind: DiffLineKind = line.startsWith('+')
      ? 'add'
      : line.startsWith('-')
        ? 'del'
        : 'context';
    const text = line.length > 0 ? line.slice(1) : '';
    if (kind === 'add') {
      current.lines.push({ kind, text, oldNumber: null, newNumber });
      newNumber += 1;
    } else if (kind === 'del') {
      current.lines.push({ kind, text, oldNumber, newNumber: null });
      oldNumber += 1;
    } else {
      current.lines.push({ kind, text, oldNumber, newNumber });
      oldNumber += 1;
      newNumber += 1;
    }
  }
  return hunks;
}

export interface HunkHeader {
  raw: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string | null;
}

export function parseHunkHeader(line: string): HunkHeader {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  if (match === null) {
    return { raw: line, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, section: null };
  }
  const section = (match[5] ?? '').trim();
  return {
    raw: line,
    oldStart: Number.parseInt(match[1] ?? '0', 10),
    oldLines: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3] ?? '0', 10),
    newLines: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
    section: section.length > 0 ? section : null,
  };
}

/* -------------------------------------------------------------------------- */
/* 渲染模型                                                                    */
/* -------------------------------------------------------------------------- */

/** 折叠标记（未修改区域） */
export interface UnchangedFold {
  kind: 'fold';
  count: number;
}

export type DiffViewCell = { number: number; text: string };

/**
 * hunk → 并排渲染行。
 * 连续的删除 / 新增会被配成 `replace`（左右对齐），数量不等时多出来的一侧为 `null`，
 * 这样左右行号严格对齐，满足「行号对齐」的验收要求。
 */
export function alignHunk(hunk: GitDiffHunk): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  const lines = hunk.lines;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;

    if (line.kind === 'context') {
      rows.push({
        kind: 'context',
        left: line.oldNumber === null ? null : { number: line.oldNumber, text: line.text },
        right: line.newNumber === null ? null : { number: line.newNumber, text: line.text },
      });
      index += 1;
      continue;
    }
    if (line.kind === 'meta') {
      index += 1;
      continue;
    }

    const dels: GitDiffLine[] = [];
    const adds: GitDiffLine[] = [];
    while (index < lines.length) {
      const next = lines[index];
      if (next === undefined || (next.kind !== 'del' && next.kind !== 'add')) break;
      if (next.kind === 'del') dels.push(next);
      else adds.push(next);
      index += 1;
    }

    const pairCount = Math.max(dels.length, adds.length);
    for (let pair = 0; pair < pairCount; pair += 1) {
      const left = dels[pair];
      const right = adds[pair];
      rows.push({
        kind:
          left !== undefined && right !== undefined
            ? 'replace'
            : left !== undefined
              ? 'del'
              : 'add',
        left: left === undefined ? null : { number: left.oldNumber ?? 0, text: left.text },
        right: right === undefined ? null : { number: right.newNumber ?? 0, text: right.text },
      });
    }
  }
  return rows;
}

/**
 * 折叠未修改区域：连续 `context` 行超过 `2 * context + 1` 时，
 * 保留两端各 `context` 行、中间折成一条 `count` 提示。
 */
export function foldAlignedRows(
  rows: readonly SideBySideRow[],
  context = 3,
): (SideBySideRow | UnchangedFold)[] {
  const output: (SideBySideRow | UnchangedFold)[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (row === undefined) break;
    if (row.kind !== 'context') {
      output.push(row);
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end]?.kind === 'context') end += 1;
    const runLength = end - index;
    if (runLength <= context * 2 + 1) {
      for (let cursor = index; cursor < end; cursor += 1) {
        const inner = rows[cursor];
        if (inner !== undefined) output.push(inner);
      }
    } else {
      for (let cursor = index; cursor < index + context; cursor += 1) {
        const inner = rows[cursor];
        if (inner !== undefined) output.push(inner);
      }
      output.push({ kind: 'fold', count: runLength - context * 2 });
      for (let cursor = end - context; cursor < end; cursor += 1) {
        const inner = rows[cursor];
        if (inner !== undefined) output.push(inner);
      }
    }
    index = end;
  }
  return output;
}

/** 行前缀符号（内联渲染用） */
export function diffLineSign(kind: DiffLineKind): string {
  if (kind === 'add') return '+';
  if (kind === 'del') return '-';
  if (kind === 'meta') return '\\';
  return ' ';
}

/** 差异体积摘要文案（无差异时给"无内容变更"而不是"0 行"） */
export function summarizeDiff(parsed: ParsedDiff): string {
  if (parsed.files.length === 0) return '没有文件变更';
  const skipped = parsed.skippedFiles > 0 ? `，其中 ${parsed.skippedFiles} 个文件跳过内容对比` : '';
  return `${parsed.files.length} 个文件，+${parsed.additions} / -${parsed.deletions}${skipped}`;
}

/** 按扩展名推断语法高亮语言（渲染层据此选择高亮器；未知类型返回 plaintext） */
export function languageFromPath(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'json':
      return 'json';
    case 'sql':
      return 'sql';
    case 'md':
      return 'markdown';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'java':
      return 'java';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'ets':
    case 'ts_arkts':
      return 'arkts';
    case 'dart':
      return 'dart';
    case 'yml':
    case 'yaml':
      return 'yaml';
    default:
      return 'plaintext';
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** hunk 级勾选：把选中的 hunk 组装成可提交的 patch（T6-02 验收「hunk 级勾选提交生效」） */
export function buildHunkPatch(file: GitDiffFile, hunkIndexes: readonly number[]): string {
  const selected = file.hunks.filter((hunk) => hunkIndexes.includes(hunk.index));
  if (selected.length === 0) return '';
  const from = file.oldPath ?? file.path;
  const lines: string[] = [`diff --git a/${from} b/${file.path}`];
  if (file.status === 'added') lines.push('new file mode 100644');
  if (file.status === 'deleted') lines.push('deleted file mode 100644');
  if (file.status === 'renamed') {
    lines.push(`rename from ${from}`);
    lines.push(`rename to ${file.path}`);
  }
  lines.push(`--- ${file.status === 'added' ? '/dev/null' : `a/${from}`}`);
  lines.push(`+++ ${file.status === 'deleted' ? '/dev/null' : `b/${file.path}`}`);
  for (const hunk of selected) {
    lines.push(hunk.header);
    for (const line of hunk.lines) {
      lines.push(`${diffLineSign(line.kind)}${line.text}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
