/**
 * @ec/data —— SQLite 存储层。
 *
 * 分层：
 * - `client`：连接单例（WAL / busy_timeout / foreign_keys）
 * - `migrator`：版本化迁移框架（up / down / status，事务化且幂等）
 * - `repository`：通用 CRUD + version 乐观锁
 * - `unit-of-work`：多 Repository 共享事务
 * - `ext`：FTS5 与 sqlite-vec 扩展检测与降级
 * - `schema`：全部表的 TS 类型与 zod 校验（T0-08）
 * - `seed`：开发用种子数据（T0-08）
 */

export * from './client';
export * from './migrator';
export * from './repository';
export * from './unit-of-work';
export * from './ids';
export * from './ext/fts5';
export * from './ext/sqlite-vec';
export * from './schema';
export * from './seed';
