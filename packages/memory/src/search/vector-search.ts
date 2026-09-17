import type { Database } from 'better-sqlite3';
import { detectVec } from '@ec/data';
import { floatsToBlob } from './embedder';

/**
 * 向量检索（sqlite-vec / vec0）。
 *
 * 降级策略：扩展不可用（未编译 / 未加载 .so）时 `available = false`，
 * 所有读写静默忽略，语义检索整体关闭，**绝不抛错**。
 */

export interface VectorHitEx {
  id: string;
  /** vec0 返回的距离（cosine 距离，见 {@link ensureVecTable} 说明） */
  distance: number;
  /** 相似度：cosine 下 = 1 - distance，并 clamp 到 [0,1] */
  similarity: number;
}

export interface VecSearchOptions {
  table?: string;
  dimensions?: number;
}

/**
 * 幂等地创建 vec0 虚表。
 *
 * **为什么放在运行时而非迁移里？** 迁移 `0002_fts.sql` 刻意没有建 vec 表：
 * sqlite-vec 是可选的外部扩展，若迁移阶段执行 `CREATE VIRTUAL TABLE ... vec0(...)`
 * 而扩展缺失，整条迁移事务会回滚，导致连 FTS5 / 基础表都建不起来。
 * 因此 vec 表只能在运行时、确认 `detectVec` 判定扩展可用后才按需创建。
 *
 * 距离度量固定为 cosine：`distance_metric=cosine`。sqlite-vec 的 vec0 默认是 L2，
 * 而本检索的相似度换算依赖 `similarity = 1 - distance`，只有 cosine 距离（= 1 - 余弦相似度）
 * 才能让该式成立并落在 [0,1]。若调用方改用 L2，需相应调整 {@link toSimilarity}。
 *
 * @returns 扩展可用且建表成功返回 true；否则返回 false（不抛错）。
 */
export function ensureVecTable(
  db: Database,
  options: { table?: string; dimensions: number },
): boolean {
  const table = options.table ?? 'memory_item_vec';
  const status = detectVec(db, options.dimensions);
  if (!status.available) return false;
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[${options.dimensions}] distance_metric=cosine)`,
    );
    return true;
  } catch {
    // 建表失败（如 dimension 与已有表不一致）也按不可用处理，避免后续 KNN 抛错
    return false;
  }
}

/** cosine 距离 → 相似度，clamp 到 [0,1] */
function toSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(1, 1 - distance));
}

export class VecSearcher {
  readonly available: boolean;
  readonly reason: string | null;
  private readonly table: string;
  private readonly dimensions: number;
  private readonly db: Database;

  constructor(
    db: Database,
    options: VecSearchOptions = {},
  ) {
    this.db = db;
    this.table = options.table ?? 'memory_item_vec';
    this.dimensions = options.dimensions ?? 8;

    const status = detectVec(db, this.dimensions);
    this.available = status.available;
    this.reason = status.reason;

    // 可用且已知维度时，幂等建表，确保后续 upsert/search 不会因缺表而报错
    if (this.available && options.dimensions !== undefined) {
      ensureVecTable(db, { table: this.table, dimensions: options.dimensions });
    }
  }

  /** 写入 / 更新一条向量；不可用或维度不匹配时返回 false（不抛错） */
  upsert(id: string, vector: readonly number[]): boolean {
    if (!this.available) return false;
    if (vector.length !== this.dimensions) return false;
    try {
      this.db
        .prepare(`INSERT OR REPLACE INTO ${this.table} (id, embedding) VALUES (?, ?)`)
        .run(id, floatsToBlob(vector));
      return true;
    } catch {
      return false;
    }
  }

  /** 删除一条向量；不可用时静默忽略 */
  remove(id: string): void {
    if (!this.available) return;
    try {
      this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
    } catch {
      // 静默：删除失败不影响检索主流程
    }
  }

  search(vector: readonly number[], options: { limit?: number; filterIds?: readonly string[] } = {}): VectorHitEx[] {
    if (!this.available) return [];
    const limit = options.limit ?? 20;
    if (vector.length !== this.dimensions) return [];
    if (options.filterIds !== undefined && options.filterIds.length === 0) return [];

    const filterClause = this.buildFilterClause(options.filterIds);
    try {
      const rows = this.db
        .prepare(
          `SELECT id, distance FROM ${this.table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?${filterClause.sql}`,
        )
        .all(floatsToBlob(vector), limit, ...filterClause.params) as Array<{
        id: string;
        distance: number;
      }>;
      return rows.map((row) => ({
        id: row.id,
        distance: row.distance,
        similarity: toSimilarity(row.distance),
      }));
    } catch {
      return [];
    }
  }

  private buildFilterClause(filterIds: readonly string[] | undefined): { sql: string; params: unknown[] } {
    if (filterIds === undefined || filterIds.length === 0) return { sql: '', params: [] };
    const placeholders = filterIds.map(() => '?').join(', ');
    return { sql: ` AND id IN (${placeholders})`, params: [...filterIds] };
  }
}

/* 复用 embedder 的 BLOB 序列化，保证与 domain 的小端 Float32 约定一致 */