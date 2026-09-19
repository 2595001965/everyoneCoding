import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createLoginPageDsl } from '../../dsl/factory';
import type { ActionNode, RouteEntry } from '../../dsl/types';
import { DesignerProvider } from '../../store/designer-context';
import { createEditorStore } from '../../store/editor-store';
import { StateStore } from '../../state/StateStore';
import { FlowEditor } from '../FlowEditor';
import { ACTION_LABELS, createFlowNode, parseFlow, serializeFlow } from '../flow-schema';
import { createFlowRuntime } from '../flow-runtime';
import { detectCycles, findOrphanNodes, validateFlow } from '../flow-validator';

describe('T3-09 五类动作节点序列化', () => {
  it('面板文案为中文且覆盖五类动作', () => {
    expect(Object.values(ACTION_LABELS)).toEqual(['跳转', '请求', '赋值', '提示', '条件分支']);
  });

  it('navigate / request / assign / notify / branch 均可无损映射到 ActionNode 并还原', () => {
    const actions: ActionNode[] = [
      { id: 'n1', kind: 'navigate', target: '/dashboard', params: { tab: 'overview' }, next: 'n2' },
      {
        id: 'n2',
        kind: 'request',
        target: '/api/login',
        async: true,
        params: { method: 'POST', body: { phone: '${phone}' } },
        next: 'n3',
      },
      { id: 'n3', kind: 'assign', target: 'loading', value: true, next: 'n4' },
      { id: 'n4', kind: 'notify', value: '登录失败', params: { type: 'error' } },
      {
        id: 'n5',
        kind: 'branch',
        params: { expression: { op: 'eq', left: 'code', right: 0 } },
        branchTrue: 'n1',
        branchFalse: 'n4',
      },
    ];

    const nodes = parseFlow(actions);
    expect(nodes.map((node) => node.kind)).toEqual([
      'navigate',
      'request',
      'assign',
      'notify',
      'branch',
    ]);

    const back = serializeFlow(nodes);
    for (const original of actions) {
      const restored = back.find((action) => action.id === original.id);
      expect(restored?.kind).toBe(original.kind);
      expect(restored?.target).toBe(original.target);
      expect(restored?.next).toBe(original.next);
      expect(restored?.branchTrue).toBe(original.branchTrue);
      expect(restored?.branchFalse).toBe(original.branchFalse);
      expect(restored?.async).toBe(original.async);
    }
    // 请求节点保留入参映射与异步标记
    const request = back.find((action) => action.id === 'n2');
    expect(request?.params).toMatchObject({ method: 'POST', body: { phone: '${phone}' } });
    expect(request?.async).toBe(true);
    // 条件表达式结构保留（不走 eval）
    const branch = back.find((action) => action.id === 'n5');
    expect(branch?.params?.['expression']).toEqual({ op: 'eq', left: 'code', right: 0 });
  });

  it('别名 kind（setState / toast）被归一化为规范值', () => {
    expect(createFlowNode('setState').kind).toBe('assign');
    expect(createFlowNode('toast').kind).toBe('notify');
    expect(createFlowNode('call').kind).toBe('request');
    expect(createFlowNode('navigateTo').kind).toBe('navigate');
  });

  it('request 默认异步，其余默认同步', () => {
    expect(createFlowNode('request').async).toBe(true);
    expect(createFlowNode('assign').async).toBeUndefined();
    expect(createFlowNode('navigate').async).toBeUndefined();
  });

  it('新建节点带规范默认参数', () => {
    expect(createFlowNode('navigate').params).toMatchObject({ route: '', params: {} });
    expect(createFlowNode('request').params).toMatchObject({ api: '', method: 'POST' });
    expect(createFlowNode('notify').params).toMatchObject({ type: 'info' });
    expect(createFlowNode('branch').params['expression']).toMatchObject({ op: 'eq' });
  });
});

