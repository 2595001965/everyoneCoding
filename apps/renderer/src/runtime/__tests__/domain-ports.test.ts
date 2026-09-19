/**
 * 域端口适配器测试（Wave 9 装配补齐 / M-07）。
 *
 * 核心断言两条：
 * 1. **只注入已装配的域**——未装配的域必须留空，页面才会保留装配引导；
 * 2. 参数按 method 逐字映射，跨进程失败还原为带 code 的 `ShellError`。
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  DomainControlHost,
  DomainDescriptor,
  DomainEvent,
  DomainRpcError,
  DomainRpcRequest,
  WorkspaceImportProgress,
} from '@ec/shell-api';

import {
  createAuthApi,
  createDocsApi,
  createDomainCaller,
  createSettingsApi,
  createWorkspaceApi,
  installDomainPorts,
  selectAvailableDomains,
  type DomainPortGlobals,
} from '../domain-ports';

/** 记录全部调用并可脚本化响应的假宿主 */
function fakeHost(
  descriptors: DomainDescriptor[],
  handler?: (request: DomainRpcRequest) => {
    ok: boolean;
    result?: unknown;
    error?: DomainRpcError;
  },
): { host: DomainControlHost; calls: DomainRpcRequest[] } {
  const calls: DomainRpcRequest[] = [];
  const host: DomainControlHost = {
    async describe() {
      return descriptors;
    },
    async invoke(request) {
      calls.push(request);
      const scripted = handler?.(request);
      if (scripted) {
        return {
          requestId: request.requestId,
          ok: scripted.ok,
          ...(scripted.result !== undefined ? { result: scripted.result } : {}),
          ...(scripted.error !== undefined ? { error: scripted.error } : {}),
        };
      }
      return { requestId: request.requestId, ok: true, result: { echo: request.method } };
    },
  };
  return { host, calls };
}

const ALL_AVAILABLE: DomainDescriptor[] = [
  { kind: 'workspace', available: true },
  { kind: 'docs', available: true },
  { kind: 'auth', available: true },
  { kind: 'settings', available: true },
];

describe('selectAvailableDomains', () => {
  it('只保留 available 为真且保持原顺序', () => {
    expect(
      selectAvailableDomains([
        { kind: 'workspace', available: false, reason: '未装配' },
        { kind: 'docs', available: true },
        { kind: 'settings', available: true },
        { kind: 'auth', available: false, reason: '无账号服务' },
      ]),
    ).toEqual(['docs', 'settings']);
  });

  it('空清单不产出任何域', () => {
    expect(selectAvailableDomains([])).toEqual([]);
  });
});

describe('installDomainPorts 的注入边界', () => {
  it('四个域都可用时写入四个全局槽位', async () => {
    const { host } = fakeHost(ALL_AVAILABLE);
    const globals: DomainPortGlobals = {};
    const result = await installDomainPorts(host, globals);
    expect(result.installed.sort()).toEqual(['auth', 'docs', 'settings', 'workspace']);
    expect(result.unavailable).toEqual([]);
    for (const key of ['__EC_WORKSPACE__', '__EC_DOCS__', '__EC_AUTH__', '__EC_SETTINGS__']) {
      expect(globals[key], key).toBeTruthy();
    }
  });

  it('未装配的域不写入槽位，并如实回传原因', async () => {
    const { host } = fakeHost([
      { kind: 'settings', available: false, reason: '缺命令目录' },
      { kind: 'workspace', available: false, reason: '缺 SQLite 存储适配' },
    ]);
    const globals: DomainPortGlobals = {};
    const result = await installDomainPorts(host, globals);
    expect(result.installed).toEqual([]);
    expect(result.unavailable.map((item) => item.reason)).toEqual([
      '缺命令目录',
      '缺 SQLite 存储适配',
    ]);
    expect(globals['__EC_SETTINGS__']).toBeUndefined();
    expect(globals['__EC_WORKSPACE__']).toBeUndefined();
  });

  it('未装配的域不与其它域相互影响', async () => {
    const { host } = fakeHost([
      { kind: 'docs', available: true },
      { kind: 'auth', available: false, reason: '无账号服务' },
    ]);
    const globals: DomainPortGlobals = {};
    await installDomainPorts(host, globals);
    expect(globals['__EC_DOCS__']).toBeTruthy();
    expect(globals['__EC_AUTH__']).toBeUndefined();
  });
});

