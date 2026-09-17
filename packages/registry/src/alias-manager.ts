/**
 * 别名与兼容期（T7-05 要点 3，FR-UNI-10）。
 *
 * 改名后可**可选地**为旧名生成兼容层，三类别名各自产出真实可落地的产物：
 * - `code`：代码 alias 导出（`export { 新 as 旧 }` + 变量别名常量）；
 * - `api`：API / DTO 旧字段兼容（保留旧字段并在映射层填值）；
 * - `i18n`：i18n 旧 key 回退（旧 key → 新 key 的映射条目）。
 *
 * 每项都带 `deprecatedAt`（停止维护）与 `cleanupDueAt`（清理期限），
 * 项目中以"待清理"清单呈现，支持一键清理（FR-UNI-10 验收要点）。
 *
 * 本模块只**产出内容与清单**；落盘由外壳（文件写入端口）完成，符合 D-04。
 */

import {
  ALIAS_KINDS,
  isCleanupDue,
  type AliasEntry,
  type AliasKind,
  type RegistryEntry,
} from './registry-model';
import type { ProjectionSet } from './registry-model';

/** 别名生命周期状态 */
export const ALIAS_STATUSES = ['active', 'due', 'cleaned'] as const;
export type AliasStatus = (typeof ALIAS_STATUSES)[number];

/** 别名类别中文标签 */
export const ALIAS_KIND_LABELS: Readonly<Record<AliasKind, string>> = {
  code: '代码 alias 导出',
  api: 'API 旧字段兼容',
  i18n: 'i18n 旧 key 回退',
};

/** 生成兼容层的输入 */
export interface AliasPlanInput {
  kind: AliasKind;
  oldName: string;
  newName: string;
  /** 改名前的八类投影 */
  before: ProjectionSet;
  /** 改名后的八类投影 */
  after: ProjectionSet;
  /** 清理期限（毫秒时间戳）；null 表示长期保留 */
  cleanupDueAt: number | null;
  now: number;
}

/** 一个兼容产物（可由外壳写入 refPath） */
export interface AliasArtifact {
  kind: AliasKind;
  /** 目标文件路径（相对项目根） */
  refPath: string;
  content: string;
  description: string;
}

/** 兼容期说明（写进注释，便于日后清理） */
export function compatNote(input: Pick<AliasPlanInput, 'oldName' | 'newName' | 'cleanupDueAt'>): string {
  const due = input.cleanupDueAt === null ? '长期保留' : `清理期限 ${new Date(input.cleanupDueAt).toISOString().slice(0, 10)}`;
  return `兼容期别名：「${input.oldName}」→「${input.newName}」（${due}）；由 EveryoneCoding 重命名引擎生成（FR-UNI-10）`;
}

/** 生成三类别名的兼容产物 */
export function buildAliasArtifacts(input: AliasPlanInput): AliasArtifact[] {
  const note = compatNote(input);
  const artifacts: AliasArtifact[] = [];

  if (input.kind === 'code') {
    const oldComponent = input.before.component;
    const newComponent = input.after.component;
    const oldVariable = input.before.variable;
    const newVariable = input.after.variable;
    artifacts.push({
      kind: 'code',
      refPath: `src/compat/${newVariable}.compat.ts`,
      content: [
        `/* ${note} */`,
        `/* 禁止手动编辑：兼容层的增删改一律由 AI 通过重命名 / 清理流程生成（D-04） */`,
        '',
        `export { ${newComponent} as ${oldComponent} } from '../${newVariable}';`,
        `export const ${oldVariable} = ${newVariable};`,
        '',
      ].join('\n'),
      description: `代码 alias 导出：${oldComponent} → ${newComponent}`,
    });
  }

  if (input.kind === 'api') {
    const oldField = input.before.apiField;
    const newField = input.after.apiField;
    artifacts.push({
      kind: 'api',
      refPath: `src/compat/${input.after.methodName}.compat.ts`,
      content: [
        `/* ${note} */`,
        '/* 旧字段保留一个版本：写入时同时填充新旧字段，读取时优先新字段 */',
        '',
        `export interface LegacyPayload {`,
        `  /* @deprecated 请改用 ${newField} */`,
        `  ${oldField}: string;`,
        `  ${newField}: string;`,
        `}`,
        '',
        `export function toLegacyPayload(value: { ${newField}: string }): LegacyPayload {`,
        `  return { ${newField}: value.${newField}, ${oldField}: value.${newField} };`,
        `}`,
        '',
      ].join('\n'),
      description: `API 旧字段兼容：${oldField} ← ${newField}`,
    });
  }

  if (input.kind === 'i18n') {
    const oldKey = input.before.i18nKey;
    const newKey = input.after.i18nKey;
    artifacts.push({
      kind: 'i18n',
      refPath: 'i18n/compat.json',
      content: [
        '{',
        `  "_comment": ${JSON.stringify(note)},`,
        `  "${oldKey}": "${newKey}"`,
        '}',
        '',
      ].join('\n'),
      description: `i18n 旧 key 回退：${oldKey} → ${newKey}`,
    });
  }

  return artifacts;
}

