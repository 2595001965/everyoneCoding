/**
 * 图层树（T3-06）对外 API。
 * 主会话据此在 packages/designer/src/index.ts 接线。
 */
export { LayerTree } from './LayerTree';
export type { LayerTreeProps } from './LayerTree';
export { LayerNode } from './LayerNode';
export type { LayerNodeProps } from './LayerNode';
export { useLayerDnd, resolveDrop, rowIdFromEvent } from './useLayerDnd';
export type { DropResolution, LayerDnd, LayerDndState } from './useLayerDnd';
