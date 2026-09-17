/**
 * 统一标识注册表领域模型（T7-01 要点 1，FR-UNI-01 / PRD §6.2 `registry_entry`）。
 *
 * 每个可命名对象（元素 / 页面 / 功能）持有一条注册表项：
 * - **稳定 ID**（ULID，`entityId`）：所有引用关系的真正锚点，**永不变更**；
 * - **规范名**（`canonicalName`）：用户可见、可修改；
 * - **八类标识符投影**（`projections`）：由规范名按命名规则派生（见 `naming/rule-engine`）；
 * - **别名与废弃时间**、**命名规则 id**、**历史名数组**、**同步状态**。
 *
 * 说明：本文件中的 `RegistryEntryRecord` / `REGISTRY_ENTRY_COLUMNS` 是 PRD §6.2 与
 * `@ec/data` 迁移 `0001_init.sql` 的 `registry_entry` 表的**结构化镜像**（不 import
 * `@ec/data`，避免把 better-sqlite3 拖进浏览器构建）。`__tests__/schema-alignment.test.ts`
 * 会直接解析迁移 SQL 逐列比对，字段一旦漂移测试立刻红。
 */

import { z } from 'zod';

import { deriveProjections, validateProjectionFormat, type ProjectionFormatIssue } from './naming/rule-engine';
import type { ProjectionKind, ResolvedNamingRule } from './naming/presets';
import { newUlid } from './ids';

/* ------------------------------- 基础枚举 ------------------------------- */

/** 可命名对象的类型（FR-UNI-01） */
export const ENTITY_TYPES = ['element', 'page', 'feature'] as const;
export type RegistryEntityType = (typeof ENTITY_TYPES)[number];

/** 同步状态机（T7-01 要点 4） */
export const SYNC_STATES = ['synced', 'drift_detected', 'conflict'] as const;
export type SyncState = (typeof SYNC_STATES)[number];

/** 别名兼容类别（FR-UNI-10：代码 alias / API 旧字段 / i18n 旧 key） */
export const ALIAS_KINDS = ['code', 'api', 'i18n'] as const;
export type AliasKind = (typeof ALIAS_KINDS)[number];

/* ------------------------------- 八类投影 ------------------------------- */

/** 八类标识符投影（PRD §6.2 `projections_json`） */
export interface ProjectionSet {
  component: string;
  variable: string;
  cssClass: string;
  i18nKey: string;
  apiField: string;
  methodName: string;
  routeSegment: string;
  testName: string;
}

/* ------------------------------- zod 契约 ------------------------------- */

export const projectionSetSchema = z.object({
  component: z.string(),
  variable: z.string(),
  cssClass: z.string(),
  i18nKey: z.string(),
  apiField: z.string(),
  methodName: z.string(),
  routeSegment: z.string(),
  testName: z.string(),
});

export const nameHistoryEntrySchema = z.object({
  name: z.string(),
  at: z.number().int(),
  reason: z.string().nullable(),
});

export const aliasEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(ALIAS_KINDS),
  createdAt: z.number().int(),
  deprecatedAt: z.number().int().nullable(),
  cleanupDueAt: z.number().int().nullable(),
  note: z.string().nullable(),
});

export const registryEntrySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string(),
  canonicalName: z.string(),
  projections: projectionSetSchema,
  aliases: z.array(aliasEntrySchema),
  namingRuleId: z.string(),
  nameHistory: z.array(nameHistoryEntrySchema),
  syncState: z.enum(SYNC_STATES),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

/* ------------------------------- 领域对象 ------------------------------- */

/** 历史规范名条目 */
export interface NameHistoryEntry {
  name: string;
  at: number;
  /** 变更原因（如 `rename: A → B`） */
  reason: string | null;
}

/** 别名（兼容期旧名） */
export interface AliasEntry {
  name: string;
  kind: AliasKind;
  createdAt: number;
  /** 废弃（停止维护）时间；`null` 表示尚未废弃 */
  deprecatedAt: number | null;
  /** 清理期限；`null` 表示长期保留 */
  cleanupDueAt: number | null;
  note: string | null;
}

export interface RegistryEntry {
  id: string;
  projectId: string;
  entityType: RegistryEntityType;
  /** 稳定 ID（ULID），永不变更 */
  entityId: string;
  canonicalName: string;
  projections: ProjectionSet;
  aliases: AliasEntry[];
  namingRuleId: string;
  nameHistory: NameHistoryEntry[];
  syncState: SyncState;
  createdAt: number;
  updatedAt: number;
}

/* --------------------------- 存储行（结构化镜像） --------------------------- */

