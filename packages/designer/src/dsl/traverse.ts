import type { ElementNode } from './types';

/**
 * 组件树遍历与不可变更新（T3-01 要点 4）。
 *
 * 关键设计：**indexPath 是唯一寻址手段**。
 * id 在 DSL 内应当唯一，但导入外部 / 手写文件时可能重复；因此所有定位 API
 * 一律先解析出「对象引用 + index 路径」，再基于路径做读取与不可变更新，
 * 保证重复 id 场景下祖先链、路径定位不会互相串味。
 *
 * 所有更新函数都是纯函数：返回新的根节点，不修改入参。
 */

/** 前序遍历得到的节点记录 */
export interface WalkedNode {
  node: ElementNode;
  /** 从根出发的 index 路径（根为 []） */
  indexPath: number[];
  /** 根为 0 */
  depth: number;
}

/** 节点位置信息 */
export interface NodeLocation {
  node: ElementNode;
  indexPath: number[];
  parent: ElementNode | null;
  parentPath: number[];
  /** 在父节点 children 中的下标；根节点为 -1 */
  indexInParent: number;
  depth: number;
}

/** 前序遍历收集全部节点 */
export function walkElements(root: ElementNode): WalkedNode[] {
  const out: WalkedNode[] = [];
  const stack: Array<{ node: ElementNode; indexPath: number[]; depth: number }> = [
    { node: root, indexPath: [], depth: 0 },
  ];
  while (stack.length > 0) {
    const current = stack.pop() as { node: ElementNode; indexPath: number[]; depth: number };
    out.push(current);
    const children = current.node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index] as ElementNode,
        indexPath: [...current.indexPath, index],
        depth: current.depth + 1,
      });
    }
  }
  return out;
}

function nodeAt(root: ElementNode, indexPath: readonly number[]): ElementNode | null {
  let current: ElementNode = root;
  for (const index of indexPath) {
    const children = current.children ?? [];
    const next = children[index];
    if (next === undefined) return null;
    current = next;
  }
  return current;
}

function locationOf(root: ElementNode, indexPath: readonly number[]): NodeLocation | null {
  const node = nodeAt(root, indexPath);
  if (node === null) return null;
  const parentPath = indexPath.slice(0, -1);
  const parent = indexPath.length === 0 ? null : nodeAt(root, parentPath);
  const last = indexPath[indexPath.length - 1];
  return {
    node,
    indexPath: [...indexPath],
    parent,
    parentPath: [...parentPath],
    indexInParent: last === undefined ? -1 : last,
    depth: indexPath.length,
  };
}

/** 按 id 定位**首次出现**的节点（前序优先，确定性） */
export function locateById(root: ElementNode, id: string): NodeLocation | null {
  for (const walked of walkElements(root)) {
    if (walked.node.id === id) return locationOf(root, walked.indexPath);
  }
  return null;
}

/** 按 id 收集**全部**出现位置（重复 id 检测 / 批量修复用） */
export function locateAllById(root: ElementNode, id: string): NodeLocation[] {
  const out: NodeLocation[] = [];
  for (const walked of walkElements(root)) {
    if (walked.node.id === id) {
      const location = locationOf(root, walked.indexPath);
      if (location) out.push(location);
    }
  }
  return out;
}

/** 按 id 查找节点（首次出现） */
export function findById(root: ElementNode, id: string): ElementNode | null {
  return locateById(root, id)?.node ?? null;
}

/** 按 index 路径查找节点 */
export function findByPath(root: ElementNode, indexPath: readonly number[]): ElementNode | null {
  return nodeAt(root, indexPath);
}

/**
 * 祖先链：从根到**直接父节点**（不含自身）。
 * 重复 id 场景下以首次出现为准；如需精确定位请先 `locateAllById` 拿 indexPath。
 */
export function ancestorChain(root: ElementNode, id: string): ElementNode[] {
  const location = locateById(root, id);
  if (location === null) return [];
  const chain: ElementNode[] = [];
  for (let depth = 0; depth < location.indexPath.length; depth += 1) {
    const node = nodeAt(root, location.indexPath.slice(0, depth));
    if (node) chain.push(node);
  }
  return chain;
}

