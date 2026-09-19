import type { ElementNode } from '../dsl/types';

/**
 * 组件树的**草稿（draft）变异**辅助（设计器内核共享）。
 *
 * 背景：撤销栈基于 Immer 的 `produceWithPatches`，所有文档变更都发生在 draft 上。
 * `dsl/traverse.ts` 提供的是**不可变**更新（返回新树），两者混用会引入「draft 套 draft」
 * 的隐患，因此内核统一使用本文件的 draft 变异函数；读取类操作仍复用 traverse。
 *
 * 所有函数第一个参数都是 draft 根节点（或任意子树根），直接就地修改。
 * id 定位采用前序首次匹配，与 `traverse.locateById` 语义一致。
 */

export interface DraftLocation {
  node: ElementNode;
  parent: ElementNode | null;
  indexInParent: number;
  depth: number;
}

/** 前序定位（首次匹配），返回节点与其父节点引用 */
export function draftLocate(root: ElementNode, id: string): DraftLocation | null {
  const stack: Array<{
    node: ElementNode;
    parent: ElementNode | null;
    index: number;
    depth: number;
  }> = [{ node: root, parent: null, index: -1, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.shift() as {
      node: ElementNode;
      parent: ElementNode | null;
      index: number;
      depth: number;
    };
    if (current.node.id === id) {
      return {
        node: current.node,
        parent: current.parent,
        indexInParent: current.index,
        depth: current.depth,
      };
    }
    const children = current.node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.unshift({
        node: children[index] as ElementNode,
        parent: current.node,
        index,
        depth: current.depth + 1,
      });
    }
  }
  return null;
}

/** 取（并确保存在）children 数组，可直接 push / splice */
export function draftChildren(node: ElementNode): ElementNode[] {
  if (node.children === undefined) node.children = [];
  return node.children;
}

/** 在父节点下插入子节点（index 缺省追加） */
export function draftInsertChild(
  root: ElementNode,
  parentId: string,
  child: ElementNode,
  index?: number,
): boolean {
  const parent = draftLocate(root, parentId);
  if (parent === null) return false;
  const children = draftChildren(parent.node);
  const at = index === undefined || index < 0 || index > children.length ? children.length : index;
  children.splice(at, 0, child);
  return true;
}

/** 删除节点，返回被删节点；节点不存在返回 null。根节点不可删除。 */
export function draftRemoveNode(root: ElementNode, id: string): ElementNode | null {
  if (root.id === id) return null;
  const location = draftLocate(root, id);
  if (location === null || location.parent === null) return null;
  const siblings = draftChildren(location.parent);
  const removed = siblings.splice(location.indexInParent, 1);
  return removed[0] ?? null;
}

/** 就地修改节点（回调里直接改 draft） */
export function draftUpdateNode(
  root: ElementNode,
  id: string,
  patch: (node: ElementNode) => void,
): boolean {
  const location = draftLocate(root, id);
  if (location === null) return false;
  patch(location.node);
  return true;
}

/** 替换节点的 children 列表 */
export function draftSetChildren(root: ElementNode, id: string, children: ElementNode[]): boolean {
  const location = draftLocate(root, id);
  if (location === null) return false;
  location.node.children = children;
  return true;
}

/** 判断节点是否在另一节点的子树内（含自身），用于拖拽循环检测 */
export function draftIsDescendant(
  root: ElementNode,
  ancestorId: string,
  descendantId: string,
): boolean {
  const ancestor = draftLocate(root, ancestorId);
  if (ancestor === null) return false;
  const found = draftLocate(ancestor.node, descendantId);
  return found !== null;
}

/** draft 节点计数（用于测试与校验） */
export function draftCount(root: ElementNode): number {
  let total = 0;
  const stack: ElementNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ElementNode;
    total += 1;
    for (const child of node.children ?? []) stack.push(child);
  }
  return total;
}

/**
 * 移动节点：先摘除再按调整后的下标插入。
 * 目标为自身或自身子树时返回 false（循环防护）。
 */
export function draftMoveNode(
  root: ElementNode,
  id: string,
  targetParentId: string,
  index?: number,
): boolean {
  if (id === targetParentId) return false;
  const source = draftLocate(root, id);
  if (source === null || source.parent === null) return false;
  if (draftIsDescendant(root, id, targetParentId)) return false;
  const targetExists = draftLocate(root, targetParentId) !== null;
  if (!targetExists) return false;

  const sameParent = source.parent.id === targetParentId;
  const originalIndex = source.indexInParent;
  const removed = draftRemoveNode(root, id);
  if (removed === null) return false;
  const adjusted = sameParent && index !== undefined && index > originalIndex ? index - 1 : index;
  return draftInsertChild(root, targetParentId, removed, adjusted);
}
