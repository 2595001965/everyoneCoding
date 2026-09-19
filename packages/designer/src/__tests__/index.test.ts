import { describe, expect, it } from 'vitest';

import * as designer from '../index';

/**
 * 公共入口契约测试（T3-01~T3-11 接线验收）。
 *
 * `packages/designer/src/index.ts` 是本包对外的**唯一入口**（禁止深路径导入），
 * 因此这里逐模块抽查关键导出，防止某个模块在重构中被漏出或改名。
 */
describe('@ec/designer 公共入口', () => {
  it('DSL 领域层（T3-01）', () => {
    expect(typeof designer.createLoginPageDsl).toBe('function');
    expect(typeof designer.parsePageDsl).toBe('function');
    expect(typeof designer.checkDslInvariants).toBe('function');
    expect(typeof designer.savePageDsl).toBe('function');
    expect(typeof designer.loadPageDsl).toBe('function');
    expect(typeof designer.toIdentifier).toBe('function');
    expect(typeof designer.findById).toBe('function');
    expect(designer.DSL_VERSION).toBeGreaterThanOrEqual(3);
    expect(designer.PLATFORMS).toHaveLength(7);
  });

  it('编辑器内核与端口（跨任务共享）', () => {
    expect(typeof designer.createEditorStore).toBe('function');
    expect(typeof designer.DesignerProvider).toBe('function');
    expect(typeof designer.useEditorState).toBe('function');
    expect(typeof designer.draftMoveNode).toBe('function');
    expect(designer.EMPTY_PORTS).toEqual({});
  });

  it('跨模块契约（条件 / 路径 / 数据源）', () => {
    expect(typeof designer.evaluateCondition).toBe('function');
    expect(typeof designer.parsePath).toBe('function');
    expect(typeof designer.getDataSources).toBe('function');
    expect(typeof designer.listDataSourcePaths).toBe('function');
  });

  it('组件库与注册表（T3-04）', () => {
    expect(designer.componentRegistry).toBeInstanceOf(designer.ComponentRegistry);
    expect(designer.BUILTIN_COMPONENT_METAS).toHaveLength(15);
    expect(typeof designer.registerBuiltinComponents).toBe('function');
    expect(designer.ICON_SET).toBeTypeOf('object');
    expect(typeof designer.validatePropSchema).toBe('function');
  });

  it('画布与拖拽（T3-02 / T3-03）', () => {
    expect(typeof designer.Canvas).toBe('function');
    expect(typeof designer.createCoordinateSpace).toBe('function');
    expect(typeof designer.DEVICE_PRESETS).toBe('object');
    expect(designer.LAYOUT_MODES).toEqual(['absolute', 'flow']);
    expect(typeof designer.snapToGrid).toBe('function');
    expect(typeof designer.computeInsertion).toBe('function');
    expect(typeof designer.DndProvider).toBe('function');
    expect(designer.GRID_SIZE).toBe(8);
  });

  it('属性面板 / 图层树 / 多页面（T3-05~T3-07）', () => {
    expect(typeof designer.Inspector).toBe('function');
    expect(typeof designer.SchemaForm).toBe('function');
    expect(typeof designer.LayerTree).toBe('function');
    expect(typeof designer.PageTree).toBe('function');
    expect(typeof designer.generateRouteTable).toBe('function');
    expect(typeof designer.createPageFromTemplate).toBe('function');
  });

  it('状态与动作流（T3-08 / T3-09）', () => {
    expect(typeof designer.StateStore).toBe('function');
    expect(typeof designer.StatePanel).toBe('function');
    expect(typeof designer.createFlowRuntime).toBe('function');
    expect(typeof designer.validateFlow).toBe('function');
    expect(typeof designer.serializeFlow).toBe('function');
  });

  it('历史与 AI / 母版 / 响应式 / 一致性（T3-10 / T3-11）', () => {
    expect(typeof designer.HistoryStore).toBe('function');
    expect(typeof designer.createAutoSnapshotScheduler).toBe('function');
    expect(typeof designer.diffTrees).toBe('function');
    expect(typeof designer.Timeline).toBe('function');
    expect(typeof designer.DiffView).toBe('function');
    expect(typeof designer.GeneratePanel).toBe('function');
    expect(typeof designer.dslFromAi).toBe('function');
    expect(typeof designer.MasterRegistry).toBe('function');
    expect(typeof designer.setBreakpointOverride).toBe('function');
    expect(typeof designer.checkConsistency).toBe('function');
  });

  it('端到端串一次：生成 DSL → 校验 → 存快照 → 回放 → 路由表', () => {
    const dsl = designer.createLoginPageDsl();
    expect(designer.parsePageDsl(dsl).id).toBe('login');

    const history = new designer.HistoryStore();
    const first = history.capture({ dsl, reason: 'auto', now: 1 });
    const edited: typeof dsl = {
      ...dsl,
      tree: designer.replaceNode(dsl.tree, 'el-15', (node) => ({
        ...node,
        props: { ...(node.props ?? {}), text: '立即登录' },
      })),
    };
    history.capture({ dsl: edited, reason: 'auto', now: 2 });

    expect(history.size()).toBe(2);
    expect(designer.findById(history.materialize(first.id)!.tree, 'el-15')?.props?.['text']).toBe(
      '登录',
    );
    expect(
      designer.findById(history.materialize(history.list()[1]!.id)!.tree, 'el-15')?.props?.['text'],
    ).toBe('立即登录');

    const routes = designer.generateRouteTable([dsl]);
    expect(routes[0]).toMatchObject({ path: '/login', pageId: 'login' });
  });
});