/** 祖先链（按 index 路径精确解析） */
export function ancestorChainOfPath(
  root: ElementNode,
  indexPath: readonly number[],
): ElementNode[] {
  const chain: ElementNode[] = [];
  for (let depth = 0; depth < indexPath.length; depth += 1) {
    const node = nodeAt(root, indexPath.slice(0, depth));
    if (node) chain.push(node);
  }
  return chain;
}

/** 返回 JSON path 表达式，如 `$.tree.children[0].children[2]` */
export function pathOf(root: ElementNode, id: string, base = '$.tree'): string | null {
  const location = locateById(root, id);
  if (location === null) return null;
  return indexPathToJsonPath(location.indexPath, base);
}

/** index 路径 → JSON path 表达式 */
export function indexPathToJsonPath(indexPath: readonly number[], base = '$.tree'): string {
  return indexPath.reduce<string>((acc, index) => `${acc}.children[${index}]`, base);
}

/** 解析 JSON path 表达式（只支持 `$.tree.children[i]` 形态，回退到 index 路径解析） */
export function resolveJsonPath(root: ElementNode, path: string): ElementNode | null {
  const matches = [...path.matchAll(/children\[(\d+)\]/g)];
  const indexPath = matches.map((match) => Number(match[1]));
  return nodeAt(root, indexPath);
}

/** 子树（含自身） */
export function subtree(root: ElementNode, id: string): ElementNode | null {
  return findById(root, id);
}

/** 父节点 */
export function parentOf(root: ElementNode, id: string): ElementNode | null {
  return locateById(root, id)?.parent ?? null;
}

/** 深度（根为 0） */
export function depthOf(root: ElementNode, id: string): number {
  return locateById(root, id)?.depth ?? -1;
}

/** 判断 descendantId 是否在 ancestorId 的子树内（含自身） */
export function isDescendant(root: ElementNode, ancestorId: string, descendantId: string): boolean {
  const ancestor = locateById(root, ancestorId);
  if (ancestor === null) return false;
  const prefix = ancestor.indexPath;
  return locateAllById(root, descendantId).some(
    (location) =>
      location.indexPath.length >= prefix.length &&
      prefix.every((segment, index) => location.indexPath[index] === segment),
  );
}

/** 深度优先访问：order='pre' 前序 / 'post' 后序 */
export function visit(
  root: ElementNode,
  handlers: {
    enter?: (node: ElementNode, depth: number) => void;
    leave?: (node: ElementNode) => void;
  },
  order: 'pre' | 'post' = 'pre',
): void {
  const walk = (node: ElementNode, depth: number): void => {
    if (order === 'pre') handlers.enter?.(node, depth);
    for (const child of node.children ?? []) walk(child, depth + 1);
    if (order === 'post') handlers.leave?.(node);
    else handlers.leave?.(node);
  };
  walk(root, 0);
}

/** 结构性映射：返回新的根节点 */
export function mapTree(
  root: ElementNode,
  mapper: (node: ElementNode, depth: number) => ElementNode,
): ElementNode {
  const walk = (node: ElementNode, depth: number): ElementNode => {
    const mapped = mapper(node, depth);
    const children = mapped.children;
    if (children === undefined) return mapped;
    return { ...mapped, children: children.map((child) => walk(child, depth + 1)) };
  };
  return walk(root, 0);
}

/**
 * 在指定 index 路径上替换节点（不可变）。
 * 路径不存在时原样返回。
 */
export function replaceAtPath(
  root: ElementNode,
  indexPath: readonly number[],
  next: ElementNode,
): ElementNode {
  if (indexPath.length === 0) return next;
  const [head, ...rest] = indexPath as [number, ...number[]];
  const children = root.children ?? [];
  const target = children[head];
  if (target === undefined) return root;
  const rebuilt = children.slice();
  rebuilt[head] = replaceAtPath(target, rest, next);
  return { ...root, children: rebuilt };
}

/** 按 id 替换节点（首次出现） */
export function replaceNode(
  root: ElementNode,
  id: string,
  updater: (node: ElementNode) => ElementNode,
): ElementNode {
  const location = locateById(root, id);
  if (location === null) return root;
  return replaceAtPath(root, location.indexPath, updater(location.node));
}

