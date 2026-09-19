import type { Database } from 'better-sqlite3';

/**
 * FTS5 扩展能力检测与关键词检索。
 *
 * 降级策略（NFR-S 不崩溃要求）：FTS5 不可用时退化为 LIKE 检索并给出告警，
 * 检索接口保持一致，调用方无需分支处理。
 */

export type SearchMode = 'fts5' | 'like';

export interface KeywordHit {
  id: string;
  /** 归一化到 0–1，越大越相关 */
  score: number;
}

export interface KeywordSearchResult {
  hits: KeywordHit[];
  mode: SearchMode;
  /** 降级原因，正常为 null */
  degradedReason: string | null;
}

export interface KeywordSearchOptions {
  /** FTS5 虚表名 */
  ftsTable?: string;
  /** 退化模式下的源表与列 */
  sourceTable?: string;
  columns?: string[];
}

/** 检测 FTS5 是否可用（创建临时虚表探测，随后立即删除） */
export function detectFts5(db: Database): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.ec_fts5_probe USING fts5(probe_column)');
    db.exec('DROP TABLE IF EXISTS temp.ec_fts5_probe');
    return true;
  } catch {
    return false;
  }
}

/**
 * 关键词检索。
 * FTS5 可用时走 MATCH（bm25 排序，取负后归一化）；否则退化为 LIKE。
 */
export class KeywordSearch {
  readonly mode: SearchMode;
  readonly degradedReason: string | null;
  private readonly ftsTable: string;
  private readonly sourceTable: string;
  private readonly columns: string[];

  constructor(db: Database, options: KeywordSearchOptions = {}) {
    this.ftsTable = options.ftsTable ?? 'memory_item_fts';
    this.sourceTable = options.sourceTable ?? 'memory_item';
    this.columns = options.columns ?? ['title', 'content'];

    if (detectFts5(db)) {
      this.mode = 'fts5';
      this.degradedReason = null;
    } else {
      this.mode = 'like';
      this.degradedReason =
        '当前 SQLite 未编译 FTS5，关键词检索已退化为 LIKE（性能下降且不支持分词）';
    }
    this.db = db;
  }

  private readonly db: Database;

  search(query: string, limit = 50): KeywordSearchResult {
    const trimmed = query.trim();
    if (trimmed.length === 0)
      return { hits: [], mode: this.mode, degradedReason: this.degradedReason };

    if (this.mode === 'fts5') {
      // trigram 分词器要求查询串 ≥3 字符，短查询直接退化为 LIKE
      if (trimmed.length < 3) return this.searchLike(trimmed, limit);
      try {
        const rows = this.db
          .prepare(
            `SELECT id, bm25(${this.ftsTable}) AS rank FROM ${this.ftsTable}
             WHERE ${this.ftsTable} MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(trimmed, limit) as Array<{ id: string; rank: number }>;
        const hits = rows.map((row) => ({ id: row.id, score: normalizeRank(row.rank) }));
        return { hits, mode: 'fts5', degradedReason: this.degradedReason };
      } catch {
        return this.searchLike(trimmed, limit);
      }
    }
    return this.searchLike(trimmed, limit);
  }

  private searchLike(query: string, limit: number): KeywordSearchResult {
    const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const clause = this.columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ');
    const rows = this.db
      .prepare(`SELECT id FROM ${this.sourceTable} WHERE ${clause} LIMIT ?`)
      .all(...this.columns.map(() => like), limit) as Array<{ id: string }>;
    return {
      hits: rows.map((row) => ({ id: row.id, score: 0.5 })),
      mode: 'like',
      degradedReason: this.degradedReason,
    };
  }
}

/** bm25 返回负值，越小越相关；映射到 0–1 */
function normalizeRank(rank: number): number {
  if (!Number.isFinite(rank)) return 0;
  return Math.max(0, Math.min(1, 1 / (1 + Math.abs(rank))));
}
