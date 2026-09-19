import type { ElementNode, MasterRef, PageDsl } from '../dsl/types';
import { findById, mapTree, walkElements } from '../dsl/traverse';

/**
 * 母版（Master）与实例同步（T3-11 要点 3）。
 *
 * - 母版 = 可复用组件的结构定义 + 版本时间戳；
 * - 实例 = 页面里带 `masterRef` 的元素；
 * - 修改母版后，实例可逐个选择「同步更新」或「脱离」；
 * - **脱离（detached）之后不再同步**，且再次同步会被显式拒绝（需要先重新关联）。
 */

export interface MasterDefinition {
  id: string;
  name: string;
  tree: ElementNode;
  updatedAt: number;
  /** 版本的说明（如「新增校验提示」） */
  note?: string;
}

export interface MasterInstanceRef {
  pageId: string;
  elementId: string;
  masterId: string;
  detached: boolean;
  /** 实例名（中文显示名） */
  name?: string;
}

function cloneNode(node: ElementNode): ElementNode {
  return JSON.parse(JSON.stringify(node)) as ElementNode;
}

/** 母版注册表 */
export class MasterRegistry {
  private readonly masters = new Map<string, MasterDefinition>();
  /** 自身计数器：保证实例 id 唯一 */
  private counter = 0;

  register(definition: MasterDefinition): MasterDefinition {
    this.masters.set(definition.id, definition);
    return definition;
  }

  update(
    masterId: string,
    patch: { tree?: ElementNode; name?: string; note?: string; now?: number },
  ): MasterDefinition | null {
    const current = this.masters.get(masterId);
    if (current === undefined) return null;
    const next: MasterDefinition = {
      ...current,
      ...(patch.tree !== undefined ? { tree: cloneNode(patch.tree) } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      updatedAt: patch.now ?? Date.now(),
    };
    this.masters.set(masterId, next);
    return next;
  }

  get(masterId: string): MasterDefinition | null {
    return this.masters.get(masterId) ?? null;
  }

  list(): MasterDefinition[] {
    return [...this.masters.values()];
  }

  nextInstanceId(prefix = 'master-el'): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }
}

/** 由母版实例化一个元素（id 由调用方给定，保留 masterRef 关联） */
export function instantiateMaster(
  master: MasterDefinition,
  options: { elementId: string; name?: string },
): ElementNode {
  const clone = cloneNode(master.tree);
  const withIds = reid(
    clone,
    options.elementId,
    () => `ec-${Math.random().toString(36).slice(2, 8)}`,
  );
  if (options.name !== undefined) withIds.name = options.name;
  withIds.masterRef = { masterId: master.id, detached: false } satisfies MasterRef;
  return withIds;
}

/** 重新分配 id：根节点沿用指定 id，其余子节点生成新 id */
function reid(node: ElementNode, rootId: string, childId: () => string): ElementNode {
  const next: ElementNode = { ...node, id: rootId };
  if (node.children !== undefined)
    next.children = node.children.map((child) => reid(child, childId(), childId));
  return next;
}

/** 收集页面中的母版实例 */
export function collectMasterInstances(dsl: PageDsl, masterId?: string): MasterInstanceRef[] {
  const out: MasterInstanceRef[] = [];
  for (const { node } of walkElements(dsl.tree)) {
    const ref = node.masterRef;
    if (ref === undefined || ref === null) continue;
    if (masterId !== undefined && ref.masterId !== masterId) continue;
    out.push({
      pageId: dsl.id,
      elementId: node.id,
      masterId: ref.masterId,
      detached: ref.detached === true,
      ...(node.name !== undefined ? { name: node.name } : {}),
    });
  }
  return out;
}

export interface SyncResult {
  dsl: PageDsl;
  /** 已同步的实例 id */
  synced: string[];
  /** 因脱离 / 未找到母版而跳过的实例 id */
  skipped: string[];
}

/**
 * 把母版结构同步到实例。
 * - `options.elementIds` 指定只同步部分实例；
 * - `detached` 实例一律跳过（T3-11 验收项）；
 * - 同步时保留实例自身的 id 与 `name`（显示名不因母版变化被覆盖）。
 */
export function syncInstances(
  dsl: PageDsl,
  master: MasterDefinition,
  options: { elementIds?: readonly string[] } = {},
): SyncResult {
  const synced: string[] = [];
  const skipped: string[] = [];
  const targets = new Set(
    options.elementIds ?? collectMasterInstances(dsl, master.id).map((ref) => ref.elementId),
  );

  const nextTree = mapTree(dsl.tree, (node) => {
    const ref = node.masterRef;
    if (ref === undefined || ref === null || ref.masterId !== master.id) return node;
    if (!targets.has(node.id)) return node;
    if (ref.detached === true) {
      skipped.push(node.id);
      return node;
    }
    const clone = cloneNode(master.tree);
    const synced0 = reid(clone, node.id, () => `ec-${Math.random().toString(36).slice(2, 8)}`);
    // 保留实例显示名与自身绑定；其余结构来自母版
    const merged: ElementNode = {
      ...synced0,
      ...(node.name !== undefined ? { name: node.name } : {}),
      masterRef: { masterId: master.id, detached: false },
    };
    synced.push(node.id);
    return merged;
  });

  return { dsl: { ...dsl, tree: nextTree }, synced, skipped };
}

/** 把实例标记为脱离（脱离后不再随母版更新） */
export function detachInstance(dsl: PageDsl, elementId: string): PageDsl {
  const found = findById(dsl.tree, elementId);
  if (found === null || found.masterRef === undefined || found.masterRef === null) return dsl;
  return {
    ...dsl,
    tree: mapTree(dsl.tree, (node) =>
      node.id === elementId && node.masterRef !== undefined && node.masterRef !== null
        ? { ...node, masterRef: { ...node.masterRef, detached: true } }
        : node,
    ),
  };
}

/** 重新关联（脱离后想恢复同步时使用） */
export function reattachInstance(dsl: PageDsl, elementId: string, masterId: string): PageDsl {
  return {
    ...dsl,
    tree: mapTree(dsl.tree, (node) =>
      node.id === elementId ? { ...node, masterRef: { masterId, detached: false } } : node,
    ),
  };
}

/** 统计母版使用情况（面板展示「N 个实例，其中 M 个已脱离」） */
export function masterUsage(
  pages: readonly PageDsl[],
  masterId: string,
): { total: number; detached: number; pages: number } {
  let total = 0;
  let detached = 0;
  let pageCount = 0;
  for (const page of pages) {
    const instances = collectMasterInstances(page, masterId);
    if (instances.length === 0) continue;
    pageCount += 1;
    total += instances.length;
    detached += instances.filter((ref) => ref.detached).length;
  }
  return { total, detached, pages: pageCount };
}