describe('createDomainCaller', () => {
  it('成功时解包 result', async () => {
    const { host, calls } = fakeHost(ALL_AVAILABLE);
    const call = createDomainCaller(host);
    await expect(call.call('settings', 'getAll')).resolves.toEqual({ echo: 'getAll' });
    expect(calls[0]?.domain).toBe('settings');
    expect(calls[0]?.method).toBe('getAll');
    // 未传参数时补空对象，避免跨进程 undefined
    expect(calls[0]?.params).toEqual({});
  });

  it('失败时抛带 code 的 ShellError', async () => {
    const { host } = fakeHost(ALL_AVAILABLE, () => ({
      ok: false,
      error: { code: 'NOT_FOUND', message: '项目不存在' },
    }));
    const call = createDomainCaller(host);
    await expect(call.call('workspace', 'getProject', { id: 'x' })).rejects.toMatchObject({
      name: 'ShellError',
      code: 'NOT_FOUND',
      message: '项目不存在',
    });
  });

  it('error 缺失时退化为 UNKNOWN 而不是 undefined 崩溃', async () => {
    const { host } = fakeHost(ALL_AVAILABLE, () => ({ ok: false }));
    const call = createDomainCaller(host);
    await expect(call.call('docs', 'listDocuments')).rejects.toMatchObject({ code: 'UNKNOWN' });
  });
});

describe('端口方法映射', () => {
  it('工作台：listProjects 传 { query }，getMetricDetail 传 { projectId, key }', async () => {
    const { host, calls } = fakeHost(ALL_AVAILABLE);
    const api = createWorkspaceApi(createDomainCaller(host));
    await api.listProjects({ view: 'active' });
    await api.getMetricDetail('p1', 'memory');
    expect(calls[0]?.method).toBe('listProjects');
    expect(calls[0]?.params).toEqual({ query: { view: 'active' } });
    expect(calls[1]?.method).toBe('getMetricDetail');
    expect(calls[1]?.params).toEqual({ projectId: 'p1', key: 'memory' });
  });

  it('设置：update 包成 { patch }，saveBackupConfig 包成 { config }', async () => {
    const { host, calls } = fakeHost(ALL_AVAILABLE);
    const api = createSettingsApi(createDomainCaller(host));
    await api.update({ theme: 'dark' });
    await api.saveBackupConfig({ intervalHours: 6, dir: 'D:/b' });
    expect(calls[0]?.params).toEqual({ patch: { theme: 'dark' } });
    expect(calls[1]?.method).toBe('saveBackupConfig');
    expect(calls[1]?.params).toEqual({ config: { intervalHours: 6, dir: 'D:/b' } });
  });

  it('文档：supportedFormats 同步返回装配时缓存的值，不每次跨进程', async () => {
    const { host, calls } = fakeHost(ALL_AVAILABLE, (request) =>
      request.method === 'supportedFormats'
        ? { ok: true, result: ['markdown', 'txt'] }
        : { ok: true, result: [] },
    );
    const api = await createDocsApi(createDomainCaller(host));
    expect(api.supportedFormats()).toEqual(['markdown', 'txt']);
    const before = calls.length;
    api.supportedFormats();
    api.supportedFormats();
    expect(calls.length).toBe(before);
  });

  it('文档：格式清单取不到时退化为空数组而不是抛错', async () => {
    const { host } = fakeHost(ALL_AVAILABLE, () => ({
      ok: false,
      error: { code: 'NOT_SUPPORTED', message: '未装配解析器' },
    }));
    const api = await createDocsApi(createDomainCaller(host));
    expect(api.supportedFormats()).toEqual([]);
  });
});

