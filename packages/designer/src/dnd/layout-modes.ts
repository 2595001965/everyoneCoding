/**
 * 容器布局模式（T3-03 要点 4）。
 *
 * - `absolute`：自由摆放，x/y 记录在 style（position:absolute + left/top）
 * - `flow`：弹性行列，子节点按 DOM 顺序自然排列（容器 display:flex）
 *
 * 提供 `LAYOUT_MODES`、`insertIndexFor`（位置→下标换算）与 `convertLayout`（切换时
 * 的位置换算策略）。
 */
import type { ElementNode } from '../dsl/types';
import type { InsertionPosition } from './collision';

/** 支持的布局模式 */
export const LAYOUT_MODES = ['absolute', 'flow'] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

/** 从元素 style 读取其布局模式（缺省 absolute） */
export function layoutModeOf(node: ElementNode): LayoutMode {
  const display = node.style?.display;
  if (display === 'flex' || display === 'grid') return 'flow';
  return 'absolute';
}

export interface InsertIndexOptions {
  /** 同级元素数量 */
  siblingCount: number;
  /** 参考元素在同级中的下标（before/after 的相对锚点） */
  referenceIndex?: number;
}

/**
 * 把插入位置换算为父容器 children 中的下标。
 * - before：参考元素下标（无参考则 0）
 * - after：参考元素下标 + 1（无参考则末尾）
 * - inside：末尾（siblingCount）
 */
export function insertIndexFor(position: InsertionPosition, options: InsertIndexOptions): number {
  const { siblingCount, referenceIndex } = options;
  switch (position) {
    case 'before':
      return referenceIndex ?? 0;
    case 'after':
      return (referenceIndex ?? siblingCount - 1) + 1;
    case 'inside':
      return siblingCount;
  }
}

/**
 * 切换容器布局模式时的位置换算策略（纯函数，返回新节点，不修改入参）。
 *
 * - absolute → flow：容器置 display:flex（flow 列默认纵向），清除子节点上的
 *   position/left/top，使其按 DOM 顺序自然排列。
 * - flow → absolute：容器保留 flex 容器语义但子节点改为绝对定位，x/y 取自原
 *   left/top（缺失则 0），便于后续自由拖拽。
 */
export function convertLayout(node: ElementNode, from: LayoutMode, to: LayoutMode): ElementNode {
  if (from === to) return node;

  const style = { ...(node.style ?? {}) };
  const children = node.children ?? [];

  if (from === 'absolute' && to === 'flow') {
    style.display = 'flex';
    style.flexDirection = 'column';
    delete style.position;
    const nextChildren = children.map((child) => {
      const childStyle = { ...(child.style ?? {}) };
      delete childStyle.position;
      delete childStyle.left;
      delete childStyle.top;
      return { ...child, style: childStyle };
    });
    return { ...node, style, ...(nextChildren.length > 0 ? { children: nextChildren } : {}) };
  }

  // flow → absolute
  style.position = 'relative';
  delete style.display;
  delete style.flexDirection;
  const nextChildren = children.map((child) => {
    const childStyle = { ...(child.style ?? {}) };
    childStyle.position = 'absolute';
    childStyle.left = childStyle.left ?? 0;
    childStyle.top = childStyle.top ?? 0;
    return { ...child, style: childStyle };
  });
  return { ...node, style, ...(nextChildren.length > 0 ? { children: nextChildren } : {}) };
}
