/**
 * @ec/designer —— PageDSL、画布、组件库、属性面板（Wave 3 全量交付）。
 *
 * 分层：
 * - `dsl`：页面 DSL 领域模型、校验、遍历、原子持久化与版本迁移（T3-01）
 * - `store`：编辑器内核（文档 + 选中态 + 撤销栈）与依赖注入端口（T3-01~T3-11 共享）
 * - `shared`：跨模块契约（结构化条件、路径表达式、数据源目录）
 * - `registry` / `components`：组件库与属性 JSON Schema（T3-04）
 * - `canvas` / `dnd`：画布引擎与拖拽布局（T3-02 / T3-03）
 * - `inspector`：属性面板六分区（T3-05）
 * - `layers` / `pages`：图层树与多页面路由（T3-06 / T3-07）
 * - `state` / `flow`：页面状态与动作流（T3-08 / T3-09）
 * - `history`：设计稿快照与结构化 diff（T3-10）
 * - `ai` / `master` / `responsive` / `consistency`：AI 生成、母版、响应式、多端一致性（T3-11）
 *
 * 约束：跨包引用只允许通过本单一入口，禁止深路径导入。
 * 硬约束：AI 是代码与数据库脚本的唯一写入口，设计器只产出结构化 DSL，不写代码。
 */

/* ------------------------------- DSL 领域层 ------------------------------- */
export * from './dsl/types';
export * from './dsl/identifier';
export * from './dsl/factory';
export * from './dsl/traverse';
export * from './dsl/schema';
export * from './dsl/serialize';
export * from './dsl/version';

/* ------------------------------ 跨模块契约 ------------------------------ */
export * from './shared/expression';
export * from './shared/condition';
export * from './shared/data-source';

/* ------------------------------- 编辑器内核 ------------------------------- */
export * from './store/draft-tree';
export * from './store/editor-store';
export * from './store/ports';
export * from './store/designer-context';

/* ------------------------------ 组件库与注册表 ------------------------------ */
export * from './registry';
export * from './components';

/* ------------------------------- 画布与拖拽 ------------------------------- */
/*
 * canvas 与 store 都导出 `SelectionMode`（语义相同：replace/add/toggle），
 * 这里显式逐个导出并给画布版本加别名，避免 `export *` 产生歧义。
 */
export {
  Canvas,
  Viewport,
  Ruler,
  GridOverlay,
  GRID_SIZE,
  SafeAreaOverlay,
  SelectionBox,
  ZoomControl,
  createCoordinateSpace,
  clampZoom,
  zoomAtPoint,
  ZOOM_MIN,
  ZOOM_MAX,
  rectsIntersect,
  normalizeRect,
  selectInRect,
  DEVICE_PRESETS,
  presetsForPlatform,
  findPreset,
  defaultPresetFor,
  safeAreaOf,
  foldableStates,
  canvasSizeOf,
  contentBoxOf,
  breakpointLabel,
  getElementRenderCount,
  resetElementRenderCount,
  type CanvasProps,
  type CanvasSelectionMode,
  type ViewportProps,
  type RulerProps,
  type GridOverlayProps,
  type AlignmentGuide,
  type SafeAreaOverlayProps,
  type SelectionBoxProps,
  type SelectionVariant,
  type ZoomControlProps,
  type Point,
  type Rect,
  type CoordinateSpace,
  type CoordinateSpaceConfig,
  type DevicePreset,
  type SafeArea,
  type WindowChrome,
  type FoldableState,
} from './canvas';

export * from './dnd';

/* -------------------------------- 属性面板 -------------------------------- */
export * from './inspector';

/* ---------------------------- 图层树与多页面路由 ---------------------------- */
export * from './layers';
export * from './pages';

/* ------------------------- 备注与批注（T4-01） ------------------------- */
export * from './notes';

/* ----------------------------- 状态与动作流 ----------------------------- */
export * from './state';
export * from './flow';

/* ------------------------------ 快照与历史 ------------------------------ */
export * from './history';

/* ------------------- AI 生成 / 母版 / 响应式 / 多端一致性 ------------------- */
export * from './ai';
export * from './master';
export * from './responsive';
export * from './consistency';