/** 按 index 路径删除节点，返回新根与被删节点 */
export function removeAtPath(
  root: ElementNode,
  indexPath: readonly number[],
): { root: ElementNode; removed: ElementNode | null } {
  if (indexPath.length === 0) return { root, removed: root };
  const [head, ...rest] = indexPath as [number, ...number[]];
  const children = root.children ?? [];
  const target = children[head];
  if (target === undefined) return { root, removed: null };
  if (rest.length === 0) {
    const rebuilt = children.slice();
    rebuilt.splice(head, 1);
    return { root: { ...root, children: rebuilt }, removed: target };
  }
  const inner = removeAtPath(target, rest);
  if (inner.removed === null) return { root, removed: null };
  const rebuilt = children.slice();
  rebuilt[head] = inner.root;
  return { root: { ...root, children: rebuilt }, removed: inner.removed };
}

/** 按 id 删除节点 */
export function removeNode(
  root: ElementNode,
  id: string,
): { root: ElementNode; removed: ElementNode | null } {
  const location = locateById(root, id);
  if (location === null) return { root, removed: null };
  return removeAtPath(root, location.indexPath);
}

/** 在父节点 children 的 index 处插入（index 省略则追加到末尾） */
export function insertChild(
  root: ElementNode,
  parentId: string,
  child: ElementNode,
  index?: number,
): { root: ElementNode; inserted: boolean } {
  const location = locateById(root, parentId);
  if (location === null) return { root, inserted: false };
  const children = (location.node.children ?? []).slice();
  const at = index === undefined || index < 0 || index > children.length ? children.length : index;
  children.splice(at, 0, child);
  const nextNode: ElementNode = { ...location.node, children };
  return { root: replaceAtPath(root, location.indexPath, nextNode), inserted: true };
}

/** 在兄弟节点前 / 后插入 */
export function insertSibling(
  root: ElementNode,
  siblingId: string,
  node: ElementNode,
  position: 'before' | 'after' = 'after',
): { root: ElementNode; inserted: boolean } {
  const location = locateById(root, siblingId);
  if (location === null || location.parent === null) return { root, inserted: false };
  const index = position === 'before' ? location.indexInParent : location.indexInParent + 1;
  return insertChild(root, location.parent.id, node, index);
}

/**
 * 移动节点：从原位置摘除后插入目标父节点的指定位置。
 * 目标为自身或自身子树时拒绝（返回 moved:false）。
 */
export function moveNode(
  root: ElementNode,
  id: string,
  targetParentId: string,
  index?: number,
): { root: ElementNode; moved: boolean; reason?: 'not-found' | 'cycle' } {
  const source = locateById(root, id);
  if (source === null) return { root, moved: false, reason: 'not-found' };
  if (targetParentId === id) return { root, moved: false, reason: 'cycle' };
  if (isDescendant(root, id, targetParentId)) return { root, moved: false, reason: 'cycle' };
  const target = locateById(root, targetParentId);
  if (target === null) return { root, moved: false, reason: 'not-found' };

  // 同父内移动需要先摘除再按调整后的下标插入
  const sameParent = source.parent?.id === targetParentId;
  const removed = removeAtPath(root, source.indexPath);
  if (removed.removed === null) return { root, moved: false, reason: 'not-found' };
  let insertAt = index;
  if (sameParent && insertAt !== undefined && insertAt > source.indexInParent) insertAt -= 1;
  const inserted = insertChild(removed.root, targetParentId, removed.removed, insertAt);
  if (!inserted.inserted) return { root, moved: false, reason: 'not-found' };
  return { root: inserted.root, moved: true };
}

/** 复制子树并重新分配 id（新增 / 复制元素时使用） */
export function cloneSubtree(subtreeRoot: ElementNode, idFactory: () => string): ElementNode {
  const clone: ElementNode = { ...subtreeRoot, id: idFactory() };
  if (subtreeRoot.children !== undefined) {
    clone.children = subtreeRoot.children.map((child) => cloneSubtree(child, idFactory));
  }
  return clone;
}

/** 收集子树内全部 id（含自身） */
export function collectIds(node: ElementNode): string[] {
  return walkElements(node).map((walked) => walked.node.id);
}

/** 判断节点是否为叶子（无 children 或空数组） */
export function isLeaf(node: ElementNode): boolean {
  return (node.children ?? []).length === 0;
}
