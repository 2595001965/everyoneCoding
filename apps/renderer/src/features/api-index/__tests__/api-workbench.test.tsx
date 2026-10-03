import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  sortApiEndpoints,
  type ApiEndpointDetail,
  type ApiIndexPort,
  type ApiIndexSnapshot,
  type IndexedApiEndpoint,
} from '@ec/registry';
import { ApiWorkbench } from '../ApiWorkbench';

const endpoint = (
  endpointId: string,
  createdAt: number | null,
  firstSeenAt = 100,
): IndexedApiEndpoint => ({
  endpointId,
  projectId: 'project',
  serviceId: 'service:users',
  method: 'GET',
  rawPath: `/users/${endpointId}`,
  normalizedPath: `/users/${endpointId}`,
  title: endpointId,
  contractSource: 'router_decl',
  sourceRef: { filePath: 'app.ts', startLine: 4, endLine: 4, symbol: 'handler' },
  featureIds: [],
  createdAt,
  createdAtSource: createdAt === null ? 'unknown' : 'git_inferred',
  firstSeenAt,
  updatedAt: 100,
  revision: 1,
  status: 'active',
  tags: [],
  evidence: [
    {
      kind: 'router_decl',
      sourceRef: { filePath: 'app.ts', startLine: 4, endLine: 4, symbol: 'handler' },
      detail: 'app.get',
      confidence: 1,
      key: endpointId,
    },
  ],
  parameters: null,
  response: null,
  authentication: [],
  implementation: [],
  tests: [],
  documents: [],
  modifiedAt: 90,
  classification: { group: '用户', tags: ['查询'], source: 'rule', revision: 1, updatedAt: 100 },
  manualClassification: null,
  timeReason: createdAt === null ? '无 Git 历史' : '当前可追溯历史推断',
  fingerprint: 'fixture',
  routeHistory: [],
});

function renderWorkbench(api: ApiIndexPort): void {
  render(
    <MemoryRouter>
      <ApiWorkbench api={api} projectId="project" />
      <RouteProbe />
    </MemoryRouter>,
  );
}

function RouteProbe(): JSX.Element {
  const location = useLocation();
  return (
    <output data-testid="route-target">
      {JSON.stringify({ pathname: location.pathname, state: location.state })}
    </output>
  );
}

