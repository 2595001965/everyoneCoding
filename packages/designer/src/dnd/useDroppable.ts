/**
 * 可放置容器钩子（T3-03 要点 1）。
 *
 * 薄封装 dnd-kit 的 `useDroppable`，强制 `data.target` 携带 `CollisionTarget`
 * （被悬停元素的树元数据 + 屏幕矩形），供 DndProvider 在拖拽期间实时解析插入位置。
 */
import { useDroppable as dndUseDroppable } from '@dnd-kit/core';
import type { CollisionTarget } from './collision';

export interface DroppableOptions {
  id: string;
  /** 被悬停元素的树元数据 + 矩形（碰撞解析用） */
  data?: { target: CollisionTarget } | undefined;
  disabled?: boolean | undefined;
}

export function useDroppable(options: DroppableOptions) {
  return dndUseDroppable({
    id: options.id,
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.disabled !== undefined ? { disabled: options.disabled } : {}),
  });
}
