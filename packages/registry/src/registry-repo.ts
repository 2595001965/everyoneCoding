/**
 * 注册表仓库（T7-01 要点 1）。
 *
 * 分层：
 * - `RegistryRecordStore`：**行级**存储端口（纯 JSON 记录，不含 SQL）。外壳装配时用
 *   `@ec/data` 的 `Repository<RegistryEntryRow & Row>` 实现它；测试用内存实现。
 *   这样注册表包不必依赖 `@ec/data`（避免 better-sqlite3 进入浏览器构建）。
 * - `RegistryRepository`：**领域级**仓库（注册 / 查询 / 符号表 / 别名维护）。
 *
 * 符号表（`symbolTable`）是 FR-UNI-11 的检测基础：前端（组件 / 变量 / CSS / i18n / 路由 / 测试名）
 * 与后端（API 字段 / 方法名）由注册表自身投影汇总；数据库列名由外壳从项目 DDL 注入。
 */

import {
  fromRegistryRecord,
  toRegistryRecord,
  type RegistryEntry,
  type RegistryEntryRecord,
  type RegistryEntityType,
  type AliasEntry,
  type SyncState,
} from './registry-model';
import type { ResolvedSymbolTable } from './conflict-check';

/** 行级存储端口（外壳用 @ec/data 实现；注册表包不感知 SQLite） */
export interface RegistryRecordStore {
  upsert(record: RegistryEntryRecord): void;
  get(id: string): RegistryEntryRecord | null;
  listByProject(projectId: string): RegistryEntryRecord[];
  delete(id: string): void;
}

/** 领域级仓库 */
export interface RegistryRepository {
  /** 新建或整体覆盖一条注册表项 */
  save(entry: RegistryEntry): RegistryEntry;
  get(id: string): RegistryEntry | null;
  /** 按稳定 ID 定位（`entityId` 永不变更，是引用关系的锚点） */
  getByEntity(
    projectId: string,
    entityType: RegistryEntityType,
    entityId: string,
  ): RegistryEntry | null;
  getByCanonicalName(projectId: string, canonicalName: string): RegistryEntry | null;
  listByProject(projectId: string): RegistryEntry[];
  remove(id: string): boolean;
  /** 更新同步状态（AI 生成后 / 外部改动后被调用） */
  setSyncState(id: string, state: SyncState, now?: number): RegistryEntry | null;
  /** 维护别名清单（旧名 / 废弃时间 / 清理期限） */
  setAliases(id: string, aliases: readonly AliasEntry[], now?: number): RegistryEntry | null;
  /** 注入项目的数据库列名（用于 warn 级检测） */
  setDatabaseColumns(projectId: string, columns: readonly string[]): void;
  /** 汇总符号表（前端 / 后端 / 数据库） */
  symbolTable(projectId: string): ResolvedSymbolTable;
  /** 读取全部符号（前端 + 后端 + 数据库）用于批量冲突检测 */
  allSymbols(projectId: string): string[];
}

/** 内存行存储（测试与"未装配外壳"时的降级实现） */
export function createInMemoryRegistryStore(
  initial: readonly RegistryEntryRecord[] = [],
): RegistryRecordStore {
  const rows = new Map<string, RegistryEntryRecord>();
  for (const record of initial) rows.set(record.id, record);
  return {
    upsert(record) {
      rows.set(record.id, record);
    },
    get(id) {
      return rows.get(id) ?? null;
    },
    listByProject(projectId) {
      return [...rows.values()].filter((row) => row.project_id === projectId);
    },
    delete(id) {
      rows.delete(id);
    },
  };
}

/** 基于行存储构造领域仓库 */
export function createRegistryRepository(store: RegistryRecordStore): RegistryRepository {
  const databaseColumns = new Map<string, string[]>();

  const read = (id: string): RegistryEntry | null => {
    const record = store.get(id);
    return record === null ? null : fromRegistryRecord(record);
  };

  const write = (entry: RegistryEntry): RegistryEntry => {
    store.upsert(toRegistryRecord(entry));
    return entry;
  };

  return {
    save: write,
    get: read,
    getByEntity(projectId, entityType, entityId) {
      const record = store
        .listByProject(projectId)
        .find((row) => row.entity_type === entityType && row.entity_id === entityId);
      return record === undefined ? null : fromRegistryRecord(record);
    },
    getByCanonicalName(projectId, canonicalName) {
      const record = store
        .listByProject(projectId)
        .find((row) => row.canonical_name === canonicalName);
      return record === undefined ? null : fromRegistryRecord(record);
    },
    listByProject(projectId) {
      return store.listByProject(projectId).map(fromRegistryRecord);
    },
    remove(id) {
      if (store.get(id) === null) return false;
      store.delete(id);
      return true;
    },
    setSyncState(id, state, now = Date.now()) {
      const entry = read(id);
      if (entry === null) return null;
      return write({ ...entry, syncState: state, updatedAt: now });
    },
    setAliases(id, aliases, now = Date.now()) {
      const entry = read(id);
      if (entry === null) return null;
      return write({ ...entry, aliases: [...aliases], updatedAt: now });
    },
    setDatabaseColumns(projectId, columns) {
      databaseColumns.set(projectId, [...new Set(columns)]);
    },
    symbolTable(projectId) {
      const frontend = new Set<string>();
      const backend = new Set<string>();
      for (const entry of this.listByProject(projectId)) {
        const p = entry.projections;
        for (const value of [
          p.component,
          p.variable,
          p.cssClass,
          p.i18nKey,
          p.routeSegment,
          p.testName,
        ]) {
          if (value.length > 0) frontend.add(value);
        }
        for (const value of [p.apiField, p.methodName]) {
          if (value.length > 0) backend.add(value);
        }
      }
      return {
        frontend: [...frontend],
        backend: [...backend],
        database: [...(databaseColumns.get(projectId) ?? [])],
      };
    },
    allSymbols(projectId) {
      const table = this.symbolTable(projectId);
      return [...new Set([...table.frontend, ...table.backend, ...table.database])];
    },
  };
}

/** 一步到位的内存仓库（测试与降级用） */
export function createInMemoryRegistryRepository(
  initial: readonly RegistryEntryRecord[] = [],
): RegistryRepository {
  return createRegistryRepository(createInMemoryRegistryStore(initial));
}
