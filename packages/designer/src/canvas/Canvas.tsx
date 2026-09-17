/**
 * 画布（T3-02 要点 3）。
 *
 * 用 DOM + CSS Transform 渲染组件树（非 canvas 2D 绘制）：缩放走 `transform: scale()`，
 * 平移走 translate。渲染层按 `ElementNode.style` 生成内联样式；未知组件由 `renderElement`
 * 缺省渲染占位框（画布不 import 组件注册表，避免循环依赖，注册表由主会话通过
 * `renderElement` 注入）。
 *
 * 性能：每个元素用 `React.memo` 包裹；缩放 / 平移只改变表面层的 transform，
 * 元素节点 props 不变则不重渲染（见 ElementView）。拖拽期间由调用方把被拖元素提到
 * 独立层（DragOverlay），进一步避免整树重渲染。
 */
import * as React from 'react';
import { Button, Tooltip, cx } from '@ec/ui';
import type { ElementNode, PageDsl } from '../dsl/types';
import { clampZoom, zoomAtPoint } from './coordinate';
import { SafeAreaOverlay } from './SafeArea';
import { Ruler } from './Ruler';
import { ZoomControl } from './ZoomControl';
import { Viewport } from './Viewport';
import { SelectionBox, selectInRect } from './SelectionBox';
import { GRID_SIZE, type AlignmentGuide } from './GridOverlay';
import type { DevicePreset } from './device-presets';
import type { Rect } from './coordinate';

export type SelectionMode = 'replace' | 'add' | 'toggle';

/** 默认渲染：未知组件占位框（主会话可注入真实渲染器） */
function defaultRenderElement(node: ElementNode, children: React.ReactNode): React.ReactNode {
  return (
    <div className="ec-canvas__placeholder" data-component={node.type} style={{ minHeight: 12 }}>
      <span className="ec-canvas__placeholder-label">{node.name ?? node.type}</span>
      {children}
    </div>
  );
}

// ---- 性能基准用渲染计数（仅供 benchmark.test.ts 读取） ----
let __elementRenderCount = 0;
/** 读取元素节点累计渲染次数 */
export function getElementRenderCount(): number {
  return __elementRenderCount;
}
/** 重置渲染计数 */
export function resetElementRenderCount(): void {
  __elementRenderCount = 0;
}

/** 叶子节点的 children 常量：保持引用稳定，叶子组件才能命中 memo 短路 */
const EMPTY_CHILDREN: React.ReactNode = null;

interface ElementViewProps {
  node: ElementNode;
  /** 本节点是否选中（布尔值而非集合：memo 浅比较即可判定，避免整树重渲染） */
  selected: boolean;
  /** 本节点是否 hover */
  hovered: boolean;
  /** 已渲染的子节点；无子节点时为常量 EMPTY_CHILDREN */
  childrenContent: React.ReactNode;
  renderElement: (node: ElementNode, children: React.ReactNode) => React.ReactNode;
  onSelect?: ((id: string, mode: SelectionMode) => void) | undefined;
  onHover?: ((id: string | null) => void) | undefined;
  register?: ((id: string, node: HTMLElement | null) => void) | undefined;
}

/** 渲染上下文（构建整棵元素树时传递，不参与 memo 比较） */
interface ElementRenderContext {
  selectedIds: ReadonlySet<string>;
  hoveredId: string | null;
  renderElement: (node: ElementNode, children: React.ReactNode) => React.ReactNode;
  onSelect?: ((id: string, mode: SelectionMode) => void) | undefined;
  onHover?: ((id: string | null) => void) | undefined;
  register?: ((id: string, node: HTMLElement | null) => void) | undefined;
}

/**
 * 自顶向下构建元素树（普通函数，不是组件）。
 *
 * 为什么要"构建整棵树"而不是"由组件递归渲染子节点"：
 * - 若由组件递归，父组件一旦被 memo 短路，其子节点就再也收不到新的 props（选中态无法下传）；
 * - 改为在 useMemo 中按 (dsl.tree, zoom, selection) 一次性构建，父节点因为 childrenContent
 *   引用变化而必然重渲染并向下 reconcile，而**叶子节点**的 childrenContent 是常量，
 *   memo 浅比较直接命中，只有自身选中/hover 变化的节点才真正执行渲染函数。
 * 于是"选中 1 个元素"= 重渲染 1~2 个节点，而不是整棵树（500 元素场景的关键）。
 */
