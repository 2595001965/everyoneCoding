/**
 * 画布引擎（T3-02）公共 API。
 * 主会话通过本桶文件接线 src/index.ts。
 */
export { Canvas, type CanvasProps } from './Canvas';
/** 画布用别名：与 store 的 `SelectionMode` 语义相同，导出时做区分避免歧义 */
export type { SelectionMode as CanvasSelectionMode } from './Canvas';
export { getElementRenderCount, resetElementRenderCount } from './Canvas';

export { Viewport, type ViewportProps } from './Viewport';

export { Ruler, type RulerProps } from './Ruler';

export { GridOverlay, GRID_SIZE, type GridOverlayProps, type AlignmentGuide } from './GridOverlay';

export { SafeAreaOverlay, type SafeAreaOverlayProps } from './SafeArea';

export {
  SelectionBox,
  rectsIntersect,
  selectInRect,
  normalizeRect,
  type SelectionBoxProps,
  type SelectionVariant,
} from './SelectionBox';

export { ZoomControl, type ZoomControlProps } from './ZoomControl';

export {
  createCoordinateSpace,
  clampZoom,
  zoomAtPoint,
  ZOOM_MIN,
  ZOOM_MAX,
  type Point,
  type Rect,
  type CoordinateSpace,
  type CoordinateSpaceConfig,
} from './coordinate';

export {
  DEVICE_PRESETS,
  presetsForPlatform,
  findPreset,
  defaultPresetFor,
  safeAreaOf,
  foldableStates,
  canvasSizeOf,
  contentBoxOf,
  breakpointLabel,
  type DevicePreset,
  type SafeArea,
  type WindowChrome,
  type FoldableState,
} from './device-presets';
