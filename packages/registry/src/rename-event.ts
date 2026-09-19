/**
 * rename 事件（T7-04 要点 7，FR-UNI-12 / PRD §6.2 `rename_event`）。
 *
 * 一次重命名成功后产出一条事件：
 * - 完整变更集（`changeset_json`：五段执行结果 + 文件快照 + 投影前后对照）
 * - `scope`：**恒为 `project`**——D-07 决定了不存在跨项目重命名；
 * - `commit_sha`：对应的 Git 提交（`refactor(rename): A → B`）；
 * - `undone`：是否已撤销（一键撤销后置 1）。
 *
 * 表结构镜像 `@ec/data` 迁移 `0001_init.sql` 的 `rename_event`（逐列比对见测试）。
 */

import { z } from 'zod';

import type { ProjectionSet, RegistryEntry } from './registry-model';
import type { ExecutorStateSnapshot, FileSnapshot, UndoPatch } from './executors/types';
import type { OccurrenceKind } from './occurrence/types';
import type { ProjectionKind } from './naming/presets';
import { newUlid } from './ids';

/** 作用范围（D-07：永远只有 `project`；`cross_project` 仅保留给历史数据兼容） */
export const RENAME_SCOPES = ['project', 'cross_project'] as const;
export type RenameScope = (typeof RENAME_SCOPES)[number];

/** 单段执行结果（写进变更集，供审计与历史查看） */
export interface ChangeSetSegment {
  executorId: string;
  column: OccurrenceKind;
  label: string;
  applied: number;
  skipped: number;
  failures: string[];
  warnings: string[];
  undo: UndoPatch[];
}

/** 完整变更集 */
export interface ChangeSet {
  registryId: string;
  projectId: string;
  oldName: string;
  newName: string;
  scope: RenameScope;
  createdAt: number;
  segments: ChangeSetSegment[];
  /** 文件 / 文档快照（含备份路径，跨会话撤销用） */
  snapshots: FileSnapshot[];
  /** 记忆 / DSL / 锚点的状态快照（同样 JSON 可序列化，撤销必需） */
  stateSnapshots: ExecutorStateSnapshot[];
  /** 投影前后对照 */
  projections: {
    before: ProjectionSet;
    after: ProjectionSet;
  };
  /** 注册表项前后快照（撤销时整体还原注册表，FR-UNI-12 的"注册表全部还原"） */
  registryBefore: RegistryEntry;
  registryAfter: RegistryEntry;
  /** 提交信息（Conventional Commits） */
  commitMessage: string;
}

export const changeSetSchema = z.object({
  registryId: z.string(),
  projectId: z.string(),
  oldName: z.string(),
  newName: z.string(),
  scope: z.enum(RENAME_SCOPES),
  createdAt: z.number().int(),
  segments: z.array(
    z.object({
      executorId: z.string(),
      column: z.enum(['code', 'doc', 'memory', 'logic']),
      label: z.string(),
      applied: z.number().int(),
      skipped: z.number().int(),
      failures: z.array(z.string()),
      warnings: z.array(z.string()),
      undo: z.array(
        z.object({
          column: z.enum(['code', 'doc', 'memory', 'logic']),
          refPath: z.string(),
          locator: z.string().nullable(),
          from: z.string(),
          to: z.string(),
          carrier: z.string().nullable(),
        }),
      ),
    }),
  ),
  snapshots: z.array(
    z.object({
      column: z.enum(['code', 'doc', 'memory', 'logic']),
      refPath: z.string(),
      before: z.string().nullable(),
      backupPath: z.string().nullable(),
    }),
  ),
  stateSnapshots: z.array(
    z.object({
      kind: z.enum(['memory', 'logic', 'anchor']),
      id: z.string(),
      payload: z.unknown(),
    }),
  ),
  projections: z.object({
    before: z.record(z.string(), z.string()),
    after: z.record(z.string(), z.string()),
  }),
  /* 注册表项整体用 unknown 承载：它本身是纯 JSON 结构，逐字段声明 zod 只会带来维护成本 */
  registryBefore: z.unknown(),
  registryAfter: z.unknown(),
  commitMessage: z.string(),
});

/** rename 事件领域对象 */
export interface RenameEvent {
  id: string;
  projectId: string;
  registryId: string;
  oldName: string;
  newName: string;
  changeset: ChangeSet | null;
  scope: RenameScope;
  commitSha: string | null;
  undone: boolean;
  createdAt: number;
}

/** 镜像 `@ec/data` 的 `rename_event` 表列（顺序与 DDL 一致） */
export interface RenameEventRecord {
  id: string;
  project_id: string;
  registry_id: string;
  old_name: string;
  new_name: string;
  changeset_json: string | null;
  scope: RenameScope;
  commit_sha: string | null;
  undone: number;
  created_at: number;
}

/** `rename_event` 的列清单（与迁移 SQL 逐列比对） */
export const RENAME_EVENT_COLUMNS: readonly (keyof RenameEventRecord)[] = [
  'id',
  'project_id',
  'registry_id',
  'old_name',
  'new_name',
  'changeset_json',
  'scope',
  'commit_sha',
  'undone',
  'created_at',
];

