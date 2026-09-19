import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createLoginPageDsl, createPageDsl } from '../../dsl/factory';
import type { PageDsl, RouteEntry } from '../../dsl/types';
import { DesignerProvider } from '../../store/designer-context';
import { createEditorStore } from '../../store/editor-store';
import { PageTree } from '../PageTree';
import { RouteGraph } from '../RouteGraph';
import {
  MultiPageProvider,
  MultiPageStore,
  PAGE_TEMPLATES,
  createPageFromTemplate,
} from '../page-store';
import {
  buildRouteEdges,
  detectRouteIssues,
  generateRouteTable,
  normalizePath,
  parseRouteParams,
  patchPageEventAction,
  useRouteMemorySync,
} from '../route-table';

function pagesFixture(): PageDsl[] {
  const login = createLoginPageDsl();
  const dashboard = createPageDsl({
    id: 'dashboard',
    projectId: 'P1',
    name: '仪表盘',
    platform: 'web',
    route: '/dashboard',
  });
  const detail = createPageDsl({
    id: 'user-detail',
    projectId: 'P1',
    name: '用户详情',
    platform: 'web',
    route: '/user/:id',
  });
  const mobile = createPageDsl({
    id: 'm-home',
    projectId: 'P1',
    name: '移动首页',
    platform: 'android',
    route: '/home',
  });
  return [login, dashboard, detail, mobile];
}

describe('T3-07 路由表生成与冲突检测', () => {
  it('由页面 DSL 生成路由总表（路径 / 页面 / 端 / 参数）', () => {
    const entries = generateRouteTable(pagesFixture());
    expect(entries.map((entry) => entry.path)).toEqual([
      '/login',
      '/dashboard',
      '/user/:id',
      '/home',
    ]);
    const detail = entries.find((entry) => entry.pageId === 'user-detail');
    expect(detail?.platform).toBe('web');
    expect(detail?.params).toEqual([{ name: 'id', type: 'string', required: true }]);
  });

  it('解析与规范化路由路径', () => {
    expect(parseRouteParams('/user/:id/post/:postId')).toEqual(['id', 'postId']);
    expect(parseRouteParams('/plain')).toEqual([]);
    expect(normalizePath('user/profile/')).toBe('/user/profile');
    expect(normalizePath('/user//profile')).toBe('/user/profile');
  });

  it('同一端下路径重复 → DUPLICATE_PATH 并给出建议', () => {
    const pages = pagesFixture();
    pages.push(
      createPageDsl({
        id: 'dup',
        projectId: 'P1',
        name: '重复页',
        platform: 'web',
        route: '/login',
      }),
    );
    const issues = detectRouteIssues(generateRouteTable(pages));
    const duplicate = issues.find((issue) => issue.code === 'DUPLICATE_PATH');
    expect(duplicate).toBeDefined();
    expect(duplicate?.pageIds.sort()).toEqual(['dup', 'login']);
    expect(duplicate?.suggestion).toContain('/login-');
  });

  it('不同端允许相同路径（互不冲突）', () => {
    const web = createPageDsl({
      id: 'w',
      projectId: 'P1',
      name: 'W',
      platform: 'web',
      route: '/home',
    });
    const android = createPageDsl({
      id: 'a',
      projectId: 'P1',
      name: 'A',
      platform: 'android',
      route: '/home',
    });
    expect(detectRouteIssues(generateRouteTable([web, android]))).toEqual([]);
  });

  it('非法路径与含参数未声明被检出', () => {
    const bad = createPageDsl({
      id: 'bad',
      projectId: 'P1',
      name: '非法',
      platform: 'web',
      route: '/has space',
    });
    expect(detectRouteIssues(generateRouteTable([bad])).map((issue) => issue.code)).toContain(
      'INVALID_PATH',
    );

    const entry: RouteEntry = {
      path: '/user/:id',
      pageId: 'x',
      pageName: 'X',
      platform: 'web',
      params: [],
    };
    expect(detectRouteIssues([entry]).map((issue) => issue.code)).toContain('MISSING_PARAM');
  });
});