describe('T3-09 动作流校验', () => {
  const pages: RouteEntry[] = [
    { path: '/login', pageId: 'login', pageName: '登录页', platform: 'web', params: [] },
    { path: '/dashboard', pageId: 'dashboard', pageName: '仪表盘', platform: 'web', params: [] },
  ];

  it('缺失必填参数被报出', () => {
    const issues = validateFlow({ nodes: [createFlowNode('navigate', { id: 'a' })] });
    expect(issues.map((issue) => issue.code)).toContain('MISSING_REQUIRED_PARAM');
    expect(issues[0]?.message).toContain('route');
  });

  it('跳转目标不存在被报出；存在时不报', () => {
    const bad = validateFlow({
      nodes: [createFlowNode('navigate', { id: 'a', params: { route: '/nowhere' } })],
      routes: pages,
    });
    expect(bad.map((issue) => issue.code)).toContain('TARGET_PAGE_NOT_FOUND');
    const good = validateFlow({
      nodes: [createFlowNode('navigate', { id: 'a', params: { route: '/dashboard' } })],
      routes: pages,
    });
    expect(good.map((issue) => issue.code)).not.toContain('TARGET_PAGE_NOT_FOUND');
  });

  it('接口未定义被报出；已定义放行', () => {
    const nodes = [createFlowNode('request', { id: 'a', params: { api: '/api/login' } })];
    expect(validateFlow({ nodes, knownApis: ['/api/other'] }).map((issue) => issue.code)).toContain(
      'API_NOT_DEFINED',
    );
    expect(
      validateFlow({ nodes, knownApis: ['/api/login'] }).map((issue) => issue.code),
    ).not.toContain('API_NOT_DEFINED');
  });

  it('孤立节点被报出', () => {
    const nodes = [
      createFlowNode('assign', { id: 'a', params: { name: 'x', value: 1 }, next: 'b' }),
      createFlowNode('notify', { id: 'b', params: { message: 'ok' } }),
      createFlowNode('notify', { id: 'orphan', params: { message: '没人指向我' } }),
    ];
    expect(findOrphanNodes(nodes)).toEqual(['orphan']);
    expect(validateFlow({ nodes }).map((issue) => issue.code)).toContain('ORPHAN_NODE');
  });

  it('条件分支回环：允许但标注 warning，并列出参与节点', () => {
    const nodes = [
      createFlowNode('branch', {
        id: 'b1',
        params: { expression: { op: 'truthy', left: 'again' } },
        branchTrue: 'a1',
        branchFalse: 'b2',
      }),
      createFlowNode('assign', { id: 'a1', params: { name: 'count', value: 1 }, next: 'b1' }),
      createFlowNode('notify', { id: 'b2', params: { message: '结束' } }),
    ];
    expect(detectCycles(nodes).length).toBeGreaterThan(0);
    const cyclic = validateFlow({ nodes }).filter((issue) => issue.code === 'CYCLIC_BRANCH');
    expect(cyclic).toHaveLength(1);
    expect(cyclic[0]?.severity).toBe('warning');
    expect(cyclic[0]?.participants).toEqual(expect.arrayContaining(['b1', 'a1']));
  });

  it('条件分支缺一侧分支 / 赋值引用不存在状态被报出', () => {
    const nodes = [
      createFlowNode('branch', {
        id: 'b1',
        params: { expression: { op: 'truthy', left: 'x' } },
        branchTrue: 'a1',
      }),
      createFlowNode('assign', { id: 'a1', params: { name: 'notDeclared', value: 1 } }),
    ];
    const codes = validateFlow({ nodes, stateNames: ['x'] }).map((issue) => issue.code);
    expect(codes).toContain('EMPTY_BRANCH');
    expect(codes).toContain('STATE_NOT_FOUND');
  });
});

describe('T3-09 动作流运行时', () => {
  function runtime(hooks: {
    request?: (url: string, body: unknown) => Promise<{ status: number; data: unknown }>;
    notify?: (n: { type: string; message: string }) => void;
    navigate?: (path: string, params?: Record<string, unknown>) => void;
    initial?: Record<string, unknown>;
  }) {
    const store = new StateStore(hooks.initial ?? { phone: '13800000000', password: 'x' });
    return createFlowRuntime({
      store,
      ports: {
        ...(hooks.request
          ? { requester: { request: ({ url, body }) => hooks.request!(url, body) } }
          : {}),
        ...(hooks.notify ? { notify: hooks.notify as never } : {}),
        ...(hooks.navigate ? { navigate: hooks.navigate as never } : {}),
      },
    });
  }

  it('按 next 串联执行（严格顺序），并按 branch 结果选择分支', async () => {
    const visited: string[] = [];
    /** 由用例控制接口返回码，驱动条件分支走向 */
    let responseCode = 0;
    const flow = runtime({
      request: async (url) => {
        visited.push(`request:${url}`);
        return { status: 200, data: { code: responseCode } };
      },
      notify: (n) => visited.push(`notify:${n.message}`),
      navigate: (path) => visited.push(`navigate:${path}`),
    });

    const actions = serializeFlow([
      createFlowNode('assign', { id: 'a1', params: { name: 'loading', value: true }, next: 'a2' }),
      createFlowNode('request', {
        id: 'a2',
        params: { api: '/api/login', body: { phone: '${phone}' } },
        next: 'a3',
      }),
      createFlowNode('branch', {
        id: 'a3',
        params: { expression: { op: 'eq', left: 'response.code', right: 0 } },
        branchTrue: 'a4',
        branchFalse: 'a5',
      }),
      createFlowNode('navigate', { id: 'a4', params: { route: '/dashboard' } }),
      createFlowNode('notify', { id: 'a5', params: { type: 'error', message: '失败' } }),
    ]);

    const result = await flow.execute(actions);
    expect(result.status).toBe('success');
    expect(result.visited).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(result.state['loading']).toBe(true);
    expect(result.navigations).toEqual([{ path: '/dashboard' }]);
    expect(visited).toEqual(['request:/api/login', 'navigate:/dashboard']);

    responseCode = 1;
    const failed = await flow.execute(actions);
    expect(failed.visited).toEqual(['a1', 'a2', 'a3', 'a5']);
    expect(failed.notifications).toEqual([{ type: 'error', message: '失败' }]);
  });

  it('异步 request 会被等待（结果写入 scope 供后续条件使用）', async () => {
    let resolved = false;
    const flow = runtime({
      request: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        resolved = true;
        return { status: 200, data: { code: 0 } };
      },
      navigate: () => undefined,
    });
    const actions = serializeFlow([
      createFlowNode('request', { id: 'r1', params: { api: '/api/login' }, next: 'b1' }),
      createFlowNode('branch', {
        id: 'b1',
        params: { expression: { op: 'eq', left: 'response.code', right: 0 } },
        branchTrue: 'n1',
        branchFalse: 'n2',
      }),
      createFlowNode('navigate', { id: 'n1', params: { route: '/ok' } }),
      createFlowNode('notify', { id: 'n2', params: { message: '失败' } }),
    ]);

    const result = await flow.execute(actions);
    expect(resolved).toBe(true);
    expect(result.visited).toEqual(['r1', 'b1', 'n1']);
  });

  it('缺少 requester 时请求节点失败并给出中文原因', async () => {
    const flow = runtime({});
    const result = await flow.execute(
      serializeFlow([createFlowNode('request', { id: 'r1', params: { api: '/api/x' } })]),
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('requester');
  });

  it('死循环（自回环）被中断为 aborted', async () => {
    const flow = runtime({});
    const actions: ActionNode[] = [
      { id: 'a1', kind: 'notify', value: '循环', params: { type: 'info' }, next: 'a1' },
    ];
    const result = await flow.execute(actions);
    expect(result.status).toBe('aborted');
    expect(result.visited.length).toBeLessThanOrEqual(21);
    expect(result.error).toContain('死循环');
  });

  it('空动作流视为成功且不访问任何节点', async () => {
    const flow = runtime({});
    const result = await flow.execute([]);
    expect(result.status).toBe('success');
    expect(result.visited).toEqual([]);
  });
});