function fixture(): { api: ApiIndexPort; snapshot: ApiIndexSnapshot } {
  const snapshot: ApiIndexSnapshot = {
    projectId: 'project',
    endpoints: [endpoint('unknown', null, 120), endpoint('old', 10), endpoint('new', 20)],
    calls: [],
    relations: [],
    services: [{ serviceId: 'service:users', name: '用户服务', root: '', origins: [] }],
    warnings: [],
    scannedAt: 100,
    stale: false,
    fingerprint: 'fixture',
  };
  const api: ApiIndexPort = {
    ready: true,
    list: vi.fn(async () => snapshot),
    rescan: vi.fn(async () => snapshot),
    detail: vi.fn(async (id) => ({
      endpoint: snapshot.endpoints.find((e) => e.endpointId === id)!,
      calls: [],
      relations: [],
      elements: [],
    })),
    classify: vi.fn(async (input) => {
      const e = snapshot.endpoints.find((e) => e.endpointId === input.endpointId)!;
      e.classification = {
        group: input.group,
        tags: input.tags,
        source: 'user',
        revision: 1,
        updatedAt: 200,
      };
      e.manualClassification = e.classification;
      e.revision++;
      return e;
    }),
    confirmCall: vi.fn(async () => snapshot),
    reverse: vi.fn(async () => []),
    navigate: vi.fn(async () => {}),
    navigateElement: vi.fn(),
  };
  return { api, snapshot };
}
describe('V2-D04 接口工作台', () => {
  it('创建时间双向排序始终把未知置后，未知按 firstSeenAt/ID 稳定排序', () => {
    const values = [
      endpoint('u2', null, 130),
      endpoint('a', 10),
      endpoint('u1', null, 120),
      endpoint('b', 20),
    ];
    expect(sortApiEndpoints(values, 'created_asc').map((e) => e.endpointId)).toEqual([
      'a',
      'b',
      'u1',
      'u2',
    ]);
    expect(sortApiEndpoints(values, 'created_desc').map((e) => e.endpointId)).toEqual([
      'b',
      'a',
      'u1',
      'u2',
    ]);
  });
  it('列表排序/搜索/详情导航，未知时间明确展示首次发现', async () => {
    const { api } = fixture();
    renderWorkbench(api);
    const list = screen.getByLabelText('接口列表');
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(3));
    expect(within(list).getAllByRole('button')[0]!.textContent).toContain('/users/new');
    fireEvent.change(screen.getByLabelText('排序'), { target: { value: 'created_asc' } });
    expect(within(list).getAllByRole('button')[0]!.textContent).toContain('/users/old');
    fireEvent.click(within(list).getAllByRole('button')[2]!);
    const detail = screen.getByLabelText('接口详情');
    await within(detail).findByText('无 Git 历史');
    expect(within(detail).getByText('首次发现')).toBeTruthy();
    fireEvent.click(within(detail).getByRole('button', { name: /app.ts:4/ }));
    await waitFor(() =>
      expect(api.navigate).toHaveBeenCalledWith({
        filePath: 'app.ts',
        startLine: 4,
        endLine: 4,
        symbol: 'handler',
      }),
    );
    fireEvent.change(screen.getByLabelText('搜索接口'), { target: { value: 'old' } });
    expect(within(list).getAllByRole('button')).toHaveLength(1);
  });
  it('人工覆盖包含版本，重扫仍有分类；失效时禁用确认', async () => {
    const { api, snapshot } = fixture();
    renderWorkbench(api);
    await screen.findByRole('button', { name: /GET \/users\/new/ });
    fireEvent.click(screen.getByRole('button', { name: /GET \/users\/new/ }));
    await screen.findByLabelText('人工功能分组');
    fireEvent.change(screen.getByLabelText('人工功能分组'), { target: { value: '业务管理' } });
    fireEvent.click(screen.getByRole('button', { name: '保存人工覆盖' }));
    await waitFor(() =>
      expect(api.classify).toHaveBeenCalledWith({
        endpointId: 'new',
        revision: 1,
        group: '业务管理',
        tags: ['查询'],
        reset: false,
      }),
    );
    await screen.findByRole('button', { name: '重新扫描源码' });
    fireEvent.click(screen.getByRole('button', { name: '重新扫描源码' }));
    await waitFor(() => expect(api.rescan).toHaveBeenCalled());
    expect(snapshot.endpoints[2]!.classification.source).toBe('user');
  });
  it('再次点击当前接口保留已加载详情', async () => {
    const { api } = fixture();
    renderWorkbench(api);
    const selected = await screen.findByRole('button', { name: /GET \/users\/new/ });
    fireEvent.click(selected);
    await screen.findByLabelText('人工功能分组');
    fireEvent.click(selected);
    expect(screen.getByLabelText('人工功能分组')).toBeTruthy();
  });
  it('接口新增、扩展、删除和调用点功能动作送入现有代码路由', async () => {
    const { api, snapshot } = fixture();
    const call = {
      callId: 'resolved-call',
      projectId: 'project',
      key: 'resolved-call',
      method: 'GET' as const,
      expression: "fetch('/users/new')",
      path: '/users/new',
      origin: null,
      serviceHint: 'service:users',
      sourceRef: { filePath: 'view.ts', startLine: 2, endLine: 2, symbol: 'loadUsers' },
      dynamic: false,
      reason: null,
      endpointIds: ['new'],
      status: 'resolved' as const,
      confirmedEndpointId: 'new',
      confirmedByUser: false,
      revision: 1,
      firstSeenAt: 100,
      updatedAt: 100,
    };
    snapshot.calls = [call];
    vi.mocked(api.detail).mockResolvedValue({
      endpoint: snapshot.endpoints[2]!,
      calls: [call],
      relations: [],
      elements: [],
    } as ApiEndpointDetail);
    renderWorkbench(api);
    fireEvent.click(await screen.findByRole('button', { name: /GET \/users\/new/ }));
    const detail = screen.getByLabelText('接口详情');
    await within(detail).findByText('已关联');
    const actions = screen.getByRole('group', { name: 'AI 定点开发' });
    const routeTarget = (): {
      pathname: string;
      state: { apiEditTarget: Record<string, unknown> };
    } =>
      JSON.parse(screen.getByTestId('route-target').textContent ?? '{}') as {
        pathname: string;
        state: { apiEditTarget: Record<string, unknown> };
      };

    fireEvent.click(within(actions).getByRole('button', { name: '扩展现有接口' }));
    expect(routeTarget()).toMatchObject({
      pathname: '/code',
      state: {
        apiEditTarget: { mode: 'extend-endpoint', endpointId: 'new', expectedEndpointRevision: 1 },
      },
    });
    fireEvent.click(
      within(actions).getByRole('button', { name: '在此 Router/Controller 新增接口' }),
    );
    expect(routeTarget().state.apiEditTarget).toMatchObject({
      mode: 'add-endpoint',
      locationEndpointId: 'new',
    });
    fireEvent.click(within(actions).getByRole('button', { name: 'AI 删除接口及已知引用' }));
    expect(routeTarget().state.apiEditTarget).toMatchObject({
      mode: 'delete-endpoint',
      endpointId: 'new',
    });
    fireEvent.click(within(detail).getByRole('button', { name: '以此调用点新增页面功能' }));
    expect(routeTarget().state.apiEditTarget).toMatchObject({
      mode: 'api-feature',
      endpointId: 'new',
      callId: 'resolved-call',
    });
  });
  it('详情中的候选调用不冒充已关联，第三方请求有独立视图', async () => {
    const { api, snapshot } = fixture();
    const call = {
      key: 'call',
      method: 'GET' as const,
      expression: 'fetch(url)',
      path: null,
      origin: null,
      serviceHint: null,
      sourceRef: { filePath: 'view.ts', startLine: 1, endLine: 1, symbol: null },
      dynamic: true,
      reason: '动态未解析',
      callId: 'call',
      projectId: 'project',
      endpointIds: ['new'],
      status: 'pending_confirmation' as const,
      confirmedEndpointId: null,
      confirmedByUser: false,
      revision: 1,
      firstSeenAt: 100,
      updatedAt: 100,
    };
    snapshot.calls = [
      call,
      {
        ...call,
        key: 'external',
        callId: 'external',
        expression: "fetch('https://third.example')",
        origin: 'https://third.example',
        status: 'external',
        endpointIds: [],
      },
    ];
    snapshot.stale = true;
    vi.mocked(api.detail).mockResolvedValue({
      endpoint: snapshot.endpoints[2]!,
      calls: [call],
      relations: [],
      elements: [],
    } as ApiEndpointDetail);
    renderWorkbench(api);
    await screen.findByRole('button', { name: /GET \/users\/new/ });
    fireEvent.click(screen.getByRole('button', { name: /GET \/users\/new/ }));
    await screen.findByText('候选，待确认');
    fireEvent.click(screen.getByRole('button', { name: '待确认调用' }));
    expect(screen.getByLabelText('确认项目接口')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '第三方请求' }));
    expect(screen.getByText("fetch('https://third.example')")).toBeTruthy();
  });
});
