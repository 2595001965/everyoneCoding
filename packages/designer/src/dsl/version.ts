import { normalizeActionKind, type ActionKindInput } from './types';

/**
 * DSL 版本与升级迁移（T3-01 要点 3）。
 *
 * 版本号写在 `*.dsl.json` 的**信封字段** `dslVersion` 上（`PageDsl` 本体不带版本号，
 * 避免领域对象被序列化细节污染）。加载时若文件版本低于当前版本，按顺序执行迁移；
 * 高于当前版本则拒绝加载（不静默降级，避免丢字段）。
 *
 * 历史：
 * - v1 原型：动作 kind 允许 `setState` / `toast` 等别名字面量；无 notes / anchors / apiDeps
 * - v2：补 notes / anchors / apiDeps 缺省；动作 kind 归一化为 5 类规范值
 * - v3：元素级响应式从 `breakpointStyles`（数字键）改为 `responsive`（断点字符串键）
 */

export const DSL_VERSION = 3;

/** 迁移函数：入参为上一版本的原始 JSON 对象，返回下一版本的原始 JSON 对象 */
export type DslMigration = (raw: Record<string, unknown>) => Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** v1 → v2：动作别名归一化 + 缺省字段补齐 */
const migrateV1ToV2: DslMigration = (raw) => {
  const next: Record<string, unknown> = { ...raw };
  next['apiDeps'] = asArray(raw['apiDeps']).filter(
    (item): item is string => typeof item === 'string',
  );
  next['notes'] = asArray(raw['notes']);
  next['anchors'] = isRecord(raw['anchors']) ? raw['anchors'] : {};
  next['state'] = asArray(raw['state']);
  next['events'] = asArray(raw['events']).map((event) => {
    if (!isRecord(event)) return event;
    const actions = asArray(event['actions']).map((action) => {
      if (!isRecord(action)) return action;
      const alias =
        typeof action['kind'] === 'string' ? (action['kind'] as ActionKindInput) : undefined;
      if (alias === undefined) return action;
      return { ...action, kind: normalizeActionKind(alias) };
    });
    return { ...event, actions };
  });
  return next;
};

/** v2 → v3：元素级响应式配置迁移到 `responsive` */
const migrateV2ToV3: DslMigration = (raw) => {
  const convertNode = (node: unknown): unknown => {
    if (!isRecord(node)) return node;
    const rest: Record<string, unknown> = { ...node };
    const legacy = rest['breakpointStyles'];
    if (isRecord(legacy)) {
      const responsive: Record<string, Record<string, unknown>> = {};
      for (const [breakpoint, value] of Object.entries(legacy)) {
        if (isRecord(value)) responsive[String(breakpoint)] = value;
      }
      const existing = isRecord(rest['responsive']) ? rest['responsive'] : {};
      rest['responsive'] = { ...responsive, ...existing };
    }
    delete rest['breakpointStyles'];
    if (Array.isArray(rest['children'])) {
      rest['children'] = rest['children'].map((child) => convertNode(child));
    }
    return rest;
  };
  return { ...raw, tree: convertNode(raw['tree']) };
};

/** 版本 N → N+1 的迁移表 */
export const DSL_MIGRATIONS: Readonly<Record<number, DslMigration>> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
};

export interface MigrationResult {
  /** 迁移后的原始对象（调用方再交给 zod 校验） */
  value: unknown;
  /** 文件里的原始版本（缺失时按 1 处理） */
  from: number;
  /** 目标版本 */
  to: number;
  /** 实际执行的迁移起点序列 */
  applied: number[];
}

export class DslVersionError extends Error {
  constructor(
    readonly fileVersion: number,
    readonly currentVersion: number,
  ) {
    super(`DSL 文件版本 ${fileVersion} 高于当前支持的 ${currentVersion}，请升级客户端后再打开`);
    this.name = 'DslVersionError';
  }
}

function readVersion(raw: unknown): number {
  if (
    isRecord(raw) &&
    typeof raw['dslVersion'] === 'number' &&
    Number.isFinite(raw['dslVersion'])
  ) {
    return Math.trunc(raw['dslVersion'] as number);
  }
  // v1 原型没有版本字段
  return 1;
}

export interface MigrateOptions {
  /** 文件声明的版本；缺省时从对象内的 dslVersion 推断，再缺省按 1 处理 */
  from?: number;
  /** 目标版本，默认当前版本 */
  to?: number;
}

/**
 * 把任意版本的原始 DSL 对象迁移到当前版本。
 * - 版本高于当前：抛 `DslVersionError`
 * - 版本低于当前：逐级迁移
 *
 * 注意：信封结构（`{ dslVersion, page }`）由 `serialize.ts` 拆开后再调用本函数，
 * 因此 `options.from` 用于显式传入信封声明的版本，避免"对象内没有版本字段 → 误判为 v1"。
 */
export function migrateDsl(
  raw: Record<string, unknown>,
  options: MigrateOptions = {},
): MigrationResult {
  const targetVersion = options.to ?? DSL_VERSION;
  const from = options.from ?? readVersion(raw);
  if (from > targetVersion) throw new DslVersionError(from, targetVersion);
  let current: Record<string, unknown> = raw;
  const applied: number[] = [];
  for (let version = from; version < targetVersion; version += 1) {
    const migration = DSL_MIGRATIONS[version];
    if (migration === undefined) continue;
    current = migration(current);
    applied.push(version);
  }
  return { value: { ...current, dslVersion: targetVersion }, from, to: targetVersion, applied };
}
