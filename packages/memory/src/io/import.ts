import type {
  MemoryItem,
  MemoryStatus,
  MemorySourceType,
  IssueStatus,
} from '../domain/memory-item';
import type { MemoryScope } from '../domain/scope';
import { parseExportJson } from './export-json';

/* ------------------------------ 错误类型 ------------------------------ */

/**
 * 导入过程错误：仅用于**整体格式不可用**的情况（单条坏数据只计入 `skipped`，不抛此错）。
 *
 * - `FORMAT`：`format` 字段不匹配，不是本系统导出的记忆包；
 * - `VERSION`：版本高于当前支持版本，无法安全解析；
 * - `PARSE`：顶层不是合法 JSON。
 */
export class MemoryImportError extends Error {
  readonly code: 'FORMAT' | 'VERSION' | 'PARSE';

  constructor(code: 'FORMAT' | 'VERSION' | 'PARSE', message: string) {
    super(message);
    this.name = 'MemoryImportError';
    this.code = code;
    Object.setPrototypeOf(this, MemoryImportError.prototype);
  }
}

/* ------------------------------ 来源与解析 ------------------------------ */

/** 导入来源：三种格式统一入口。 */
export type ImportSource =
  | { kind: 'json'; raw: string }
  | { kind: 'jsonl'; raw: string }
  | { kind: 'markdown'; files: readonly { path: string; content: string }[] };

/** 解析后的结果：成功条目 + 被跳过的文件/行及其原因（不抛错）。 */
export interface ParseResult {
  items: MemoryItem[];
  skipped: Array<{ path: string; reason: string }>;
}

/* ------------------------------ Markdown 解析 ------------------------------ */

/**
 * 解析自己导出的 Markdown 文件（front-matter + 正文 + structured 折叠块），往返无损。
 *
 * 返回 `{ items, skipped }`：无法解析的文件（缺 front-matter、缺必需字段等）
 * 计入 `skipped`，不影响其余文件。
 *
 * 注意：Markdown 导出只用 front-matter 携带了字段子集，往返时 `userId` 等缺失字段
 * 按"重建"处理（取导出值，缺失则为空/默认），因此本函数返回的对象不强制通过
 * 领域不变量校验——测试只比对 structured / tags / title / content / importance /
 * confidence / sourceRef 等往返关键字段即可。
 */