function buildElementTree(
  node: ElementNode,
  context: ElementRenderContext,
): React.ReactElement | null {
  if (node.hidden === true) return null;
  const children = node.children;
  const childrenContent: React.ReactNode =
    children !== undefined && children.length > 0
      ? children.map((child) => buildElementTree(child, context))
      : EMPTY_CHILDREN;

  return (
    <ElementView
      key={node.id}
      node={node}
      selected={context.selectedIds.has(node.id)}
      hovered={context.hoveredId === node.id}
      childrenContent={childrenContent}
      renderElement={context.renderElement}
      onSelect={context.onSelect}
      onHover={context.onHover}
      register={context.register}
    />
  );
}

const ElementView = React.memo(function ElementView({
  node,
  selected,
  hovered,
  childrenContent,
  renderElement,
  onSelect,
  onHover,
  register,
}: ElementViewProps): React.ReactElement | null {
  __elementRenderCount += 1;

  if (node.hidden === true) return null;
  const locked = node.locked === true;

  const baseStyle = node.style as React.CSSProperties;
  const style: React.CSSProperties = {
    boxSizing: 'border-box',
    ...baseStyle,
    outline: selected
      ? `2px solid var(--ec-accent, #2f6bff)`
      : hovered
        ? `1px solid var(--ec-accent-soft, #7aa2ff)`
        : locked
          ? `1px dashed var(--ec-danger, #e5484d)`
          : undefined,
    outlineOffset: 1,
    ...(locked ? { pointerEvents: 'none' } : {}),
  };

  const handleSelect = (e: React.MouseEvent): void => {
    if (locked) return;
    e.stopPropagation();
    const mode: SelectionMode = e.shiftKey || e.metaKey || e.ctrlKey ? 'add' : 'replace';
    onSelect?.(node.id, mode);
  };

  return (
    <div
      ref={register ? (el) => register(node.id, el) : undefined}
      data-element-id={node.id}
      data-testid={`element-${node.id}`}
      data-locked={locked ? 'true' : undefined}
      style={style}
      onClick={handleSelect}
      onMouseEnter={onHover ? () => onHover(node.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      {renderElement(node, childrenContent)}
    </div>
  );
});

export interface CanvasProps {
  dsl: PageDsl;
  preset?: DevicePreset;
  /** 受控缩放；缺省内部状态 */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  /** 受控平移；缺省内部状态 */
  pan?: { x: number; y: number };
  onPanChange?: (pan: { x: number; y: number }) => void;
  showGrid?: boolean;
  onToggleGrid?: (visible: boolean) => void;
  selectedIds?: string[];
  hoveredId?: string | null;
  onSelect?: (ids: string[], mode?: SelectionMode) => void;
  onHover?: (id: string | null) => void;
  /** 对齐参考线（画布坐标系） */
  alignGuides?: AlignmentGuide[];
  /** 拖拽插入指示等附加叠加层 */
  overlays?: React.ReactNode;
  renderElement?: (node: ElementNode, children: React.ReactNode) => React.ReactNode;
  className?: string;
}

/** 受控 / 非受控状态小工具 */
function useControlled<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (v: T) => void,
): [T, (v: T) => void] {
  const [internal, setInternal] = React.useState<T>(value ?? defaultValue);
  const current = value !== undefined ? value : internal;
  const set = React.useCallback(
    (v: T) => {
      if (value === undefined) setInternal(v);
      onChange?.(v);
    },
    [value, onChange],
  );
  return [current, set];
}

/**
 * 画布组件：缩放 / 平移 / 框选 / 对齐参考线 / 安全区 / 标尺 / 缩放控制。
 * 不持有文档状态，所有交互通过回调上抛（选中、悬浮、缩放、平移）。
 */
export function Canvas({
  dsl,
  preset,
  zoom: zoomProp,
  onZoomChange,
  pan: panProp,
  onPanChange,
  showGrid: showGridProp,
  onToggleGrid,
  selectedIds = [],
  hoveredId = null,
  onSelect,
  onHover,
  alignGuides = [],
  overlays,
  renderElement,
  className,
}: CanvasProps): React.ReactElement {
  const [zoom, setZoom] = useControlled(zoomProp, 1, onZoomChange);
  const [pan, setPan] = useControlled(panProp, { x: 0, y: 0 }, onPanChange);
  const [showGrid, setShowGrid] = useControlled(showGridProp, true, onToggleGrid);

  const frameRef = React.useRef<HTMLDivElement>(null);
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const elementNodes = React.useRef<Map<string, HTMLElement>>(new Map());

  const [spaceDown, setSpaceDown] = React.useState(false);
  const [marquee, setMarquee] = React.useState<Rect | null>(null);
  const panState = React.useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const marqueeState = React.useRef<{ startX: number; startY: number } | null>(null);

  const render = React.useCallback(
    (node: ElementNode, children: React.ReactNode) =>
      (renderElement ?? defaultRenderElement)(node, children),
    [renderElement],
  );

  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds]);

  const width = preset?.width ?? dsl.viewport.width;
  const height = preset?.height ?? dsl.viewport.height;

  const clientToCanvas = React.useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const surface = surfaceRef.current;
      if (!surface) return { x: 0, y: 0 };
      const rect = surface.getBoundingClientRect();
      return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
    },
    [zoom],
  );

  // ---- 缩放（Ctrl+滚轮，以指针为锚点） ----
  const handleWheel = (e: React.WheelEvent): void => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const frame = frameRef.current;
    if (!frame) return;
    const frameRect = frame.getBoundingClientRect();
    const pointer = { x: e.clientX - frameRect.left, y: e.clientY - frameRect.top };
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = clampZoom(zoom * factor);
    const nextPan = zoomAtPoint(zoom, next, pointer, pan, { x: 0, y: 0 });
    setPan(nextPan);
    setZoom(next);
  };

  // ---- 平移（空格拖拽 / 中键拖拽）或框选 ----
  const handlePointerDown = (e: React.PointerEvent): void => {
    const isPan = spaceDown || e.button === 1;
    const onBackground = !(e.target as HTMLElement).closest('[data-element-id]');
    if (isPan) {
      e.preventDefault();
      panState.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } else if (onBackground) {
      const p = clientToCanvas(e.clientX, e.clientY);
      marqueeState.current = { startX: p.x, startY: p.y };
      setMarquee({ x: p.x, y: p.y, width: 0, height: 0 });
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent): void => {
    if (panState.current) {
      const { startX, startY, panX, panY } = panState.current;
      setPan({ x: panX + (e.clientX - startX), y: panY + (e.clientY - startY) });
    } else if (marqueeState.current) {
      const p = clientToCanvas(e.clientX, e.clientY);
      const { startX, startY } = marqueeState.current;
      setMarquee({
        x: Math.min(startX, p.x),
        y: Math.min(startY, p.y),
        width: Math.abs(p.x - startX),
        height: Math.abs(p.y - startY),
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent): void => {
    if (panState.current) {
      panState.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      return;
    }
    if (marqueeState.current && marquee) {
      const surface = surfaceRef.current;
      const els: { id: string; rect: Rect }[] = [];
      if (surface) {
        const sRect = surface.getBoundingClientRect();
        elementNodes.current.forEach((node, id) => {
          const r = node.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          els.push({
            id,
            rect: {
              x: (r.left - sRect.left) / zoom,
              y: (r.top - sRect.top) / zoom,
              width: r.width / zoom,
              height: r.height / zoom,
            },
          });
        });
      }
      const ids = selectInRect(els, marquee);
      onSelect?.(ids, 'replace');
    }
    marqueeState.current = null;
    setMarquee(null);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // ---- 适应窗口 / 100% ----
  const fit = React.useCallback((): void => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const z = clampZoom(Math.min((rect.width - 40) / width, (rect.height - 40) / height));
    setZoom(z);
    setPan({ x: (rect.width - width * z) / 2, y: (rect.height - height * z) / 2 });
  }, [width, height, setZoom, setPan]);

  const reset = React.useCallback((): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [setZoom, setPan]);

  const registerNode = React.useCallback((id: string, node: HTMLElement | null) => {
    if (node) elementNodes.current.set(id, node);
    else elementNodes.current.delete(id);
  }, []);

  const handleElementSelect = React.useCallback(
    (id: string, mode: SelectionMode): void => {
      onSelect?.([id], mode);
    },
    [onSelect],
  );

  const tree = React.useMemo(
    () =>
      buildElementTree(dsl.tree, {
        selectedIds: selectedSet,
        hoveredId,
        renderElement: render,
        onSelect: handleElementSelect,
        onHover,
        register: registerNode,
      }),
    [dsl.tree, selectedSet, hoveredId, render, registerNode, handleElementSelect, onHover],
  );

  const guideOverlays = alignGuides.map((guide, i) =>
    guide.axis === 'x' ? (
      <div
        key={`guide-x-${i}`}
        data-testid="align-guide"
        style={{
          position: 'absolute',
          left: guide.position,
          top: 0,
          bottom: 0,
          width: 1,
          background: 'var(--ec-accent, #2f6bff)',
          pointerEvents: 'none',
          zIndex: 8,
        }}
      />
    ) : (
      <div
        key={`guide-y-${i}`}
        data-testid="align-guide"
        style={{
          position: 'absolute',
          top: guide.position,
          left: 0,
          right: 0,
          height: 1,
          background: 'var(--ec-accent, #2f6bff)',
          pointerEvents: 'none',
          zIndex: 8,
        }}
      />
    ),
  );

  return (
    <div
      ref={frameRef}
      data-testid="canvas"
      className={cx('ec-canvas', className)}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: '#fafafa',
      }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onKeyDown={(e) => {
        if (e.code === 'Space') setSpaceDown(true);
      }}
      onKeyUp={(e) => {
        if (e.code === 'Space') setSpaceDown(false);
      }}
    >
      <Ruler orientation="x" zoom={zoom} length={width} offset={pan.x} />
      <Ruler orientation="y" zoom={zoom} length={height} offset={pan.y} />

      <div style={{ position: 'absolute', top: 18, left: 18, right: 0, bottom: 0 }}>
        <Viewport
          zoom={zoom}
          pan={pan}
          width={width}
          height={height}
          showGrid={showGrid}
          surfaceRef={surfaceRef}
        >
          {tree}
          <SafeAreaOverlay preset={preset} zoom={zoom} />
          {guideOverlays}
          {overlays}
          {marquee && <SelectionBox rect={marquee} variant="marquee" testId="marquee-box" />}
        </Viewport>
      </div>

      <div
        style={{
          position: 'absolute',
          top: 22,
          right: 12,
          zIndex: 20,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: 6,
          borderRadius: 8,
          border: '1px solid var(--ec-color-border)',
          background: 'var(--ec-color-surface)',
          color: 'var(--ec-color-text)',
          boxShadow: 'var(--ec-shadow-sm)',
          maxWidth: 'calc(100% - 24px)',
        }}
      >
        <Tooltip content={showGrid ? '关闭栅格' : '开启栅格'}>
          <Button
            aria-label={showGrid ? '关闭栅格' : '开启栅格'}
            variant={showGrid ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setShowGrid(!showGrid)}
          >
            栅格
          </Button>
        </Tooltip>
        <ZoomControl zoom={zoom} onZoomChange={setZoom} onFit={fit} onReset={reset} />
      </div>
      <span data-testid="canvas-grid-size" className="ec-sr-only">
        {`栅格尺寸 ${GRID_SIZE} 像素`}
      </span>
    </div>
  );
}
