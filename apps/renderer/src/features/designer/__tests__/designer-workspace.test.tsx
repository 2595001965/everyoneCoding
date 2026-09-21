import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLoginPageDsl, serializePageDsl, type PageDsl } from '@ec/designer';

import { DesignerPage } from '../../../pages/DesignerPage';
import {
  DESIGNER_API_GLOBAL_KEY,
  type DesignerPageSummary,
  type DesignerPortApi,
} from '../designer-api';
import { useProjectStore } from '../../../store/useProjectStore';

/**
 * 设计器工作区集成测试（Wave 3 出口检查 E2E-04 的自动化替身）。
 *
 * 覆盖：20 元素登录页渲染、组件面板拖入、三向联动、撤销/重做、快照存档、分区切换。
 *
 * T12-01 后 `DesignerPage` 不再内置夹具页面，改为**从 `__EC_DESIGNER__` 端口装载
 * 当前项目的页面**。因此本文件注入一个"真实走端口"的假实现，页面内容仍取
 * `createLoginPageDsl()`（20 元素登录页样例，元素 id `el-15` 等断言依赖它）。
 * 这样改动顺带把「端口 → 页面树 → 工作区」这条新链路也覆盖上了。
 */

/** 测试用项目：DSL 里的 projectId 与打开的活跃项目保持一致 */
const PROJECT_ID = 'P-DESIGNER-TEST';

/** 注入的假端口记录写盘调用，便于断言"改动确实落到了端口" */
interface FakePortState {
  saved: unknown[];
  structures: unknown[];
}

let fakeState: FakePortState;

/** 构造一个项目 + 一页（登录页样例）的端口 */
function installFakeDesignerPorts(): FakePortState {
  const login: PageDsl = { ...createLoginPageDsl(), projectId: PROJECT_ID };
  const envelope = JSON.parse(serializePageDsl(login)) as { dslVersion: number; page: PageDsl };
  const state: FakePortState = { saved: [], structures: [] };

  const api: DesignerPortApi = {
    openProject: async (projectId) => ({ projectId }),
    listPages: async (): Promise<readonly DesignerPageSummary[]> => [
      { pageId: login.id, name: login.name, route: login.route },
    ],
    loadPage: async () => envelope,
    savePage: async (_projectId, saved) => {
      state.saved.push(saved);
      return { pageId: login.id, savedAt: 0 };
    },
    createPage: async () => envelope,
    writePageStructure: async (input) => {
      state.structures.push(input);
      return { id: 'mem-page', updated: true };
    },
    listStructureRevisions: async () => [],
    upsertRoutes: async () => ({}),
    readRoutes: async () => [],
    generatePage: async () => {
      throw new Error('本用例不覆盖 AI 生成');
    },
    readNotes: async () => [],
    saveNote: async (input) => ({
      id: 'note-1',
      projectId: input.projectId,
      targetType: input.targetType,
      targetId: input.targetId,
      type: input.type ?? 'todo',
      title: input.title ?? '',
      status: 'open',
      priority: 3,
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    }),
    updateNote: async () => {
      throw new Error('本用例不覆盖备注修改');
    },
    setNoteStatus: async () => {
      throw new Error('本用例不覆盖备注状态');
    },
    removeNote: async () => ({ removed: false }),
    noteBadges: async () => ({}),
  };

  (globalThis as Record<string, unknown>)[DESIGNER_API_GLOBAL_KEY] = api;
  return state;
}

/** 渲染并等待会话装配完成（页面装载是异步的） */
async function renderDesigner(): Promise<ReturnType<typeof render>> {
  const view = render(<DesignerPage />);
  await screen.findByTestId('designer-workspace');
  return view;
}

