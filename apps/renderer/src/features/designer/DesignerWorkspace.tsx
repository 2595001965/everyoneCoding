import { useMemo, useState, type ReactNode } from 'react';

import { Badge, Button, EmptyState, Select, Tag, Tooltip } from '@ec/ui';

import {
  BreakpointBar,
  Canvas,
  ConsistencyPanel,
  DndProvider,
  InsertionIndicator,
  Inspector,
  LayerTree,
  PageTree,
  StatePanel,
  Timeline,
  BUILTIN_COMPONENT_METAS,
  COMPONENT_GROUPS,
  DEVICE_PRESETS,
  createEditorStore,
  createRandomIdFactory,
  findPreset,
  findById,
  GRID_SIZE,
  HistoryStore,
  registerBuiltinComponents,
  componentRegistry,
  useDnd,
  useDesignerStore,
  useEditorState,
  type Breakpoint,
  type ComponentGroup,
  type DevicePreset,
  type ElementNode,
} from '@ec/designer';

/**
 * 设计器工作区（Wave 3 的应用层组合）。
 *
 * 三栏布局：
 * - 左：组件面板 + 图层树 + 页面树
 * - 中：画布（多端视口 / 缩放 / 栅格 / 安全区 / 插入指示线）
 * - 右：属性面板 / 页面状态 / 历史时间轴 / 多端一致性
 *
 * 依赖注入：设计器领域层只认端口（`DesignerPorts`），本轮由外壳装配
 * （记忆、AI、文件持久化属于 Wave 9/10 的装配工作），未注入时各面板展示引导而不是崩溃。
 */

/** 内置组件在首次渲染前注册（模块级幂等） */
function ensureComponents(): void {
  registerBuiltinComponents(componentRegistry);
}

type RightTab = 'inspector' | 'state' | 'history' | 'consistency';
type LeftTab = 'components' | 'layers' | 'pages';