describe('T3-07 跳转关系图', () => {
  it('从 DSL 的 navigate 动作提取跳转边并解析目标页面', () => {
    const pages = pagesFixture();
    const edges = buildRouteEdges(pages);
    // 登录页样例里有 act-4: navigate → /dashboard
    const edge = edges.find((item) => item.fromPageId === 'login');
    expect(edge).toBeDefined();
    expect(edge?.route).toBe('/dashboard');
    expect(edge?.toPageId).toBe('dashboard');
    expect(edge?.toPageName).toBe('仪表盘');
    expect(edge?.eventId).toBe('ev-submit');
  });

  it('目标页面缺失时 toPageId 为 null（供一致性提示复用）', () => {
    const login = createLoginPageDsl();
    login.events[0]!.actions = [{ id: 'a1', kind: 'navigate', target: '/nowhere' }];
    const edges = buildRouteEdges([login]);
    expect(edges[0]?.toPageId).toBeNull();
  });

  it('编辑边：写回目标路由与参数', () => {
    const login = createLoginPageDsl();
    const next = patchPageEventAction(login, 'ev-submit', 'act-4', {
      target: '/dashboard',
      params: [{ name: 'tab', type: 'string', required: false, defaultValue: 'overview' }],
    });
    const action = next.events[0]?.actions.find((item) => item.id === 'act-4');
    expect(action?.target).toBe('/dashboard');
    expect(action?.params?.['routeParams']).toEqual([
      { name: 'tab', type: 'string', required: false, defaultValue: 'overview' },
    ]);
    // 原对象未被改动
    expect(login.events[0]?.actions.find((item) => item.id === 'act-4')?.params).toBeUndefined();
  });

  it('RouteGraph 渲染页面节点与跳转边（点击边可打开参数编辑）', () => {
    const { container } = render(
      <RouteGraph pages={pagesFixture()} height={320} onUpdateAction={() => undefined} />,
    );
    expect(screen.getByLabelText('路由跳转关系图')).toBeInTheDocument();
    expect(container.querySelectorAll('.ec-route-graph__edge').length).toBeGreaterThan(0);
    // 页面节点文字
    expect(screen.getByText('登录页')).toBeInTheDocument();
    expect(screen.getByText('仪表盘')).toBeInTheDocument();

    // 点击跳动关系连线可进入编辑（打开边编辑弹窗）
    fireEvent.click(container.querySelector('.ec-route-graph__hit') as Element);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('T3-07 路由表写入项目记忆', () => {
  function MemorySyncHarness({
    projectId,
    pages,
  }: {
    projectId: string;
    pages: PageDsl[];
  }): JSX.Element {
    useRouteMemorySync(projectId, pages);
    return <span data-testid="sync">ok</span>;
  }

  it('路由表变更时调用项目记忆端口（写前读 + 合并 + 写回由端口实现）', () => {
    const upsertRoutes = vi.fn();
    const readRoutes = vi.fn(() => []);
    const store = new MultiPageStore({ pages: pagesFixture() });
    render(
      <DesignerProvider ports={{ projectMemory: { upsertRoutes, readRoutes } }}>
        <MemorySyncHarness projectId="P1" pages={store.list()} />
      </DesignerProvider>,
    );
    expect(upsertRoutes).toHaveBeenCalledTimes(1);
    const payload = upsertRoutes.mock.calls[0]?.[0] as { projectId: string; routes: RouteEntry[] };
    expect(payload.projectId).toBe('P1');
    expect(payload.routes.map((route) => route.path)).toEqual([
      '/login',
      '/dashboard',
      '/user/:id',
      '/home',
    ]);
  });

  it('未注入项目记忆端口时静默跳过（不崩溃）', () => {
    render(
      <DesignerProvider>
        <MemorySyncHarness projectId="P1" pages={pagesFixture()} />
      </DesignerProvider>,
    );
    expect(screen.getByTestId('sync')).toBeInTheDocument();
  });
});

describe('T3-07 页面 CRUD 与模板复用', () => {
  it('内置 5 个页面模板', () => {
    expect(PAGE_TEMPLATES.map((template) => template.id)).toEqual([
      'blank',
      'login',
      'list',
      'detail',
      'dashboard',
    ]);
  });

  it('每个模板都能生成合法页面 DSL', () => {
    for (const template of PAGE_TEMPLATES) {
      const dsl = createPageFromTemplate(template.id, { id: `p-${template.id}`, projectId: 'P1' });
      expect(dsl.id).toBe(`p-${template.id}`);
      expect(dsl.tree.type).toBe('Container');
      expect(dsl.route.startsWith('/')).toBe(true);
    }
  });

  it('新建 / 重命名 / 复制 / 软删除 / 恢复 / 按端分组', () => {
    const store = new MultiPageStore({ pages: [createLoginPageDsl()] });
    store.createPage({ id: 'p2', projectId: 'P1', name: '列表页', template: 'list' });
    expect(store.list()).toHaveLength(2);
    expect(store.active()?.id).toBe('p2');

    store.renamePage('p2', '商品列表');
    expect(store.list().find((page) => page.id === 'p2')?.name).toBe('商品列表');

    const copy = store.duplicatePage('p2');
    expect(copy?.name).toBe('商品列表 副本');
    expect(store.list()).toHaveLength(3);

    // 软删除进回收站，可恢复
    store.removePage('p2');
    expect(store.list().map((page) => page.id)).not.toContain('p2');
    expect(store.getTrash().map((page) => page.id)).toEqual(['p2']);
    store.restorePage('p2');
    expect(store.list().map((page) => page.id)).toContain('p2');
    expect(store.getTrash()).toHaveLength(0);

    // 按端分组
    store.createPage({ id: 'm1', projectId: 'P1', name: '移动端页', platform: 'android' });
    expect(store.pagesByPlatform().android.map((page) => page.id)).toEqual(['m1']);
    expect(store.pagesByPlatform().web.map((page) => page.id)).toContain('login');
  });

  it('以现有页面为模板复制（sourceDsl）', () => {
    const store = new MultiPageStore();
    const source = createLoginPageDsl();
    const copy = store.createPage({ id: 'login2', projectId: 'P1', sourceDsl: source });
    expect(copy.id).toBe('login2');
    expect(copy.route).toBe('/login-copy');
    expect(copy.name).toBe('登录页 副本');
  });
});

describe('T3-07 页面树组件', () => {
  it('按端分组展示；删除二次确认（软删除）后可恢复', () => {
    const store = new MultiPageStore({ pages: pagesFixture() });
    const editorStore = createEditorStore({
      dsl: pagesFixture()[0] as PageDsl,
      coalesceWindowMs: 0,
    });
    render(
      <DesignerProvider store={editorStore}>
        <MultiPageProvider store={store}>
          <PageTree height={520} />
        </MultiPageProvider>
      </DesignerProvider>,
    );

    // 按端分组（分组头用平台标识）
    const webGroup = document.querySelector('[data-platform="web"]');
    const androidGroup = document.querySelector('[data-platform="android"]');
    expect(webGroup).not.toBeNull();
    expect(androidGroup).not.toBeNull();
    expect(screen.getAllByText('登录页').length).toBeGreaterThan(0);
    expect(screen.getAllByText('移动首页').length).toBeGreaterThan(0);

    // 删除需二次确认：点击删除按钮只弹窗，不真正删除
    const loginRow = screen.getByLabelText(/页面 登录页/);
    fireEvent.click(within(loginRow).getByLabelText('删除页面'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(store.list().map((page) => page.id)).toContain('login');

    // 确认后软删除（进回收站）
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(store.list().map((page) => page.id)).not.toContain('login');
    expect(store.getTrash().map((page) => page.id)).toEqual(['login']);

    // 可撤销恢复
    act(() => {
      store.restorePage('login');
    });
    expect(store.list().map((page) => page.id)).toContain('login');
  });

  it('新建页面按钮按端创建空白页', () => {
    const store = new MultiPageStore({ pages: [createLoginPageDsl()] });
    const editorStore = createEditorStore({ dsl: createLoginPageDsl(), coalesceWindowMs: 0 });
    render(
      <DesignerProvider store={editorStore}>
        <MultiPageProvider store={store}>
          <PageTree height={520} />
        </MultiPageProvider>
      </DesignerProvider>,
    );
    expect(store.pagesByPlatform().android).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('在 web 新建页面'));
    expect(store.list()).toHaveLength(2);
    const created = store.list().find((page) => page.id !== 'login');
    expect(created?.platform).toBe('web');
    expect(created?.route.startsWith('/')).toBe(true);
    expect(created).toBeDefined();
  });
});