describe('账号端口的同步离线镜像', () => {
  it('isOffline 同步返回镜像值；tryRecover 后刷新', async () => {
    let offline = true;
    const { host } = fakeHost(ALL_AVAILABLE, (request) => {
      if (request.method === 'isOffline') return { ok: true, result: offline };
      if (request.method === 'tryRecover') {
        offline = false;
        return { ok: true, result: true };
      }
      return { ok: true, result: null };
    });
    const api = createAuthApi(createDomainCaller(host));
    expect(api.isOffline()).toBe(false);

    const seen: boolean[] = [];
    const off = api.onOfflineChange((value) => seen.push(value));
    // 订阅时触发一次异步刷新
    await vi.waitFor(() => expect(api.isOffline()).toBe(true));

    await api.tryRecover();
    expect(api.isOffline()).toBe(false);
    expect(seen).toContain(false);
    off();
  });
});

describe('域事件订阅（Git 导入进度）', () => {
  const CLONE_PAYLOAD = {
    type: 'workspace:import-progress',
    stage: 'clone',
    ratio: 0.5,
    message: 'Receiving objects:  50%',
  };
  const INSPECT_PAYLOAD = {
    type: 'workspace:import-progress',
    stage: 'inspect',
    ratio: null,
    message: '正在扫描仓库文件…',
  };

  /**
   * 可挂起的宿主：`invoke` 阻塞在闸门上，方便在"调用进行中"投递事件。
   */
  function eventHost(options: { fail?: boolean } = {}): {
    host: DomainControlHost;
    calls: DomainRpcRequest[];
    listeners: Set<(event: DomainEvent) => void>;
    emit(event: DomainEvent): void;
    release(): void;
  } {
    const calls: DomainRpcRequest[] = [];
    const listeners = new Set<(event: DomainEvent) => void>();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const host: DomainControlHost = {
      async describe() {
        return ALL_AVAILABLE;
      },
      async invoke(request) {
        calls.push(request);
        await gate;
        if (options.fail === true) throw new Error('克隆失败');
        return { requestId: request.requestId, ok: true, result: { id: 'p1', name: 'repo' } };
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    return {
      host,
      calls,
      listeners,
      emit: (event) => {
        for (const listener of listeners) listener(event);
      },
      release: () => openGate(),
    };
  }

  function progressEvent(requestId: string, payload: unknown): DomainEvent {
    return { requestId, domain: 'workspace', payload };
  }

  it('createDomainCaller 允许显式指定 requestId（事件关联的前提）', async () => {
    const { host, calls } = fakeHost(ALL_AVAILABLE);
    const call = createDomainCaller(host);
    await call.call('workspace', 'importFromGit', {}, 'workspace-fixed-1');
    expect(calls[0]?.requestId).toBe('workspace-fixed-1');
    // 未指定时仍自动生成，且带域前缀
    await call.call('workspace', 'listProjects');
    expect(calls[1]?.requestId?.startsWith('workspace-')).toBe(true);
  });

  it('进度按 requestId 关联，别的调用/别的域/脏载荷一律忽略', async () => {
    const { host, calls, emit, release } = eventHost();
    const api = createWorkspaceApi(
      createDomainCaller(host),
      (listener) => host.onEvent?.(listener) ?? (() => {}),
    );
    const seen: WorkspaceImportProgress[] = [];

    const pending = api.importFromGit({
      url: 'https://example.com/repo.git',
      targetDir: 'D:/repo',
      onProgress: (progress) => seen.push(progress),
    });
    const requestId = calls[0]?.requestId;
    expect(requestId).toBeTruthy();

    emit(progressEvent(requestId as string, CLONE_PAYLOAD));
    // 并发调用的进度不能串到这次调用上
    emit(progressEvent('workspace-other', CLONE_PAYLOAD));
    // 形状不符的载荷不能进 UI
    emit(progressEvent(requestId as string, { junk: true }));
    emit(progressEvent(requestId as string, { ...CLONE_PAYLOAD, ratio: 1.5 }));
    // 别的域的事件
    emit({ requestId: requestId as string, domain: 'docs', payload: CLONE_PAYLOAD });
    // 比例不可知的阶段（守卫必须放行 null）
    emit(progressEvent(requestId as string, INSPECT_PAYLOAD));

    release();
    await pending;

    expect(seen).toEqual([
      { stage: 'clone', ratio: 0.5, message: 'Receiving objects:  50%' },
      { stage: 'inspect', ratio: null, message: '正在扫描仓库文件…' },
    ]);
    // onProgress 无法跨进程，必须被剥掉后再发
    expect(calls[0]?.params).toEqual({
      input: { url: 'https://example.com/repo.git', targetDir: 'D:/repo' },
    });
  });

  it('请求成功后即退订，事件不再回调', async () => {
    const { host, calls, listeners, emit, release } = eventHost();
    const api = createWorkspaceApi(
      createDomainCaller(host),
      (listener) => host.onEvent?.(listener) ?? (() => {}),
    );
    const seen: WorkspaceImportProgress[] = [];

    const pending = api.importFromGit({
      url: 'https://example.com/repo.git',
      targetDir: 'D:/repo',
      onProgress: (progress) => seen.push(progress),
    });
    const requestId = calls[0]?.requestId as string;
    emit(progressEvent(requestId, CLONE_PAYLOAD));
    release();
    await pending;

    expect(listeners.size).toBe(0);
    emit(progressEvent(requestId, CLONE_PAYLOAD));
    expect(seen).toHaveLength(1);
  });

  it('请求失败也退订，且错误照常抛出', async () => {
    const { host, calls, listeners, release } = eventHost({ fail: true });
    const api = createWorkspaceApi(
      createDomainCaller(host),
      (listener) => host.onEvent?.(listener) ?? (() => {}),
    );

    const pending = api.importFromGit({
      url: 'https://example.com/repo.git',
      targetDir: 'D:/repo',
      onProgress: () => undefined,
    });
    expect(calls).toHaveLength(1);
    release();
    await expect(pending).rejects.toThrowError(/克隆失败/);
    expect(listeners.size).toBe(0);
  });

  it('调用方不传 onProgress 时不订阅（无谓的监听器一个都不留）', async () => {
    const { host, listeners, release } = eventHost();
    const api = createWorkspaceApi(
      createDomainCaller(host),
      (listener) => host.onEvent?.(listener) ?? (() => {}),
    );

    const pending = api.importFromGit({
      url: 'https://example.com/repo.git',
      targetDir: 'D:/repo',
    });
    release();
    await pending;
    expect(listeners.size).toBe(0);
  });

  it('宿主未提供 onEvent 时退化为无进度，调用照常成功', async () => {
    // fakeHost 没有 onEvent（老外壳/mock 的常态）
    const { host, calls } = fakeHost(ALL_AVAILABLE, () => ({ ok: true, result: { id: 'p1' } }));
    const globals: DomainPortGlobals = {};
    await installDomainPorts(host, globals);
    const api = globals['__EC_WORKSPACE__'] as ReturnType<typeof createWorkspaceApi>;

    const seen: WorkspaceImportProgress[] = [];
    await expect(
      api.importFromGit({
        url: 'https://example.com/repo.git',
        targetDir: 'D:/repo',
        onProgress: (progress) => seen.push(progress),
      }),
    ).resolves.toEqual({ id: 'p1' });
    expect(seen).toEqual([]);
    // 注意 calls[0] 是装配时取的 supportedFormats；导入调用要在清单里找
    expect(calls.some((item) => item.method === 'importFromGit')).toBe(true);
  });
});
