/**
 * 可拖拽元素钩子（T3-03 要点 1）。
 *
 * 薄封装 dnd-kit 的 `useDraggable`，强制 `data` 携带 `DragData`（来自组件面板或画布）。
 * 组件面板与画布元素都通过它接入拖拽总线。
 */
import { useDraggable as dndUseDraggable } from '@dnd-kit/core';
import type { DragData } from './DndProvider';

export interface DraggableOptions {
  /** 唯一 id（画布元素用元素 id；面板项用类型标识） */
  id: string;
  /** 拖拽载荷 */
  data?: DragData | undefined;
  disabled?: boolean | undefined;
}

export function useDraggable(options: DraggableOptions) {
  return dndUseDraggable({
    id: options.id,
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.disabled !== undefined ? { disabled: options.disabled } : {}),
  });
}
