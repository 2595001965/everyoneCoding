import {
  clamp01,
  clampImportance,
  normalizeTitleKey,
  type IssueStatus,
  type MemoryItem,
} from './memory-item';
import { ownershipKeyOf, type MemoryOwnership } from './scope';

/**
 * 冲突检测与合并策略（FR-MEM-06 / FR-MEM-11）。
 *
 * 冲突判定口径（与 T2-01 提示词一致）：
 * - **同 title**（归一化后）：两条记忆在描述同一件事，后者应覆盖前者；
 * - **同 structured 键**：结构化数据在同一个叶子路径上给出不同值。
 *
 * 冲突解决三选项：`keepLocal`（保留本地）/ `takeNew`（采用新）/ `merge`（合并）。
 */

/* --------------------------- 冲突识别 --------------------------- */

export type ConflictKind = 'title' | 'structured';

export interface ConflictMatch {
  /** 全局唯一键：`title:<key>` 或 `structured:<path>` */
  key: string;
  /** 展示用字段名（structured 为点分路径） */
  field: string;
  kind: ConflictKind;
  /** 本条目在该键上的取值（用于 UI 对比卡） */
  localValue: unknown;
  /** 对方在该键上的取值 */
  incomingValue: unknown;
}

export function ownershipOf(item: MemoryItem): MemoryOwnership {
  return {
    project_id: item.projectId,
    feature_id: item.featureId,
    page_id: item.pageId,
    element_id: item.elementId,
    issue_id: item.issueId,
  };
}

/** 是否属于"同一个记忆槽位"：同 scope、同归属、同标题 */
export function isSameMemorySlot(a: MemoryItem, b: MemoryItem): boolean {
  return (
    a.scope === b.scope &&
    ownershipKeyOf(ownershipOf(a)) === ownershipKeyOf(ownershipOf(b)) &&
    normalizeTitleKey(a.title) === normalizeTitleKey(b.title)
  );
}

