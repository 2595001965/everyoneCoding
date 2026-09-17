/**
 * 自定义碰撞检测（T3-03 要点 2）。
 *
 * 纯函数 `computeInsertion`：给定指针位置与被悬停元素，判定插入位置
 * `{ parentId, index, position }`。规则：
 *   - 指针落在元素中央 20% 区域（两侧各 40% 为同级边距带）→ 嵌套插入（inside）
 *   - 指针落在元素上方 40% 边距带 → 同级前插入（before）
 *   - 指针落在元素下方 40% 边距带 → 同级后插入（after）
 * 先做嵌套规则校验（acceptsChildren，缺省允许）与循环校验（禁止拖入自身子树）。
 * 指针超出画布边界 → 删除（delete）。
 *
 * 不依赖 React / dnd-kit，可在 node 环境直接测试；dnd-kit 的 collisionDetection
 * 适配器在 DndProvider 内调用本函数。
 */
import type { Rect, Point } from '../canvas/coordinate';

/** 插入位置：同级前 / 同级后 / 嵌套内 */
export type InsertionPosition = 'before' | 'after' | 'inside';

/** 拖拽解析结果（判别联合） */
export type DragResolution =
  | { kind: 'insert'; parentId: string; index: number | undefined; position: InsertionPosition }
  | { kind: 'delete' }
  | { kind: 'none' };

/** 两级边距带占比：每侧 40%，中央 20% 为嵌套区 */
export const INSIDE_MARGIN = 0.4;

export interface CollisionTarget {
  /** 被悬停元素 id */
  id: string;
  /** 该元素在屏幕/画布坐标下的矩形（与 pointer 同坐标系） */
  rect: Rect;
  /** 是否接受子节点（嵌套插入前提） */
  acceptsChildren: boolean;
  /** 父节点 id（同级插入时作为插入父级） */
  parentId: string;
  /** 该元素在父节点 children 中的下标 */
  indexInParent: number;
  /** 主排序轴：flow 列→'y'，行→'x'，缺省 'y' */
  axis?: 'x' | 'y';
}

export interface CollisionInput {
  /** 指针坐标（与 target.rect 同坐标系） */
  pointer: Point;
  /** 被悬停元素及其树元数据 */
  target: CollisionTarget;
  /** 循环校验：ancestorId 的子树是否包含 descendantId */
  isDescendant?: ((ancestorId: string, descendantId: string) => boolean) | undefined;
  /** 被拖拽元素 id（用于循环校验与自引用排除） */
  draggedId?: string | undefined;
  /** 画布边界，指针超出即判定为拖出删除 */
  canvasRect?: Rect | undefined;
  /** 边距带占比，默认 INSIDE_MARGIN = 0.4 */
  insideMargin?: number;
}

function ratioAlongAxis(pointer: Point, rect: Rect, axis: 'x' | 'y'): number {
  const start = axis === 'x' ? rect.x : rect.y;
  const size = axis === 'x' ? rect.width : rect.height;
  if (size === 0) return 0;
  const value = axis === 'x' ? pointer.x : pointer.y;
  return (value - start) / size;
}

/**
 * 计算插入位置。所有非法情况返回 `{ kind: 'none' }`，调用方应保留上一次有效结果。
 */
export function computeInsertion(input: CollisionInput): DragResolution {
  const { pointer, target } = input;
  const margin = input.insideMargin ?? INSIDE_MARGIN;
  const axis = target.axis ?? 'y';

  // 1) 拖出画布 → 删除
  if (input.canvasRect) {
    const cr = input.canvasRect;
    const inside =
      pointer.x >= cr.x && pointer.x <= cr.x + cr.width && pointer.y >= cr.y && pointer.y <= cr.y + cr.height;
    if (!inside) return { kind: 'delete' };
  }

  // 2) 自引用排除
  if (input.draggedId !== undefined && input.draggedId === target.id) {
    return { kind: 'none' };
  }

  const ratio = ratioAlongAxis(pointer, target.rect, axis);
  const inInsideZone = ratio > margin && ratio < 1 - margin;

  if (inInsideZone && target.acceptsChildren) {
    // 嵌套插入：目标是「被拖拽元素的后代」时禁止（否则会把祖先塞进自己的子树）
    if (input.draggedId !== undefined && input.isDescendant && input.isDescendant(input.draggedId, target.id)) {
      return { kind: 'none' };
    }
    return { kind: 'insert', parentId: target.id, index: undefined, position: 'inside' };
  }

  // 同级前后插入：拖拽元素若是目标祖先则禁止（否则目标将进入自身子树）
  if (input.draggedId !== undefined && input.isDescendant && input.isDescendant(input.draggedId, target.id)) {
    return { kind: 'none' };
  }

  if (ratio <= margin) {
    return { kind: 'insert', parentId: target.parentId, index: target.indexInParent, position: 'before' };
  }
  return { kind: 'insert', parentId: target.parentId, index: target.indexInParent + 1, position: 'after' };
}
