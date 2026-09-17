import type { Database } from 'better-sqlite3';

/**
 * sqlite-vec 扩展能力检测与向量检索。
 *
 * 降级策略：扩展不可用（未加载 / 未编译）时 `available = false`，
 * 所有检索返回空结果并给出明确原因，**绝不抛错**，语义检索自动关闭。
 */

export interface VectorHit {
  id: string;
  distance: number;
}

export interface VectorSearchOptions {
  /** vec0 虚表名 */
  table?: string;
  dimensions?: number;
}

export interface VectorIndexStatus {
  available: boolean;
  reason: string | null;
}

/** 检测 sqlite-vec（vec0）是否可用 */
export function detectVec(db: Database, dimensions = 8): VectorIndexStatus {
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS temp.ec_vec_probe USING vec0(probe_embedding float[${dimensions}])`,
    );
    db.exec('DROP TABLE IF EXISTS temp.ec_vec_probe');
    return { available: true, reason: null };
  } catch (error) {
    return {
      available: false,
      reason: `sqlite-vec 不可用，语义检索已关闭：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export class VectorIndex {
  readonly status: VectorIndexStatus;
  private readonly table: string;
  private readonly dimensions: number;

  constructor(
    private readonly db: Database,
    options: VectorSearchOptions = {},
  ) {
    this.table = options.table ?? 'memory_item_vec';
    this.dimensions = options.dimensions ?? 8;
    this.status = detectVec(db, this.dimensions);
  }

  get available(): boolean {
    return this.status.available;
  }

  /** 写入向量；不可用时静默忽略 */
  upsert(id: string, embedding: number[]): void {
    if (!this.status.available) return;
    if (embedding.length !== this.dimensions) {
      throw new RangeError(`向量维度应为 ${this.dimensions}，实际 ${embedding.length}`);
    }
    this.db
      .prepare(`INSERT OR REPLACE INTO ${this.table} (id, embedding) VALUES (?, ?)`)
      .run(id, Buffer.from(new Float32Array(embedding).buffer));
  }

  /** 近邻检索；不可用时返回空数组 */
  search(embedding: number[], limit = 10): VectorHit[] {
    if (!this.status.available) return [];
    const rows = this.db
      .prepare(
        `SELECT id, distance FROM ${this.table}
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(Buffer.from(new Float32Array(embedding).buffer), limit) as Array<{ id: string; distance: number }>;
    return rows.map((row) => ({ id: row.id, distance: row.distance }));
  }
}