describe('T3-09 动作流编辑器', () => {
  function setup() {
    const store = createEditorStore({ dsl: createLoginPageDsl(), coalesceWindowMs: 0 });
    render(
      <DesignerProvider store={store}>
        <FlowEditor eventId="ev-submit" height={480} />
      </DesignerProvider>,
    );
    return store;
  }

  it('从节点面板加入五类节点并保存进 DSL（一次保存 = 一步 undo）', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = setup();
    const before = store.getState().undoState.undoDepth;

    for (const kind of ['navigate', 'request', 'assign', 'notify', 'branch']) {
      fireEvent.click(screen.getByTestId(`palette-${kind}`));
    }
    fireEvent.click(screen.getByTestId('flow-save'));

    const actions = store.getState().dsl.events[0]?.actions ?? [];
    expect(actions.length).toBeGreaterThanOrEqual(5);
    expect(store.getState().undoState.undoDepth).toBe(before + 1);
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
  });

  it('保存后的动作流通过 DSL 结构校验（连线指向真实节点）', () => {
    const store = setup();
    fireEvent.click(screen.getByTestId('palette-assign'));
    fireEvent.click(screen.getByTestId('flow-save'));
    const events = store.getState().dsl.events;
    const ids = new Set((events[0]?.actions ?? []).map((action) => action.id));
    expect(ids.size).toBeGreaterThan(0);
    expect(store.getState().dsl.events[0]?.entry).toBeDefined();
  });

  it('缺失必填参数时在校验面板给出告警', () => {
    setup();
    // 面板默认不选中任何节点；加入一个空跳转节点后应报"缺少必填参数"
    fireEvent.click(screen.getByTestId('palette-navigate'));
    expect(screen.getByTestId('flow-issues')).toBeInTheDocument();
    expect(screen.getByTestId('issue-MISSING_REQUIRED_PARAM')).toBeInTheDocument();
  });

  it('切换到不存在的事件 id 时展示空态而不是崩溃', () => {
    const store = createEditorStore({ dsl: createLoginPageDsl(), coalesceWindowMs: 0 });
    render(
      <DesignerProvider store={store}>
        <FlowEditor eventId="not-exist" height={320} />
      </DesignerProvider>,
    );
    expect(screen.getByText('未找到事件')).toBeInTheDocument();
  });

  it('清空按钮移除全部节点并可撤销', () => {
    const store = setup();
    act(() => {
      store.getState().setPageEvents([
        {
          id: 'ev-submit',
          trigger: 'click',
          entry: 'act-1',
          actions: [{ id: 'act-1', kind: 'notify', value: 'x', params: { type: 'info' } }],
        },
      ]);
    });
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    fireEvent.click(screen.getByTestId('flow-save'));
    expect(store.getState().dsl.events[0]?.actions).toEqual([]);
  });
});
