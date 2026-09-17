import type { Database } from 'better-sqlite3';
import { detectFts5 } from '@ec/data';

/**
 * 关键词检索（FTS5 + bigram LIKE 兜底）。
 *
 * 设计：优先用 FTS5 的 trigram 分词做 `MATCH` + `bm25()`（中文友好）；
 * 当 FTS5 扩展缺失、查询串 < 3 字符（trigram 限制）或 MATCH 抛错时，
 * 自动退化为「二元切分术语的 LIKE AND」检索。两种模式都返回 snippet 与命中区间，
 * 且**绝不抛错**——检索是可降级能力，任何异常都应让上层继续跑关键词/语义另一路。
 */

/* ------------------------------ 类型 ------------------------------ */

/** 命中区间（字符偏移，左闭右开），相对于 `Snippet.text` */
export interface SnippetRange {
  start: number;
  end: number;
}

export interface KeywordHitEx {
  id: string;
  /** 归一化到 0–1，越大越相关 */
  score: number;
  snippet: {
    text: string;
    ranges: SnippetRange[];
  };
}

export interface FtsKeywordSearchOptions {
  limit?: number;
  /** 只在给定候选 id 内检索（混合检索的候选集收敛） */
  filterIds?: readonly string[];
}

/* ------------------------------ 分词兜底 ------------------------------ */

const CJK_RUN =
  /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g;
const ASCII_RUN = /[A-Za-z0-9_]+/g;

function isCjkRun(token: string): boolean {
  // 仅看首字符即可：上面的正则已把 CJK 与 ASCII 切到不同捕获组
  return /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/.test(token.charAt(0));
}

/**
 * 简单分词兜底：把查询串切成「检索术语」数组。
 *
 * 这是「先用一个够用的分词器、允许后续替换更好的分词（如 jieba / 词表）」的落点，
 * 当前实现刻意保持零依赖、可解释：
 *
 * - 连续的 CJK（中文 / 日文 / 韩文）段做**二元切分（bigram）**：
 *   例如 `命名规范` → `['命名','名规','规范']`；2 字词 `命名` → `['命名']`；
 *   单字段（仅 1 个 CJK 字符）整体保留，避免 1-gram 噪声过大。
 * - ASCII 单词 / 数字整体保留（不切分）：`TypeScript` → `['TypeScript']`，`2024` → `['2024']`。
 *
 * 该输出同时服务于：
 * 1. FTS5 模式下生成 snippet 命中区间的「标靶」；
 * 2. LIKE 降级模式下作为 AND 连接的检索术语。
 */
export function segmentQuery(query: string): string[] {
  const terms: string[] = [];
  const pushRun = (token: string): void => {
    if (token.length === 0) return;
    if (isCjkRun(token)) {
      if (token.length === 1) {
        terms.push(token);
        return;
      }
      for (let i = 0; i < token.length - 1; i++) {
        terms.push(token.slice(i, i + 2));
      }
      return;
    }
    terms.push(token);
  };

  let rest = query;
  // 交替匹配 CJK / ASCII 连续段，剩余部分（标点、空白等）直接丢弃
  for (;;) {
    const cjk = CJK_RUN.exec(rest);
    const ascii = ASCII_RUN.exec(rest);
    if (!cjk && !ascii) break;
    // 取更靠前的匹配
    let match: RegExpExecArray;
    if (cjk && ascii) {
      match = cjk.index <= ascii.index ? cjk : ascii;
    } else if (cjk) {
      match = cjk;
    } else {
      match = ascii as RegExpExecArray;
    }
    pushRun(match[0]);
    rest = rest.slice(match.index + match[0].length);
    // 重置正则（exec 带 lastIndex，重新构造更稳妥）
    CJK_RUN.lastIndex = 0;
    ASCII_RUN.lastIndex = 0;
  }
  return terms;
}

/* ------------------------------ snippet ------------------------------ */

function makeSnippet(
  title: string,
  content: string,
  needles: readonly string[],
): { text: string; ranges: SnippetRange[] } {
  const source = content.length > 0 ? content : title;
  const active = needles.filter((needle) => needle.length > 0);

  if (active.length === 0 || source.length === 0) {
    const head = source.slice(0, 80);
    return { text: source.length > 80 ? `${head}…` : head, ranges: [] };
  }

  let firstStart = -1;
  let lastEnd = -1;
  const occurrences: Array<{ start: number; length: number }> = [];
  for (const needle of active) {
    let from = 0;
    for (;;) {
      const idx = source.indexOf(needle, from);
      if (idx === -1) break;
      occurrences.push({ start: idx, length: needle.length });
      if (firstStart === -1 || idx < firstStart) firstStart = idx;
      const end = idx + needle.length;
      if (end > lastEnd) lastEnd = end;
      from = idx + 1;
    }
  }

  if (firstStart === -1) {
    const head = source.slice(0, 80);
    return { text: source.length > 80 ? `${head}…` : head, ranges: [] };
  }

  const start = Math.max(0, firstStart - 30);
  const end = Math.min(source.length, lastEnd + 70);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  const snippetText = `${prefix}${source.slice(start, end)}${suffix}`;
  const offset = prefix.length - start;

  const ranges: SnippetRange[] = [];
  for (const occ of occurrences) {
    if (occ.start < start || occ.start + occ.length > end) continue;
    const s = occ.start + offset;
    ranges.push({ start: s, end: s + occ.length });
  }
  ranges.sort((a, b) => a.start - b.start);
  return { text: snippetText, ranges };
}

