import type { Database } from 'better-sqlite3';
import { nowMs } from './ids';

/**
 * 通用 Repository 基类。
 *
 * 提供：
 * - CRUD
 * - version 乐观锁（冲突抛 ConflictError）
 * - created_at / updated_at 自动维护
 *
 * 实现要点：构造时读取 `PRAGMA table_info` 判断列是否存在。
 * 并非所有表都有 version / deleted_at（如 project 表无 version），
 * Repository 必须自适应，而不是要求全部表统一补齐列。
 *
 * 泛型约束为 `Row`（Record<string, unknown>）：实现内部需按列名动态取值。
 * 业务侧的具体行类型（interface）请写成 `XxxRow & Row` 以满足约束。
 */

export type Row = Record<string, unknown>;

export class ConflictError extends Error {
  readonly table: string;
  readonly id: string;
  readonly expectedVersion?: number | undefined;

  constructor(table: string, id: string, expectedVersion?: number) {
    super(
      expectedVersion === undefined
        ? `表 ${table} 中记录 ${id} 更新失败`
        : `表 ${table} 中记录 ${id} 存在并发修改（期望版本 ${expectedVersion}），请刷新后重试`,
    );
    this.name = 'ConflictError';
    this.table = table;
    this.id = id;
    this.expectedVersion = expectedVersion;
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

export interface InsertOptions {
  /** 是否自动维护 created_at / updated_at（默认 true，列不存在时自动跳过） */
  timestamps?: boolean;
}

/** 把值转成 SQLite 参数（对象/数组序列化为 JSON 文本） */
function toParam(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

interface TableShape {
  columns: Set<string>;
  hasVersion: boolean;
  hasCreatedAt: boolean;
  hasUpdatedAt: boolean;
  hasDeletedAt: boolean;
}

export class Repository<T extends Row = Row> {
  private readonly shape: TableShape;

  constructor(
    protected readonly db: Database,
    readonly tableName: string,
  ) {
    this.shape = Repository.inspect(db, tableName);
  }

  /** 读取表结构，判断通用列是否存在 */
  private static inspect(db: Database, table: string): TableShape {
    const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    const columns = new Set(rows.map((row) => row.name));
    return {
      columns,
      hasVersion: columns.has('version'),
      hasCreatedAt: columns.has('created_at'),
      hasUpdatedAt: columns.has('updated_at'),
      hasDeletedAt: columns.has('deleted_at'),
    };
  }

  get supportsOptimisticLock(): boolean {
    return this.shape.hasVersion;
  }

  findById(id: string): T | null {
    const row = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`).get(id);
    return (row as T | undefined) ?? null;
  }

  /** 等值条件查询，支持 limit / offset 与排序 */
  findWhere(where: Partial<T> = {}, options: { limit?: number; offset?: number; orderBy?: string } = {}): T[] {
    const keys = Object.keys(where);
    const clause = keys.length ? ` WHERE ${keys.map((key) => `${key} = ?`).join(' AND ')}` : '';
    const order = options.orderBy ? ` ORDER BY ${options.orderBy}` : '';
    const limit = options.limit !== undefined ? ` LIMIT ${options.limit}` : '';
    const offset = options.offset !== undefined ? ` OFFSET ${options.offset}` : '';
    const sql = `SELECT * FROM ${this.tableName}${clause}${order}${limit}${offset}`;
    return this.db.prepare(sql).all(...keys.map((key) => toParam(where[key]))) as T[];
  }

  count(where: Partial<T> = {}): number {
    const keys = Object.keys(where);
    const clause = keys.length ? ` WHERE ${keys.map((key) => `${key} = ?`).join(' AND ')}` : '';
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM ${this.tableName}${clause}`)
      .get(...keys.map((key) => toParam(where[key]))) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  insert(row: T, options: InsertOptions = {}): T {
    const timestamps = options.timestamps ?? true;
    const now = nowMs();
    const payload: Row = { ...row };

    if (timestamps) {
      if (this.shape.hasCreatedAt && payload['created_at'] === undefined) payload['created_at'] = now;
      if (this.shape.hasUpdatedAt && payload['updated_at'] === undefined) payload['updated_at'] = now;
    }
    if (this.shape.hasVersion && payload['version'] === undefined) payload['version'] = 1;

    const columns = Object.keys(payload);
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
    this.db.prepare(sql).run(...columns.map((column) => toParam(payload[column])));
    return payload as T;
  }

  /**
   * 更新记录。
   * @param expectedVersion 传入则启用乐观锁：version 不匹配时抛 ConflictError
   */
  update(id: string, patch: Partial<T>, expectedVersion?: number): T | null {
    const current = this.findById(id);
    if (!current) return null;

    if (expectedVersion !== undefined && !this.shape.hasVersion) {
      throw new Error(`表 ${this.tableName} 缺少 version 列，无法使用乐观锁`);
    }

    const payload: Row = { ...patch };
    if (this.shape.hasUpdatedAt) payload['updated_at'] = nowMs();
    if (this.shape.hasVersion) {
      const currentVersion = typeof current['version'] === 'number' ? (current['version'] as number) : 0;
      payload['version'] = currentVersion + 1;
    }

    const sets = Object.keys(payload).map((column) => `${column} = ?`).join(', ');
    const params = Object.keys(payload).map((column) => toParam(payload[column]));

    let sql = `UPDATE ${this.tableName} SET ${sets} WHERE id = ?`;
    const args: unknown[] = [...params, id];
    if (expectedVersion !== undefined) {
      sql += ' AND version = ?';
      args.push(expectedVersion);
    }

    const info = this.db.prepare(sql).run(...args);
    if (info.changes === 0) {
      if (expectedVersion !== undefined) throw new ConflictError(this.tableName, id, expectedVersion);
      return null;
    }
    return this.findById(id);
  }

  /** 删除记录；soft 模式把 deleted_at 置为当前时间（表无 deleted_at 列时抛错） */
  remove(id: string, options: { soft?: boolean } = {}): boolean {
    if (options.soft) {
      if (!this.shape.hasDeletedAt) {
        throw new Error(`表 ${this.tableName} 缺少 deleted_at 列，无法软删除`);
      }
      const info = this.db
        .prepare(`UPDATE ${this.tableName} SET deleted_at = ?, updated_at = ? WHERE id = ?`)
        .run(nowMs(), nowMs(), id);
      return info.changes > 0;
    }
    const info = this.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`).run(id);
    return info.changes > 0;
  }
}