/** 镜像 `@ec/data` 的 `registry_entry` 表列（顺序与 DDL 一致） */
export interface RegistryEntryRecord {
  id: string;
  project_id: string;
  entity_type: RegistryEntityType;
  entity_id: string;
  canonical_name: string;
  projections_json: string | null;
  aliases_json: string | null;
  naming_rule_id: string | null;
  name_history_json: string | null;
  sync_state: SyncState;
  created_at: number;
  updated_at: number;
}

/** `registry_entry` 的列清单（与迁移 SQL 逐列比对，见 schema-alignment 测试） */
export const REGISTRY_ENTRY_COLUMNS: readonly (keyof RegistryEntryRecord)[] = [
  'id',
  'project_id',
  'entity_type',
  'entity_id',
  'canonical_name',
  'projections_json',
  'aliases_json',
  'naming_rule_id',
  'name_history_json',
  'sync_state',
  'created_at',
  'updated_at',
];

/* ------------------------------- 构造与转换 ------------------------------- */

export interface CreateRegistryEntryInput {
  projectId: string;
  entityType: RegistryEntityType;
  canonicalName: string;
  rule: ResolvedNamingRule;
  /** 稳定 ID；缺省时生成新的 ULID（仅在首次注册时省略） */
  entityId?: string | undefined;
  id?: string | undefined;
  scope?: string | undefined;
  /** 注入时钟，便于测试确定性 */
  now?: number | undefined;
  random?: (() => number) | undefined;
}

export interface CreateRegistryEntryResult {
  entry: RegistryEntry;
  warnings: readonly string[];
}

/**
 * 注册一个新对象：生成稳定 ID + 八类投影 + 初始历史名。
 *
 * `entityId` 与 `id` 分离：`entityId` 指向设计器中的元素 / 页面 / 功能（永不变更），
 * `id` 是注册表项自身的主键。
 */
export function createRegistryEntry(input: CreateRegistryEntryInput): CreateRegistryEntryResult {
  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random;
  const derived = deriveProjections(input.canonicalName, {
    entityType: input.entityType,
    rule: input.rule,
    scope: input.scope,
  });
  const entry: RegistryEntry = {
    id: input.id ?? newUlid(now, random),
    projectId: input.projectId,
    entityType: input.entityType,
    entityId: input.entityId ?? newUlid(now, random),
    canonicalName: input.canonicalName,
    projections: derived.projections,
    aliases: [],
    namingRuleId: input.rule.ruleId,
    nameHistory: [{ name: input.canonicalName, at: now, reason: null }],
    syncState: 'synced',
    createdAt: now,
    updatedAt: now,
  };
  return { entry, warnings: derived.warnings };
}

/**
 * 改名：重算八类投影、追加历史名、把旧名登记为可选别名。
 *
 * 纯函数——不触碰存储；调用方（`rename-transaction`）负责事务化落库。
 */
export function applyRename(input: {
  entry: RegistryEntry;
  newCanonicalName: string;
  rule: ResolvedNamingRule;
  scope?: string | undefined;
  now?: number | undefined;
  /** 是否把旧名登记为别名（FR-UNI-10） */
  alias?: { kind: AliasKind; cleanupDueAt?: number | null; note?: string | null } | undefined;
  reason?: string | undefined;
  /** 逐投影重算子集；缺省重算全部八类 */
  kinds?: readonly ProjectionKind[] | undefined;
}): RegistryEntry {
  const now = input.now ?? Date.now();
  const derived = deriveProjections(input.newCanonicalName, {
    entityType: input.entry.entityType,
    rule: input.rule,
    scope: input.scope,
  });
  const oldName = input.entry.canonicalName;
  const projections: ProjectionSet =
    input.kinds === undefined || input.kinds.length === 0
      ? derived.projections
      : { ...input.entry.projections, ...pickProjections(derived.projections, input.kinds) };

  const aliases =
    input.alias === undefined || oldName === input.newCanonicalName
      ? input.entry.aliases
      : upsertAlias(input.entry.aliases, {
          name: oldName,
          kind: input.alias.kind,
          createdAt: now,
          deprecatedAt: null,
          cleanupDueAt: input.alias.cleanupDueAt ?? null,
          note: input.alias.note ?? null,
        });

  return {
    ...input.entry,
    canonicalName: input.newCanonicalName,
    projections,
    aliases,
    namingRuleId: input.rule.ruleId,
    nameHistory: [
      ...input.entry.nameHistory,
      { name: input.newCanonicalName, at: now, reason: input.reason ?? `${oldName} → ${input.newCanonicalName}` },
    ],
    syncState: 'synced',
    updatedAt: now,
  };
}

