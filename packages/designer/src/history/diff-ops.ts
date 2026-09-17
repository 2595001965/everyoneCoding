import type { ElementNode, PageDsl } from '../dsl/types';
import { locateById } from '../dsl/traverse';

/**
 * DSL 结构化差异（T3-10 要点 3/4）。
 *
 * 四类变更：新增（added）/ 删除（removed）/ 移动（moved）/ 修改（modified）。
 * **移动的识别基于稳定 id**：同一 id 在新旧树中都存在但父节点或下标变化即判为「移动」，
 * 而不是「删除 + 新增」（这是差异视图可读性的关键）。
 *
 * 同一套差异既用于差异视图展示，也用于快照的增量 patch 链。
 */

export interface ElementRef {
  id: string;
  type: string;
  name?: string;
  parentId: string | null;
  index: number;
}

export interface AddedEntry extends ElementRef {
  /** 新节点整棵子树（落地时直接插入） */
  node: ElementNode;
}
export interface RemovedEntry extends ElementRef {
  node: ElementNode;
}
export interface MovedEntry extends ElementRef {
  fromParentId: string | null;
  fromIndex: number;
}
export interface ModifiedEntry extends ElementRef {
  changedKeys: string[];
  before: ElementNode;
  after: ElementNode;
}

export interface DslTreeDiff {
  added: AddedEntry[];
  removed: RemovedEntry[];
  moved: MovedEntry[];
  modified: ModifiedEntry[];
  /** 页面级字段变更（name / route / platform / viewport / featureId） */
  pageChanged: string[];
  /** 状态 / 事件 / 接口依赖 / 锚点是否变化 */
  stateChanged: boolean;
  eventsChanged: boolean;
  apiDepsChanged: boolean;
  anchorsChanged: boolean;
  notesChanged: boolean;
}

interface Flat {
  node: ElementNode;
  parentId: string | null;
  index: number;
  depth: number;
}

function flatten(root: ElementNode): Map<string, Flat> {
  const map = new Map<string, Flat>();
  const walk = (node: ElementNode, parentId: string | null, index: number, depth: number): void => {
    // 重复 id 时保留首次出现（与 traverse.locateById 语义一致）
    if (!map.has(node.id)) map.set(node.id, { node, parentId, index, depth });
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i += 1) walk(children[i] as ElementNode, node.id, i, depth + 1);
  };
  walk(root, null, 0, 0);
  return map;
}

/** 节点可比较的字段（用于 modified 判定与 changedKeys） */
const COMPARABLE_KEYS: readonly (keyof ElementNode)[] = [
  'props',
  'style',
  'bindings',
  'name',
  'locked',
  'hidden',
  'featureRef',
  'noteId',
  'masterRef',
  'responsive',
  'condition',
  'permission',
  'type',
];