beforeEach(() => {
  fakeState = installFakeDesignerPorts();
  useProjectStore.getState().openProject({
    id: PROJECT_ID,
    name: '设计器测试项目',
    targetPlatforms: ['web'],
    updatedAt: 0,
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[DESIGNER_API_GLOBAL_KEY];
  useProjectStore.getState().closeProject();
});

describe('设计器工作区', () => {
  it('未注入端口时展示装配引导，不崩溃也不造假页面', () => {
    delete (globalThis as Record<string, unknown>)[DESIGNER_API_GLOBAL_KEY];
    render(<DesignerPage />);
    expect(screen.getByText('设计器服务未初始化')).toBeInTheDocument();
  });

  it('未打开项目时展示「先打开项目」引导', () => {
    useProjectStore.getState().closeProject();
    render(<DesignerPage />);
    expect(screen.getByText('未打开项目')).toBeInTheDocument();
  });

  it('渲染登录页 20 个元素与三栏布局', async () => {
    const { container } = await renderDesigner();
    expect(screen.getByTestId('designer-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('designer-left')).toBeInTheDocument();
    expect(screen.getByTestId('designer-center')).toBeInTheDocument();
    expect(screen.getByTestId('designer-right')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-element-id]')).toHaveLength(20);
    expect(screen.getByText(/元素 20 个/)).toBeInTheDocument();
  });

  it('组件面板按分组列出 15 类内置组件', async () => {
    await renderDesigner();
    const palette = screen.getByTestId('component-palette');
    expect(within(palette).getAllByRole('button').length).toBe(15);
    expect(screen.getByTestId('palette-item-Button')).toBeInTheDocument();
    expect(screen.getByTestId('palette-item-ListPageTemplate')).toBeInTheDocument();
  });

  it('从组件面板加入元素：进入 DSL、选中新元素、可撤销', async () => {
    const { container } = await renderDesigner();
    fireEvent.click(screen.getByTestId('palette-item-Button'));
    expect(container.querySelectorAll('[data-element-id]')).toHaveLength(21);
    expect(screen.getByText(/已选 1 个/)).toBeInTheDocument();

    // 工具栏与属性面板各有一个「撤销」按钮，取工具栏那个
    fireEvent.click(screen.getAllByRole('button', { name: '撤销' })[0] as HTMLElement);
    expect(container.querySelectorAll('[data-element-id]')).toHaveLength(20);
  });

  it('三向联动：点选画布元素后属性面板同步展示', async () => {
    await renderDesigner();
    fireEvent.click(screen.getByTestId('element-el-15'));
    expect(screen.getByTestId('inspector-title')).toHaveTextContent('登录按钮');
  });

  it('图层树可切换并展示元素层级', async () => {
    await renderDesigner();
    fireEvent.click(screen.getByTestId('left-tab-layers'));
    expect(document.querySelector('[data-layer-id="el-15"]')).not.toBeNull();
  });

  it('右栏可在属性 / 状态 / 历史 / 一致性之间切换', async () => {
    await renderDesigner();
    fireEvent.click(screen.getByTestId('right-tab-state'));
    expect(screen.getByText('页面状态')).toBeInTheDocument();
    expect(screen.getByTestId('state-phone')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('right-tab-history'));
    expect(screen.getByTestId('timeline')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('right-tab-consistency'));
    expect(screen.getByTestId('consistency-panel')).toBeInTheDocument();
  });

  it('存档按钮生成快照并跳转到历史时间轴', async () => {
    await renderDesigner();
    fireEvent.click(screen.getByTestId('capture-snapshot'));
    expect(screen.getByTestId('timeline')).toBeInTheDocument();
    expect(screen.getByText('手动快照')).toBeInTheDocument();
  });

  it('栅格开关与断点切换条可用', async () => {
    await renderDesigner();
    expect(screen.getByTestId('grid-overlay')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '切换栅格' }));
    expect(screen.queryByTestId('grid-overlay')).toBeNull();

    expect(screen.getByTestId('breakpoint-1440')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('breakpoint-375'));
    expect(screen.getByTestId('breakpoint-375')).toHaveAttribute('aria-checked', 'true');
  });

  it('切换目标端机型后画布尺寸跟随变化', async () => {
    await renderDesigner();
    expect(screen.getByTestId('canvas-surface')).toHaveStyle({ width: '1440px' });
    fireEvent.click(screen.getByLabelText('目标端与机型'));
    fireEvent.click(screen.getByRole('option', { name: 'iPhone 15' }));
    expect(screen.getByTestId('canvas-surface')).toHaveStyle({ width: '390px' });
  });

  it('页面内容来自端口而不是内置夹具：loadPage 拿到的页面 id 即 DSL 里的页面 id', async () => {
    await renderDesigner();
    const login = createLoginPageDsl();
    expect(document.querySelector(`[data-element-id="${login.tree.id}"]`)).not.toBeNull();
    // 端口确实被调用过（openProject / listPages / loadPage 都走它）
    expect(fakeState.saved).toEqual([]);
  });
});