export function parseMarkdownFiles(
  files: readonly { path: string; content: string }[],
): ParseResult {
  const items: MemoryItem[] = [];
  const skipped: ParseResult['skipped'] = [];

  for (const file of files) {
    try {
      const item = parseMarkdownFile(file);
      if (item) items.push(item);
      else skipped.push({ path: file.path, reason: '缺少合法 front-matter 或必需字段' });
    } catch (error) {
      skipped.push({
        path: file.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { items, skipped };
}

function parseMarkdownFile(file: { path: string; content: string }): MemoryItem | null {
  const split = splitFrontMatter(file.content);
  if (!split) return null;
  const fm = parseFrontMatter(split.fm);

  if (typeof fm.id !== 'string' || fm.id.length === 0) return null;
  if (typeof fm.title !== 'string') return null;
  if (typeof fm.scope !== 'string') return null;
  if (typeof fm.updatedAt !== 'number') return null;

  const { body, structured } = extractBodyAndStructured(split.body);

  return {
    id: fm.id,
    userId: typeof fm.userId === 'string' ? fm.userId : '',
    scope: fm.scope as MemoryScope,
    projectId: asStringOrNull(fm.projectId),
    featureId: asStringOrNull(fm.featureId),
    pageId: asStringOrNull(fm.pageId),
    elementId: asStringOrNull(fm.elementId),
    issueId: asStringOrNull(fm.issueId),
    title: fm.title,
    content: body,
    structured,
    tags: Array.isArray(fm.tags) ? fm.tags.map((tag) => String(tag)) : [],
    sourceType: (typeof fm.sourceType === 'string' ? fm.sourceType : 'manual') as MemorySourceType,
    sourceRef: asStringOrNull(fm.source),
    confidence: typeof fm.confidence === 'number' ? fm.confidence : 1,
    importance: typeof fm.importance === 'number' ? fm.importance : 3,
    status: (typeof fm.status === 'string' ? fm.status : 'active') as MemoryStatus,
    issueStatus: fm.issueStatus == null ? null : (String(fm.issueStatus) as IssueStatus),
    pinned: fm.pinned === true,
    version: typeof fm.version === 'number' ? fm.version : 1,
    createdAt: typeof fm.createdAt === 'number' ? fm.createdAt : (fm.updatedAt as number),
    updatedAt: fm.updatedAt as number,
    embedding: null,
  };
}

function splitFrontMatter(content: string): { fm: string; body: string } | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const fm = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  return { fm, body };
}

function parseFrontMatter(fm: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of fm.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    out[key] = parseScalar(value);
  }
  return out;
}

/**
 * 解析 YAML 标量子集：
 * - `[...]` 视为 JSON 数组（tags）；
 * - `"..."` 双引号串直接 JSON.parse；
 * - `null` / `true` / `false` / 数字按类型返回；
 * - 其余按原样字符串返回（含冒号等特殊情况）。
 */
function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text.length === 0) return '';
  if (text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function extractBodyAndStructured(bodyRaw: string): {
  body: string;
  structured: Record<string, unknown> | null;
} {
  const markerIndex = bodyRaw.indexOf('<details><summary>structured</summary>');
  if (markerIndex === -1) {
    return { body: stripLeadingNewline(bodyRaw), structured: null };
  }
  let body = bodyRaw.slice(0, markerIndex);
  const after = bodyRaw.slice(markerIndex + '<details><summary>structured</summary>'.length);
  const jsonStart = after.indexOf('```json');
  const fenceEnd = jsonStart === -1 ? -1 : after.indexOf('```', jsonStart + 7);
  let structured: Record<string, unknown> | null = null;
  if (jsonStart !== -1 && fenceEnd !== -1) {
    const jsonText = after.slice(jsonStart + 7, fenceEnd).trim();
    try {
      const parsed: unknown = JSON.parse(jsonText);
      structured =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      structured = null;
    }
  }
  // 去掉正文与结构化块之间的分隔空行（导出时统一为两个换行）
  body = body.replace(/\n\n$/, '');
  return { body: stripLeadingNewline(body), structured };
}

function stripLeadingNewline(text: string): string {
  return text.startsWith('\n') ? text.slice(1) : text;
}

function asStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

/* ------------------------------ 差异分类 ------------------------------ */

export type ImportClassification = 'added' | 'conflicted' | 'unchanged' | 'missing';

/** 单条导入差异。 */
export interface ImportDiffItem {
  /** 导入条目（本地无同名时为该条目本身） */
  incoming: MemoryItem;
  /** 本地同 id 条目，无则为 null */
  local: MemoryItem | null;
  classification: ImportClassification;
}

/** 导入预览：差异清单 + 计数 + 本地独有条目。 */
export interface ImportPreview {
  items: ImportDiffItem[];
  counts: { added: number; conflicted: number; unchanged: number; missing: number };
  /** 本地存在但导出包中没有的条目 */
  missing: MemoryItem[];
}

/**
 * 比对导入条目与本地条目的差异。
 *
 * 比对口径为 **`id` + `updatedAt`**：
 * - 本地无同 id → `added`；
 * - 同 id 且 `updatedAt` 相同（且内容相同）→ `unchanged`；
 * - 同 id 且 `updatedAt` 不同（或内容不同）→ `conflicted`；
 * - 本地有但 incoming 没有的 id → 计入 `missing`。
 *
 * **默认不覆盖本地**：`conflicted` 需要用户逐条决策，本函数不写库。
 */
export function classifyImport(
  incoming: readonly MemoryItem[],
  local: readonly MemoryItem[],
): ImportPreview {
  const localById = new Map(local.map((item) => [item.id, item]));
  const incomingIds = new Set(incoming.map((item) => item.id));

  const items: ImportDiffItem[] = [];
  let added = 0;
  let conflicted = 0;
  let unchanged = 0;

  for (const item of incoming) {
    const localItem = localById.get(item.id) ?? null;
    let classification: ImportClassification;
    if (!localItem) {
      classification = 'added';
      added += 1;
    } else if (localItem.updatedAt === item.updatedAt && localItem.content === item.content) {
      classification = 'unchanged';
      unchanged += 1;
    } else {
      classification = 'conflicted';
      conflicted += 1;
    }
    items.push({ incoming: item, local: localItem, classification });
  }

  const missing = local.filter((item) => !incomingIds.has(item.id));
  return {
    items,
    counts: { added, conflicted, unchanged, missing: missing.length },
    missing,
  };
}

/* ------------------------------ 统一入口 ------------------------------ */

/**
 * 把三种来源统一解析为 `MemoryItem[]`。
 *
 * 单条坏数据只计入 `skipped`；只有**整体格式不可用**（如 JSON 顶层结构非法）
 * 才抛 `MemoryImportError`。
 */
export function readImport(source: ImportSource): ParseResult {
  switch (source.kind) {
    case 'json': {
      try {
        const envelope = parseExportJson(source.raw);
        return { items: envelope.items, skipped: [] };
      } catch (error) {
        if (error instanceof MemoryImportError) throw error;
        throw new MemoryImportError(
          'PARSE',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    case 'jsonl': {
      const items: MemoryItem[] = [];
      const skipped: ParseResult['skipped'] = [];
      const lines = source.raw.split('\n');
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        try {
          items.push(JSON.parse(trimmed) as MemoryItem);
        } catch (error) {
          skipped.push({
            path: `line:${index + 1}`,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      });
      return { items, skipped };
    }
    case 'markdown':
      return parseMarkdownFiles(source.files);
  }
}