/** 把嵌套对象摊平成 路径 -> 叶子值 */
export function flattenStructured(
  value: unknown,
  prefix = '',
  out: Map<string, unknown> = new Map(),
): Map<string, unknown> {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flattenStructured(entry, `${prefix}[${index}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      flattenStructured(entry, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.set(prefix, value);
  return out;
}

/**
 * 检测两条记忆之间的冲突。
 * 返回空数组表示无冲突（可并存或视为互补）。
 */
export function detectConflicts(local: MemoryItem, incoming: MemoryItem): ConflictMatch[] {
  const conflicts: ConflictMatch[] = [];

  const localTitleKey = normalizeTitleKey(local.title);
  const incomingTitleKey = normalizeTitleKey(incoming.title);
  if (localTitleKey.length > 0 && localTitleKey === incomingTitleKey) {
    conflicts.push({
      key: `title:${localTitleKey}`,
      field: 'title',
      kind: 'title',
      localValue: local.title,
      incomingValue: incoming.title,
    });
  }

  const localLeaves = flattenStructured(local.structured);
  const incomingLeaves = flattenStructured(incoming.structured);
  for (const [path, incomingValue] of incomingLeaves) {
    if (!localLeaves.has(path)) continue;
    const localValue = localLeaves.get(path);
    if (isEqualValue(localValue, incomingValue)) continue;
    conflicts.push({
      key: `structured:${path}`,
      field: path,
      kind: 'structured',
      localValue,
      incomingValue,
    });
  }

  return conflicts;
}

export function hasConflict(local: MemoryItem, incoming: MemoryItem): boolean {
  return detectConflicts(local, incoming).length > 0;
}

function isEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/* --------------------------- 合并 --------------------------- */

export interface StructuredMergeResult {
  value: Record<string, unknown>;
  /** 被合并（写入了新值）的叶子路径 */
  mergedPaths: string[];
}

/**
 * 结构化数据深合并：
 * - 对象递归合并；
 * - 数组取并集（本地在前，新值去重后追加）；
 * - 标量以新值覆盖（新记忆代表用户最新意图）。
 */
export function deepMergeStructured(
  local: Record<string, unknown> | null,
  incoming: Record<string, unknown> | null,
): StructuredMergeResult {
  const mergedPaths: string[] = [];
  const value = mergeNode(local ?? {}, incoming ?? {}, '', mergedPaths);
  return { value: value as Record<string, unknown>, mergedPaths };
}

function mergeNode(local: unknown, incoming: unknown, path: string, mergedPaths: string[]): unknown {
  if (incoming === undefined) return local;
  if (local === undefined) {
    collectMergedPaths(incoming, path, mergedPaths);
    return incoming;
  }
  if (Array.isArray(local) || Array.isArray(incoming)) {
    const localArr = Array.isArray(local) ? local : [local];
    const incomingArr = Array.isArray(incoming) ? incoming : [incoming];
    const union = [...localArr];
    for (const entry of incomingArr) {
      if (!union.some((existing) => isEqualValue(existing, entry))) union.push(entry);
    }
    if (!isEqualValue(localArr, incomingArr)) mergedPaths.push(path || '(root)');
    return union;
  }
  if (isPlainObject(local) && isPlainObject(incoming)) {
    const result: Record<string, unknown> = { ...local };
    for (const [key, entry] of Object.entries(incoming)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = mergeNode((local as Record<string, unknown>)[key], entry, childPath, mergedPaths);
    }
    return result;
  }
  if (!isEqualValue(local, incoming)) mergedPaths.push(path || '(root)');
  return incoming;
}

function collectMergedPaths(value: unknown, path: string, out: string[]): void {
  const leaves = flattenStructured(value, path);
  for (const key of leaves.keys()) out.push(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 正文段拼接：本地在前；若一方已包含另一方则只保留更完整的一方 */
export function mergeContent(local: string, incoming: string): string {
  const a = local.trim();
  const b = incoming.trim();
  if (!a) return b;
  if (!b) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a}\n\n---\n\n${b}`;
}

/** 合并双方来源引用（FR-MEM-11 验收：合并结果保留双方来源引用） */
export function mergeSourceRefs(local: MemoryItem, incoming: MemoryItem): { sourceRef: string | null; sources: string[] } {
  const sources = [local.sourceRef, incoming.sourceRef].filter(
    (ref): ref is string => typeof ref === 'string' && ref.length > 0,
  );
  const unique = [...new Set(sources)];
  return { sourceRef: unique.length > 0 ? unique.join(' | ') : null, sources: unique };
}

function mergeIssueStatus(a: IssueStatus | null, b: IssueStatus | null): IssueStatus | null {
  if (a === null) return b;
  if (b === null) return a;
  // 未解决优先保留（避免把仍在复现的问题标成已解决）
  if (a === 'unsolved' || b === 'unsolved') return 'unsolved';
  if (a === 'solved' || b === 'solved') return 'solved';
  return 'mitigated';
}

export interface MergeOutcome {
  item: MemoryItem;
  /** 被合并写入的字段列表（含展示用字段名） */
  mergedFields: string[];
  /** 双方来源引用 */
  sources: string[];
}

/**
 * 合并两条记忆：保留 local 的身份（id / 归属），融合 incoming 的内容。
 * 标题保留 local（避免命名抖动），正文与结构化数据合并，标签并集，重要度取大。
 */
export function mergeMemoryItems(local: MemoryItem, incoming: MemoryItem, now: number = Date.now()): MergeOutcome {
  const structured = deepMergeStructured(local.structured, incoming.structured);
  const { sourceRef, sources } = mergeSourceRefs(local, incoming);
  const item: MemoryItem = {
    ...local,
    content: mergeContent(local.content, incoming.content),
    structured: Object.keys(structured.value).length > 0 ? structured.value : null,
    tags: [...new Set([...local.tags, ...incoming.tags])],
    sourceRef,
    confidence: clamp01(Math.max(local.confidence, incoming.confidence)),
    importance: clampImportance(Math.max(local.importance, incoming.importance)),
    issueStatus: local.scope === 'issue' ? mergeIssueStatus(local.issueStatus, incoming.issueStatus) : null,
    pinned: local.pinned || incoming.pinned,
    updatedAt: now,
  };

  const mergedFields = ['content', ...structured.mergedPaths.map((path) => `structured.${path}`)];
  if (sourceRef !== local.sourceRef) mergedFields.push('sourceRef');
  if (item.tags.length !== local.tags.length) mergedFields.push('tags');

  return { item, mergedFields, sources };
}

/* --------------------------- 策略决策 --------------------------- */

export const CONFLICT_STRATEGIES = ['keepLocal', 'takeNew', 'merge'] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

export const CONFLICT_STRATEGY_LABELS: Record<ConflictStrategy, string> = {
  keepLocal: '保留旧',
  takeNew: '采用新',
  merge: '合并',
};

export type ConflictResolution =
  | { strategy: 'keepLocal'; item: MemoryItem; discarded: MemoryItem }
  | { strategy: 'takeNew'; item: MemoryItem; superseded: MemoryItem }
  | { strategy: 'merge'; item: MemoryItem; mergedFields: string[]; sources: string[]; absorbed: MemoryItem };

export interface ResolveConflictInput {
  strategy: ConflictStrategy;
  /** 已存在的本地条目 */
  local: MemoryItem;
  /** 新来的条目 */
  incoming: MemoryItem;
  now?: number;
}

/**
 * 按策略产出"该持久化的条目"。
 *
 * 注意：`takeNew` 返回的是 incoming 本身（新身份），调用方需把 local 置为 superseded；
 * `keepLocal` 返回 local，调用方丢弃 incoming；两者都由 `item` 字段表达最终结果。
 */
export function applyConflictStrategy(input: ResolveConflictInput): ConflictResolution {
  const now = input.now ?? Date.now();
  switch (input.strategy) {
    case 'keepLocal':
      return { strategy: 'keepLocal', item: input.local, discarded: input.incoming };
    case 'takeNew':
      return { strategy: 'takeNew', item: { ...input.incoming, updatedAt: now }, superseded: input.local };
    case 'merge': {
      const outcome = mergeMemoryItems(input.local, input.incoming, now);
      return {
        strategy: 'merge',
        item: outcome.item,
        mergedFields: outcome.mergedFields,
        sources: outcome.sources,
        absorbed: input.incoming,
      };
    }
  }
}