function stable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function diffTrees(previous: PageDsl, next: PageDsl): DslTreeDiff {
  const before = flatten(previous.tree);
  const after = flatten(next.tree);

  const added: AddedEntry[] = [];
  const removed: RemovedEntry[] = [];
  const moved: MovedEntry[] = [];
  const modified: ModifiedEntry[] = [];

  for (const [id, entry] of after) {
    if (!before.has(id)) {
      added.push({ id, type: entry.node.type, ...(entry.node.name !== undefined ? { name: entry.node.name } : {}), parentId: entry.parentId, index: entry.index, node: entry.node });
    }
  }

  // 同级相对顺序：插入 / 删除造成的整体位移不算「移动」，只有相对次序变化才算。
  // 只统计「父节点未变」的公共节点，避免被新增 / 删除 / 跨父移动的节点顶位而误判。
  const rankWithinSiblings = (source: Map<string, Flat>, other: Map<string, Flat>): Map<string, number> => {
    const byParent = new Map<string, string[]>();
    for (const [id, entry] of source) {
      const counterpart = other.get(id);
      if (counterpart === undefined) continue;
      if ((counterpart.parentId ?? null) !== (entry.parentId ?? null)) continue;
      const key = entry.parentId ?? '__root__';
      const list = byParent.get(key) ?? [];
      list.push(id);
      byParent.set(key, list);
    }
    const order = new Map<string, number>();
    for (const list of byParent.values()) list.forEach((id, index) => order.set(id, index));
    return order;
  };
  const beforeOrder = rankWithinSiblings(before, after);
  const afterOrder = rankWithinSiblings(after, before);

  for (const [id, entry] of before) {
    if (!after.has(id)) {
      removed.push({ id, type: entry.node.type, ...(entry.node.name !== undefined ? { name: entry.node.name } : {}), parentId: entry.parentId, index: entry.index, node: entry.node });
      continue;
    }
    const now = after.get(id) as Flat;
    const changedKeys = COMPARABLE_KEYS.filter((key) => stable(entry.node[key]) !== stable(now.node[key]));
    if (changedKeys.length > 0) {
      modified.push({
        id,
        type: now.node.type,
        ...(now.node.name !== undefined ? { name: now.node.name } : {}),
        parentId: now.parentId,
        index: now.index,
        changedKeys: changedKeys.map((key) => String(key)),
        before: entry.node,
        after: now.node,
      });
    }
    const parentChanged = entry.parentId !== now.parentId;
    const orderChanged = !parentChanged && beforeOrder.get(id) !== afterOrder.get(id);
    if (parentChanged || orderChanged) {
      moved.push({
        id,
        type: now.node.type,
        ...(now.node.name !== undefined ? { name: now.node.name } : {}),
        parentId: now.parentId,
        index: now.index,
        fromParentId: entry.parentId,
        fromIndex: entry.index,
      });
    }
  }

  const pageChanged = (['name', 'route', 'platform', 'featureId', 'viewport'] as const).filter(
    (key) => stable(previous[key]) !== stable(next[key]),
  ) as string[];

  return {
    added,
    removed,
    moved,
    modified,
    pageChanged,
    stateChanged: stable(previous.state) !== stable(next.state),
    eventsChanged: stable(previous.events) !== stable(next.events),
    apiDepsChanged: stable(previous.apiDeps) !== stable(next.apiDeps),
    anchorsChanged: stable(previous.anchors) !== stable(next.anchors),
    notesChanged: stable(previous.notes) !== stable(next.notes),
  };
}

/** 差异总量（用于差异视图摘要与增量策略判定） */
export function diffSize(diff: DslTreeDiff): number {
  return (
    diff.added.length +
    diff.removed.length +
    diff.moved.length +
    diff.modified.length +
    diff.pageChanged.length +
    [diff.stateChanged, diff.eventsChanged, diff.apiDepsChanged, diff.anchorsChanged, diff.notesChanged].filter(Boolean).length
  );
}

/** 差异是否为空 */
export function isEmptyDiff(diff: DslTreeDiff): boolean {
  return diffSize(diff) === 0;
}

/** 差异中文摘要（供时间轴/差异视图工具提示） */
export function describeDiff(diff: DslTreeDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`新增 ${diff.added.length}`);
  if (diff.removed.length > 0) parts.push(`删除 ${diff.removed.length}`);
  if (diff.moved.length > 0) parts.push(`移动 ${diff.moved.length}`);
  if (diff.modified.length > 0) parts.push(`修改 ${diff.modified.length}`);
  if (diff.pageChanged.length > 0) parts.push(`页面字段 ${diff.pageChanged.join('/')}`);
  if (diff.stateChanged) parts.push('状态');
  if (diff.eventsChanged) parts.push('事件流');
  if (diff.apiDepsChanged) parts.push('接口依赖');
  if (diff.anchorsChanged) parts.push('锚点');
  if (diff.notesChanged) parts.push('备注');
  return parts.length === 0 ? '无变化' : parts.join('、');
}

/** 定位节点在新树中的路径（差异视图点击定位用） */
export function locateInDsl(dsl: PageDsl, id: string): { parentId: string | null; index: number } | null {
  const location = locateById(dsl.tree, id);
  if (location === null) return null;
  return { parentId: location.parent?.id ?? null, index: location.indexInParent };
}
