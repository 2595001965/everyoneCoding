/**
 * 拖拽与布局（T3-03）公共 API。
 * 主会话通过本桶文件接线 src/index.ts。
 */
export { DndProvider, useDnd, type DndProviderProps, type DragData } from './DndProvider';
export { useDraggable, type DraggableOptions } from './useDraggable';
export { useDroppable, type DroppableOptions } from './useDroppable';
export { InsertionIndicator, type InsertionIndicatorProps } from './insertion-indicator';

export {
  computeInsertion,
  INSIDE_MARGIN,
  type CollisionInput,
  type CollisionTarget,
  type DragResolution,
  type InsertionPosition,
} from './collision';

export {
  snapToGrid,
  computeSnap,
  SNAP_THRESHOLD,
  type SnapOptions,
  type SnapResult,
} from './snapping';

export {
  LAYOUT_MODES,
  layoutModeOf,
  insertIndexFor,
  convertLayout,
  type LayoutMode,
  type InsertIndexOptions,
} from './layout-modes';