export function DesignerWorkspace(): JSX.Element {
  ensureComponents();

  const store = useDesignerStore();
  const dsl = useEditorState((s) => s.dsl);
  const selectedIds = useEditorState((s) => s.selectedIds);
  const hoveredId = useEditorState((s) => s.hoveredId);
  const undoState = useEditorState((s) => s.undoState);

  const [preset, setPreset] = useState<DevicePreset>(() => findPreset('web-1440') as DevicePreset);
  const [gridEnabled, setGridEnabled] = useState(true);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(1440);
  const [leftTab, setLeftTab] = useState<LeftTab>('components');
  const [rightTab, setRightTab] = useState<RightTab>('inspector');
  const [history] = useState(() => new HistoryStore());
  const [snapshots, setSnapshots] = useState(() => history.list());

  const presetOptions = useMemo(
    () => DEVICE_PRESETS.map((item) => ({ value: item.id, label: `${item.label}` })),
    [],
  );

  const onSelectPreset = (id: string): void => {
    const found = findPreset(id);
    if (found !== null) setPreset(found);
  };

  /** 一次拖拽 = 一步 undo：提交由拖拽总线负责，这里只提供插入指示线数据 */
  const canvasOverlays = <DragOverlays />;

  return (
    <DndProvider acceptsChildren={(type) => componentRegistry.acceptsChildren(type)}>
      <div
        className="ec-designer"
        data-testid="designer-workspace"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6, padding: 8 }}
      >
        {/* --------------------------- 工具栏 --------------------------- */}
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>{dsl.name}</strong>
          <Badge>{dsl.platform}</Badge>
          <Tag color="info">{dsl.route}</Tag>
          <Select
            aria-label="目标端与机型"
            size="sm"
            value={preset.id}
            options={presetOptions}
            onChange={onSelectPreset}
          />
          <BreakpointBar
            value={breakpoint}
            onChange={setBreakpoint}
            page={dsl}
            elementId={selectedIds[0] ?? null}
            onChangePage={(next) => store.getState().loadDsl(next)}
          />
          <span style={{ flex: 1 }} />
          <Tooltip content={gridEnabled ? '关闭 8px 栅格' : '开启 8px 栅格'}>
            <Button
              size="sm"
              variant={gridEnabled ? 'primary' : 'ghost'}
              aria-label="切换栅格"
              onClick={() => setGridEnabled((value) => !value)}
            >
              栅格
            </Button>
          </Tooltip>
          <Tooltip
            content={
              undoState.undoLabel !== null ? `撤销：${undoState.undoLabel}` : '没有可撤销的操作'
            }
          >
            <Button
              size="sm"
              variant="ghost"
              aria-label="撤销"
              disabled={!undoState.canUndo}
              onClick={() => store.getState().undo()}
            >
              撤销
            </Button>
          </Tooltip>
          <Tooltip
            content={
              undoState.redoLabel !== null ? `重做：${undoState.redoLabel}` : '没有可重做的操作'
            }
          >
            <Button
              size="sm"
              variant="ghost"
              aria-label="重做"
              disabled={!undoState.canRedo}
              onClick={() => store.getState().redo()}
            >
              重做
            </Button>
          </Tooltip>
          <Button
            size="sm"
            variant="secondary"
            data-testid="capture-snapshot"
            onClick={() => {
              history.capture({ dsl: store.getState().dsl, reason: 'manual', label: '手动快照' });
              setSnapshots(history.list());
              setRightTab('history');
            }}
          >
            存档
          </Button>
        </header>

        {/* ---------------------------- 主体 ---------------------------- */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 8 }}>
          {/* 左栏 */}
          <aside
            data-testid="designer-left"
            style={{
              width: 220,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              border: '1px solid var(--ec-color-border)',
              borderRadius: 6,
              padding: 8,
              overflow: 'auto',
            }}
          >
            <div role="tablist" aria-label="左栏面板" style={{ display: 'flex', gap: 4 }}>
              {(
                [
                  ['components', '组件'],
                  ['layers', '图层'],
                  ['pages', '页面'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={leftTab === id}
                  data-testid={`left-tab-${id}`}
                  onClick={() => setLeftTab(id)}
                  style={{
                    flex: 1,
                    padding: '4px 0',
                    fontSize: 12,
                    cursor: 'pointer',
                    color: 'var(--ec-color-text)',
                    border: '1px solid var(--ec-color-border)',
                    borderRadius: 4,
                    background:
                      leftTab === id ? 'var(--ec-color-bg-muted)' : 'var(--ec-color-surface)',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {leftTab === 'components' && <ComponentPanel />}
            {leftTab === 'layers' && <LayerTree height={420} />}
            {leftTab === 'pages' && <PageTree height={520} />}
          </aside>

          {/* 中栏：画布 */}
          <main
            data-testid="designer-center"
            style={{
              flex: 1,
              minWidth: 0,
              border: '1px solid var(--ec-color-border)',
              borderRadius: 6,
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <Canvas
              dsl={dsl}
              preset={preset}
              showGrid={gridEnabled}
              selectedIds={selectedIds}
              hoveredId={hoveredId}
              onSelect={(ids, mode) => store.getState().select(ids, { mode: mode ?? 'replace' })}
              onHover={(id) => store.getState().setHovered(id)}
              overlays={canvasOverlays}
              renderElement={(node, children) => (
                <CanvasElement node={node} mode="design">
                  {children}
                </CanvasElement>
              )}
            />
          </main>

          {/* 右栏 */}
          <aside
            data-testid="designer-right"
            style={{
              width: 280,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              border: '1px solid var(--ec-color-border)',
              borderRadius: 6,
              padding: 8,
              overflow: 'auto',
            }}
          >
            <div role="tablist" aria-label="右栏面板" style={{ display: 'flex', gap: 4 }}>
              {(
                [
                  ['inspector', '属性'],
                  ['state', '状态'],
                  ['history', '历史'],
                  ['consistency', '一致性'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={rightTab === id}
                  data-testid={`right-tab-${id}`}
                  onClick={() => setRightTab(id)}
                  style={{
                    flex: 1,
                    padding: '4px 0',
                    fontSize: 12,
                    cursor: 'pointer',
                    color: 'var(--ec-color-text)',
                    border: '1px solid var(--ec-color-border)',
                    borderRadius: 4,
                    background:
                      rightTab === id ? 'var(--ec-color-bg-muted)' : 'var(--ec-color-surface)',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {rightTab === 'inspector' && <Inspector store={store} />}
            {rightTab === 'state' && <StatePanel />}
            {rightTab === 'history' && (
              <Timeline
                snapshots={snapshots}
                onPreview={(id) => history.materialize(id)}
                onRollback={(id) => {
                  const restored = history.rollback(id, { currentDsl: store.getState().dsl });
                  if (restored !== null) store.getState().loadDsl(restored);
                  setSnapshots(history.list());
                }}
              />
            )}
            {rightTab === 'consistency' && (
              <ConsistencyPanel
                pages={[dsl]}
                targetPlatforms={[
                  'web',
                  'android',
                  'ios',
                  'harmonyos',
                  'windows',
                  'linux',
                  'macos',
                ]}
              />
            )}
          </aside>
        </div>

        <footer style={{ fontSize: 12, opacity: 0.65 }}>
          {`元素 ${countElements(dsl.tree)} 个 · 栅格 ${GRID_SIZE}px · 已选 ${selectedIds.length} 个`}
        </footer>
      </div>
    </DndProvider>
  );
}

/** 拖拽插入指示（消费 dnd 总线解析结果） */
function DragOverlays(): JSX.Element | null {
  const dnd = useDnd();
  const store = useDesignerStore();
  const resolution = dnd.resolution;
  if (resolution === null || resolution.kind !== 'insert') return null;
  const target = findById(store.getState().dsl.tree, resolution.parentId);
  if (target === null) return null;
  const style = (target.style ?? {}) as Record<string, number | undefined>;
  return (
    <InsertionIndicator
      resolution={resolution}
      targetRect={{
        x: style.left ?? 0,
        y: style.top ?? 0,
        width: style.width ?? 120,
        height: style.height ?? 24,
      }}
      axis={(target.style?.['flexDirection'] === 'row' ? 'x' : 'y') as 'x' | 'y'}
    />
  );
}

/** 组件面板：按分组列出注册表里的组件，点击即在根容器下追加一个实例 */
function ComponentPanel(): JSX.Element {
  const store = useDesignerStore();
  const newId = createRandomIdFactory('el');

  const add = (type: string): void => {
    const meta = componentRegistry.get(type);
    const element: ElementNode = {
      id: newId(),
      type,
      name: meta?.displayName ?? type,
      ...(meta !== null && Object.keys(meta.defaultProps).length > 0
        ? { props: { ...meta.defaultProps } }
        : {}),
      ...(meta !== null && Object.keys(meta.defaultStyle).length > 0
        ? { style: { ...meta.defaultStyle } }
        : {}),
    };
    store.getState().insertElement(store.getState().dsl.tree.id, element, {
      label: `拖入${meta?.displayName ?? type}`,
    });
  };

  const groups = useMemo(() => {
    const map = new Map<ComponentGroup, typeof BUILTIN_COMPONENT_METAS>();
    for (const meta of BUILTIN_COMPONENT_METAS) {
      const list = map.get(meta.group) ?? [];
      list.push(meta);
      map.set(meta.group, list);
    }
    return COMPONENT_GROUPS.map((group) => ({ group, items: map.get(group) ?? [] })).filter(
      (item) => item.items.length > 0,
    );
  }, []);

  return (
    <div
      className="ec-component-palette"
      data-testid="component-palette"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {groups.map(({ group, items }) => (
        <section key={group} data-group={group}>
          <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>{group}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {items.map((meta) => (
              <Tooltip key={meta.type} content={meta.description ?? meta.displayName}>
                <button
                  type="button"
                  data-testid={`palette-item-${meta.type}`}
                  onClick={() => add(meta.type)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '4px 8px',
                    fontSize: 12,
                    border: '1px solid var(--ec-color-border)',
                    borderRadius: 4,
                    background: 'var(--ec-color-surface)',
                    cursor: 'pointer',
                    color: 'var(--ec-color-text)',
                  }}
                >
                  {meta.displayName}
                </button>
              </Tooltip>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** 画布内元素渲染：设计态展示中文占位与类型，避免与最终产物样式混淆 */
function CanvasElement({
  node,
  mode,
  children,
}: {
  node: ElementNode;
  mode: 'design' | 'preview';
  children: ReactNode;
}): JSX.Element {
  const meta = componentRegistry.get(node.type);
  const label = node.name ?? meta?.displayName ?? node.type;
  return (
    <div
      data-canvas-element={node.type}
      data-canvas-mode={mode}
      style={{ minWidth: 8, minHeight: 8 }}
    >
      <span style={{ display: 'block', fontSize: 11, color: '#868e96', pointerEvents: 'none' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function countElements(root: ElementNode): number {
  let total = 0;
  const stack: ElementNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ElementNode;
    total += 1;
    for (const child of node.children ?? []) stack.push(child);
  }
  return total;
}

/** 供外部（页面壳）创建带初始 DSL 的 store */
export function createDesignerStoreWith(
  initial: Parameters<typeof createEditorStore>[0],
): ReturnType<typeof createEditorStore> {
  return createEditorStore(initial);
}

/** 空态：没有打开任何页面时展示引导 */
export function DesignerEmptyState(): JSX.Element {
  return (
    <div style={{ padding: 24 }}>
      <EmptyState
        title="还没有打开页面"
        description="请在工作台新建或打开一个项目后再进入设计器。"
      />
    </div>
  );
}