function pickProjections(source: ProjectionSet, kinds: readonly ProjectionKind[]): Partial<ProjectionSet> {
  const out: Partial<ProjectionSet> = {};
  for (const kind of kinds) out[kind] = source[kind];
  return out;
}

/** 新增或替换同类别同名的别名（按 `kind` + `name` 去重） */
export function upsertAlias(aliases: readonly AliasEntry[], alias: AliasEntry): AliasEntry[] {
  const rest = aliases.filter((item) => !(item.kind === alias.kind && item.name === alias.name));
  return [...rest, alias];
}

/* ------------------------------- 同步状态 ------------------------------- */

/** 投影与代码中实际符号的一致性校验结果 */
export interface ProjectionDrift {
  kind: ProjectionKind;
  expected: string;
  actual: string | null;
  /** 实际符号出现在何处（`file:line:col`），未知时为 null */
  locator: string | null;
}

export interface ConsistencyReport {
  ok: boolean;
  state: SyncState;
  drift: readonly ProjectionDrift[];
  formatIssues: readonly ProjectionFormatIssue[];
}

/**
 * AI 生成后 / 外部改动后校验投影一致性（FR-UNI-01 验收要点）。
 *
 * - 有漂移 → `drift_detected`
 * - 格式违规或与符号表冲突 → `conflict`
 * - 全部一致 → `synced`
 */
export function validateProjections(input: {
  entry: RegistryEntry;
  rule: ResolvedNamingRule;
  /** 代码中实际观测到的符号（按投影类型给出；`null` 表示代码中未找到） */
  observed?: Partial<Record<ProjectionKind, { value: string; locator?: string | null } | null>> | undefined;
}): ConsistencyReport {
  const formatIssues = validateProjectionFormat(input.entry.projections, input.rule);
  const drift: ProjectionDrift[] = [];
  for (const [kind, observed] of Object.entries(input.observed ?? {}) as [
    ProjectionKind,
    { value: string; locator?: string | null } | null,
  ][]) {
    const expected = input.entry.projections[kind];
    const actual = observed?.value ?? null;
    if (actual !== expected) {
      drift.push({ kind, expected, actual, locator: observed?.locator ?? null });
    }
  }
  const state: SyncState = drift.length > 0 ? 'drift_detected' : formatIssues.length > 0 ? 'conflict' : 'synced';
  return { ok: state === 'synced', state, drift, formatIssues };
}

/* ------------------------------- 序列化 ------------------------------- */

/** 投影 → `projections_json`（稳定键序，便于 diff 与快照测试） */
export function serializeProjections(projections: ProjectionSet): string {
  return JSON.stringify(projections, Object.keys(projectionSetSchema.shape));
}

/** 解析 `projections_json`；损坏时返回 null（调用方置 `conflict`） */
export function parseProjections(raw: string | null): ProjectionSet | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed = projectionSetSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 领域对象 → 存储行 */
export function toRegistryRecord(entry: RegistryEntry): RegistryEntryRecord {
  return {
    id: entry.id,
    project_id: entry.projectId,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    canonical_name: entry.canonicalName,
    projections_json: serializeProjections(entry.projections),
    aliases_json: JSON.stringify(entry.aliases),
    naming_rule_id: entry.namingRuleId,
    name_history_json: JSON.stringify(entry.nameHistory),
    sync_state: entry.syncState,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}

/** 存储行 → 领域对象（投影损坏时置 `conflict` 并用空投影兜底） */
export function fromRegistryRecord(record: RegistryEntryRecord): RegistryEntry {
  const projections = parseProjections(record.projections_json);
  return {
    id: record.id,
    projectId: record.project_id,
    entityType: record.entity_type,
    entityId: record.entity_id,
    canonicalName: record.canonical_name,
    projections: projections ?? emptyProjections(),
    aliases: parseJsonArray(record.aliases_json, aliasEntrySchema),
    namingRuleId: record.naming_rule_id ?? 'web-default',
    nameHistory: parseJsonArray(record.name_history_json, nameHistoryEntrySchema),
    syncState: projections === null ? 'conflict' : record.sync_state,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function emptyProjections(): ProjectionSet {
  return {
    component: '',
    variable: '',
    cssClass: '',
    i18nKey: '',
    apiField: '',
    methodName: '',
    routeSegment: '',
    testName: '',
  };
}

function parseJsonArray<T>(raw: string | null, schema: z.ZodType<T>): T[] {
  if (raw === null || raw.length === 0) return [];
  try {
    const parsed = z.array(schema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** 别名是否已过清理期限（"待清理"清单的判据，FR-UNI-10） */
export function isCleanupDue(alias: AliasEntry, now: number): boolean {
  return alias.cleanupDueAt !== null && alias.cleanupDueAt <= now;
}