/** 生成别名条目（写进注册表项的 aliases） */
export function createAliasEntry(
  input: Pick<AliasPlanInput, 'kind' | 'oldName' | 'cleanupDueAt' | 'now'> & { deprecatedAt?: number | null },
): AliasEntry {
  return {
    name: input.oldName,
    kind: input.kind,
    createdAt: input.now,
    deprecatedAt: input.deprecatedAt ?? null,
    cleanupDueAt: input.cleanupDueAt,
    note: null,
  };
}

/** 标记别名为"已废弃"（停止维护，进入清理倒计时） */
export function deprecateAlias(alias: AliasEntry, at: number, cleanupDueAt: number | null = null): AliasEntry {
  return { ...alias, deprecatedAt: at, cleanupDueAt: cleanupDueAt ?? alias.cleanupDueAt };
}

/** 别名状态：未废弃 = active；已过清理期限 = due；已清理 = cleaned */
export function aliasStatus(alias: AliasEntry, now: number, cleaned?: ReadonlySet<string>): AliasStatus {
  if (cleaned?.has(`${alias.kind}|${alias.name}`) === true) return 'cleaned';
  return isCleanupDue(alias, now) ? 'due' : 'active';
}

/** "待清理"清单条目 */
export interface PendingCleanupItem {
  registryId: string;
  /** 当前规范名（UI 展示） */
  entityName: string;
  alias: AliasEntry;
  status: AliasStatus;
  /** 距清理期限剩余天数（已过期返回负数；无期限返回 null） */
  daysLeft: number | null;
}

/**
 * 汇总"待清理"清单（FR-UNI-10）。
 *
 * 只统计**当前项目**的注册表项（D-07），并按"最早到期在前"排序，便于用户顺手清理。
 */
export function pendingCleanup(
  entries: readonly RegistryEntry[],
  now: number,
  cleaned?: ReadonlySet<string>,
): PendingCleanupItem[] {
  const items: PendingCleanupItem[] = [];
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const status = aliasStatus(alias, now, cleaned);
      if (status === 'cleaned') continue;
      items.push({
        registryId: entry.id,
        entityName: entry.canonicalName,
        alias,
        status,
        daysLeft:
          alias.cleanupDueAt === null
            ? null
            : Math.ceil((alias.cleanupDueAt - now) / (24 * 60 * 60 * 1000)),
      });
    }
  }
  return items.sort((a, b) => {
    if (a.alias.cleanupDueAt === null) return 1;
    if (b.alias.cleanupDueAt === null) return -1;
    return a.alias.cleanupDueAt - b.alias.cleanupDueAt;
  });
}

export interface CleanupResult {
  entries: RegistryEntry[];
  cleaned: AliasEntry[];
  cleanedKeys: string[];
}

/**
 * 一键清理（FR-UNI-10）：从注册表项里移除指定别名。
 *
 * 返回新的注册表项数组（不可变），清理动作由外壳在事务里落库；
 * 因每次重命名都生成独立 Git 提交，本轮清理同样可追溯（T7-04 的事件机制）。
 */
export function cleanAliases(
  entries: readonly RegistryEntry[],
  targets: readonly { registryId: string; kind: AliasKind; name: string }[],
  now: number,
): CleanupResult {
  const wanted = new Set(targets.map((item) => `${item.registryId}|${item.kind}|${item.name}`));
  const cleaned: AliasEntry[] = [];
  const cleanedKeys: string[] = [];
  const next = entries.map((entry) => {
    const keep: AliasEntry[] = [];
    for (const alias of entry.aliases) {
      const key = `${entry.id}|${alias.kind}|${alias.name}`;
      if (wanted.has(key)) {
        cleaned.push(alias);
        cleanedKeys.push(`${alias.kind}|${alias.name}`);
        continue;
      }
      keep.push(alias);
    }
    return keep.length === entry.aliases.length ? entry : { ...entry, aliases: keep, updatedAt: now };
  });
  return { entries: next, cleaned, cleanedKeys };
}

/** 别名类别全集（UI 的 checkbox 组） */
export function aliasKinds(): readonly AliasKind[] {
  return ALIAS_KINDS;
}