/** 提交信息：`refactor(rename): A → B`（PRD §15.2 ⑥） */
export function buildRenameCommitMessage(oldName: string, newName: string): string {
  return `refactor(rename): ${oldName} → ${newName}`;
}

/** 撤销时的提交信息 */
export function buildUndoCommitMessage(oldName: string, newName: string): string {
  return `revert(rename): ${newName} → ${oldName}`;
}

export interface CreateRenameEventInput {
  projectId: string;
  registryId: string;
  oldName: string;
  newName: string;
  changeset: ChangeSet | null;
  commitSha?: string | null | undefined;
  id?: string | undefined;
  now?: number | undefined;
  random?: (() => number) | undefined;
}

/** 构造事件（`scope` 恒为 `project`，D-07） */
export function createRenameEvent(input: CreateRenameEventInput): RenameEvent {
  const now = input.now ?? Date.now();
  return {
    id: input.id ?? newUlid(now, input.random ?? Math.random),
    projectId: input.projectId,
    registryId: input.registryId,
    oldName: input.oldName,
    newName: input.newName,
    changeset: input.changeset,
    scope: 'project',
    commitSha: input.commitSha ?? null,
    undone: false,
    createdAt: now,
  };
}

/** 序列化变更集 */
export function serializeChangeset(changeset: ChangeSet): string {
  return JSON.stringify(changeset);
}

/** 解析变更集（损坏返回 null，不影响"历史查看"降级展示） */
export function parseChangeset(raw: string | null): ChangeSet | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed = changeSetSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as unknown as ChangeSet) : null;
  } catch {
    return null;
  }
}

/** 领域对象 → 存储行 */
export function toRenameEventRecord(event: RenameEvent): RenameEventRecord {
  return {
    id: event.id,
    project_id: event.projectId,
    registry_id: event.registryId,
    old_name: event.oldName,
    new_name: event.newName,
    changeset_json: event.changeset === null ? null : serializeChangeset(event.changeset),
    scope: event.scope,
    commit_sha: event.commitSha,
    undone: event.undone ? 1 : 0,
    created_at: event.createdAt,
  };
}

/** 存储行 → 领域对象 */
export function fromRenameEventRecord(record: RenameEventRecord): RenameEvent {
  const changeset = parseChangeset(record.changeset_json);
  return {
    id: record.id,
    projectId: record.project_id,
    registryId: record.registry_id,
    oldName: record.old_name,
    newName: record.new_name,
    changeset,
    scope: record.scope,
    commitSha: record.commit_sha,
    undone: record.undone === 1,
    createdAt: record.created_at,
  };
}

/** 事件仓库（外壳绑定 SQLite；测试用内存实现） */
export interface RenameEventStore {
  append(event: RenameEvent): void;
  get(id: string): RenameEvent | null;
  /** 按项目列出（时间倒序，即"重命名历史"） */
  list(projectId: string): RenameEvent[];
  markUndone(id: string): RenameEvent | null;
  setCommitSha(id: string, commitSha: string): RenameEvent | null;
}

export function createInMemoryRenameEventStore(
  initial: readonly RenameEvent[] = [],
): RenameEventStore {
  const rows = new Map<string, RenameEvent>();
  for (const event of initial) rows.set(event.id, event);
  return {
    append(event) {
      rows.set(event.id, event);
    },
    get(id) {
      return rows.get(id) ?? null;
    },
    list(projectId) {
      return [...rows.values()]
        .filter((event) => event.projectId === projectId)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    markUndone(id) {
      const event = rows.get(id);
      if (event === undefined) return null;
      const next: RenameEvent = { ...event, undone: true };
      rows.set(id, next);
      return next;
    },
    setCommitSha(id, commitSha) {
      const event = rows.get(id);
      if (event === undefined) return null;
      const next: RenameEvent = { ...event, commitSha };
      rows.set(id, next);
      return next;
    },
  };
}

/** 历史列表条目（UI 展示用摘要） */
export interface RenameHistoryEntry {
  id: string;
  oldName: string;
  newName: string;
  at: number;
  commitSha: string | null;
  undone: boolean;
  changes: number;
  projections: { kind: ProjectionKind; oldValue: string; newValue: string }[];
}

/** 事件 → 历史摘要 */
export function toHistoryEntry(event: RenameEvent): RenameHistoryEntry {
  const segments = event.changeset?.segments ?? [];
  return {
    id: event.id,
    oldName: event.oldName,
    newName: event.newName,
    at: event.createdAt,
    commitSha: event.commitSha,
    undone: event.undone,
    changes: segments.reduce((sum, segment) => sum + segment.applied, 0),
    projections:
      event.changeset === null
        ? []
        : (Object.entries(event.changeset.projections.after) as [ProjectionKind, string][])
            .filter(([kind, value]) => event.changeset?.projections.before[kind] !== value)
            .map(([kind, value]) => ({
              kind,
              oldValue: event.changeset?.projections.before[kind] ?? '',
              newValue: value,
            })),
  };
}