/* ------------------------------ FTS5 ------------------------------ */

/** bm25 返回负值（越小越相关），映射到 0–1 */
function normalizeRank(rank: number): number {
  if (!Number.isFinite(rank)) return 0;
  return Math.max(0, Math.min(1, 1 / (1 + Math.abs(rank))));
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (m) => `\\${m}`);
}

/** 把查询串包成 FTS5 短语，规避 MATCH 语法特殊字符（仍可能抛错，由调用方兜底到 LIKE） */
function toFtsMatch(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

/* ------------------------------ 检索器 ------------------------------ */

export class FtsKeywordSearcher {
  readonly mode: 'fts5' | 'like';
  readonly degradedReason: string | null;
  private readonly ftsTable: string;
  private readonly sourceTable: string;
  private readonly defaultLimit: number;
  private readonly db: Database;

  constructor(
    db: Database,
    options: { ftsTable?: string; sourceTable?: string; limit?: number } = {},
  ) {
    this.db = db;
    this.ftsTable = options.ftsTable ?? 'memory_item_fts';
    this.sourceTable = options.sourceTable ?? 'memory_item';
    this.defaultLimit = options.limit ?? 50;

    if (detectFts5(db)) {
      this.mode = 'fts5';
      this.degradedReason = null;
    } else {
      this.mode = 'like';
      this.degradedReason = '当前 SQLite 未编译 FTS5，关键词检索已退化为 bigram LIKE（性能下降且不支持分词）';
    }
  }

  search(query: string, options: FtsKeywordSearchOptions = {}): KeywordHitEx[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    // 候选集为空 → 直接返回，避免无意义的全表扫描
    if (options.filterIds !== undefined && options.filterIds.length === 0) return [];

    const limit = options.limit ?? this.defaultLimit;
    const needles = segmentQuery(trimmed);

    if (this.mode === 'fts5') {
      // trigram 分词器要求查询串 ≥3 字符，短查询直接退化为 LIKE
      if (trimmed.length < 3) return this.searchLike(trimmed, needles, limit, options.filterIds);
      try {
        return this.searchFts(trimmed, needles, limit, options.filterIds);
      } catch {
        return this.searchLike(trimmed, needles, limit, options.filterIds);
      }
    }
    return this.searchLike(trimmed, needles, limit, options.filterIds);
  }

  private searchFts(
    query: string,
    needles: readonly string[],
    limit: number,
    filterIds: readonly string[] | undefined,
  ): KeywordHitEx[] {
    const filterClause = this.buildFilterClause(filterIds);
    const rows = this.db
      .prepare(
        `SELECT id, title, content, bm25(${this.ftsTable}) AS rank
         FROM ${this.ftsTable}
         WHERE ${this.ftsTable} MATCH ?${filterClause.sql}
         ORDER BY rank LIMIT ?`,
      )
      .all(toFtsMatch(query), ...filterClause.params, limit) as Array<{
      id: string;
      title: string;
      content: string;
      rank: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      score: normalizeRank(row.rank),
      snippet: makeSnippet(row.title, row.content, needles),
    }));
  }

  private searchLike(
    query: string,
    needles: readonly string[],
    limit: number,
    filterIds: readonly string[] | undefined,
  ): KeywordHitEx[] {
    // bigram 术语的 AND 检索：每个术语在 title 或 content 命中即可
    const terms = needles.length > 0 ? needles : [query];
    const filters: string[] = [];
    const params: unknown[] = [];
    for (const term of terms) {
      const like = `%${escapeLike(term)}%`;
      filters.push(`(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`);
      params.push(like, like);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    const filterClause = this.buildFilterClause(filterIds);
    const rows = this.db
      .prepare(
        `SELECT id, title, content FROM ${this.sourceTable}${where}${filterClause.sql} LIMIT ?`,
      )
      .all(...params, ...filterClause.params, limit) as Array<{
      id: string;
      title: string;
      content: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      score: 0.5,
      snippet: makeSnippet(row.title, row.content, needles),
    }));
  }

  private buildFilterClause(filterIds: readonly string[] | undefined): { sql: string; params: unknown[] } {
    if (filterIds === undefined || filterIds.length === 0) return { sql: '', params: [] };
    const placeholders = filterIds.map(() => '?').join(', ');
    return { sql: ` AND id IN (${placeholders})`, params: [...filterIds] };
  }
}
