/**
 * 生产端口适配器测试（T12-01 第 6 条验收的渲染层一侧）。
 *
 * 与 `domain-ports.test.ts` 的分工：那里锁四个基础域的注入边界与事件关联，
 * 这里锁**十一域生产端口**的四件事：
 * 1. 同步签名端口（memory / pipeline）的注入前提——外壳没有 `invokeSync` 就不注入；
 * 2. 真实项目 ID 由「当前项目上下文」注入每次调用（含项目切换后不串）；
 * 3. 跨进程错误码映射到端口约定的形状（GitApi 的 `GitResult` / ShellError）；
 * 4. 进度事件按 requestId 关联，别的调用与别的项目的事件都要被丢掉。
 *
 * 全程不打桩域实现：断言的是"适配器把哪个域、哪个方法、什么参数发出去了"。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  DomainControlHost,
  DomainDescriptor,
  DomainEvent,
  DomainRpcError,
  DomainRpcRequest,
  DomainRpcResponse,
} from '@ec/shell-api';

import { createDomainCaller, type DomainEventSubscriber } from '../domain-ports';
import {
  createDomainSyncCaller,
  installProductionPorts,
  type ProductionPortGlobals,
} from '../production-ports';
import type { GitApi } from '../../features/git/git-api';
import type { MemoryApi } from '../../features/memory/memory-api';
import type { PipelineApi } from '../../features/pipeline/pipeline-api';
import type { PackageApi } from '../../features/package/package-api';
import { useProjectStore } from '../../store/useProjectStore';

const PRODUCTION_DESCRIPTORS: DomainDescriptor[] = [
  'memory',
  'pipeline',
  'git',
  'preview',
  'rename',
  'package',
  'usage',
  'ai-context',
  'code',
  'nav',
  'designer',
].map((kind) => ({ kind, available: true }) as DomainDescriptor);

interface FakeHostOptions {
  /** 是否提供同步口（Tauri / mock 的常态是**不**提供） */
  sync?: boolean;
  /** 脚本化异步响应；返回 undefined 时按成功回显方法名 */
  script?: (
    request: DomainRpcRequest,
  ) => { ok: boolean; result?: unknown; error?: DomainRpcError } | undefined;
  /** 脚本化同步响应 */
  scriptSync?: (
    request: DomainRpcRequest,
  ) => { ok: boolean; result?: unknown; error?: DomainRpcError } | undefined;
}

function fakeHost(options: FakeHostOptions = {}): {
  host: DomainControlHost;
  calls: DomainRpcRequest[];
  syncCalls: DomainRpcRequest[];
  listeners: Set<(event: DomainEvent) => void>;
  emit(event: DomainEvent): void;
} {
  const calls: DomainRpcRequest[] = [];
  const syncCalls: DomainRpcRequest[] = [];
  const listeners = new Set<(event: DomainEvent) => void>();

  const wrap = (
    request: DomainRpcRequest,
    scripted: { ok: boolean; result?: unknown; error?: DomainRpcError } | undefined,
  ): DomainRpcResponse => {
    if (scripted) {
      return {
        requestId: request.requestId,
        ok: scripted.ok,
        ...(scripted.result !== undefined ? { result: scripted.result } : {}),
        ...(scripted.error !== undefined ? { error: scripted.error } : {}),
      };
    }
    return { requestId: request.requestId, ok: true, result: { echo: request.method } };
  };

  const host: DomainControlHost = {
    describe: async () => PRODUCTION_DESCRIPTORS,
    async invoke(request) {
      calls.push(request);
      return wrap(request, options.script?.(request));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  if (options.sync === true) {
    host.invokeSync = (request) => {
      syncCalls.push(request);
      return wrap(request, options.scriptSync?.(request));
    };
  }

  return {
    host,
    calls,
    syncCalls,
    listeners,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

/** 装配一次（可选是否带同步口），返回全局槽位与调用记录 */
async function install(options: FakeHostOptions = {}): Promise<{
  globals: ProductionPortGlobals;
  host: DomainControlHost;
  calls: DomainRpcRequest[];
  syncCalls: DomainRpcRequest[];
  emit(event: DomainEvent): void;
  listeners: Set<(event: DomainEvent) => void>;
  unavailable: Array<{ kind: string; reason: string }>;
}> {
  const { host, calls, syncCalls, listeners, emit } = fakeHost(options);
  const subscribe: DomainEventSubscriber = (listener) => host.onEvent?.(listener) ?? (() => {});
  const globals: ProductionPortGlobals = {};
  const result = await installProductionPorts(
    host,
    createDomainCaller(host),
    subscribe,
    new Set(PRODUCTION_DESCRIPTORS.map((item) => item.kind)),
    globals,
  );
  return { globals, host, calls, syncCalls, listeners, emit, unavailable: result.unavailable };
}

/** 打开一个项目（写入"当前项目上下文"） */
function openProject(id: string, name = id): void {
  useProjectStore.getState().openProject({ id, name, targetPlatforms: ['web'], updatedAt: 0 });
}

beforeEach(() => {
  useProjectStore.getState().closeProject();
});

describe('同步口缺失时的注入边界（Tauri / mock 降级）', () => {
  it('没有 invokeSync：memory / pipeline 不注入并给出原因，其余九个域照常注入', async () => {
    const { globals, unavailable } = await install();

    expect(globals['__EC_MEMORY__']).toBeUndefined();
    expect(globals['__EC_PIPELINE__']).toBeUndefined();
    expect(unavailable.map((item) => item.kind).sort()).toEqual(['memory', 'pipeline']);
    for (const item of unavailable) {
      expect(item.reason).toContain('invokeSync');
    }

    for (const key of [
      '__EC_GIT__',
      '__EC_PREVIEW__',
      '__EC_RENAME__',
      '__EC_PACKAGE__',
      '__EC_USAGE__',
      '__EC_AI_CONTEXT__',
      '__EC_CODE__',
      '__EC_NAV__',
      '__EC_DESIGNER__',
    ]) {
      expect(globals[key], key).toBeTruthy();
    }
  });

  it('有 invokeSync：两个同步端口都注入，且不再报缺口', async () => {
    const { globals, unavailable } = await install({ sync: true });
    expect(globals['__EC_MEMORY__']).toBeTruthy();
    expect(globals['__EC_PIPELINE__']).toBeTruthy();
    expect(unavailable).toEqual([]);
  });

  it('createDomainSyncCaller 在缺 invokeSync 时返回 null（调用方据此不注入）', () => {
    expect(createDomainSyncCaller(fakeHost().host)).toBeNull();
    expect(createDomainSyncCaller(fakeHost({ sync: true }).host)).not.toBeNull();
  });
});

describe('同步端口走 invokeSync 且参数逐字透传', () => {
  it('memory.list 经同步口发出，不产生异步调用', async () => {
    const { globals, calls, syncCalls } = await install({ sync: true });
    const memory = globals['__EC_MEMORY__'] as MemoryApi;

    memory.list({ userId: 'local-user', projectId: 'P-A', query: { text: '登录' } });

    expect(calls).toHaveLength(0);
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]?.domain).toBe('memory');
    expect(syncCalls[0]?.method).toBe('list');
    expect(syncCalls[0]?.params).toEqual({
      userId: 'local-user',
      projectId: 'P-A',
      query: { text: '登录' },
    });
  });

  it('pipeline.advance 经同步口；readArtifact 这类 IO 方法走异步口', async () => {
    const { globals, calls, syncCalls } = await install({ sync: true });
    const pipeline = globals['__EC_PIPELINE__'] as PipelineApi;

    pipeline.advance('P-A', 'S1', 'S2');
    await pipeline.readArtifact('P-A', 'S1', 1);

    expect(syncCalls.map((item) => item.method)).toEqual(['advance']);
    expect(calls.map((item) => item.method)).toEqual(['readArtifact']);
  });

  it('同步口失败同样还原为带 code 的 ShellError', async () => {
    const { globals } = await install({
      sync: true,
      scriptSync: () => ({ ok: false, error: { code: 'NOT_FOUND', message: '条目不存在' } }),
    });
    const memory = globals['__EC_MEMORY__'] as MemoryApi;
    expect(() => memory.detail('missing')).toThrowError(
      expect.objectContaining({ name: 'ShellError', code: 'NOT_FOUND', message: '条目不存在' }),
    );
  });
});

describe('真实项目 ID 由当前项目上下文注入', () => {
  it('同一端口在切换项目后发出的是新 projectId（不串上一个项目）', async () => {
    const { globals, calls } = await install();
    const git = globals['__EC_GIT__'] as GitApi;

    openProject('P-A', '项目甲');
    await git.status();

    openProject('P-B', '项目乙');
    await git.status();

    expect(calls[0]?.params).toMatchObject({ projectId: 'P-A' });
    expect(calls[1]?.params).toMatchObject({ projectId: 'P-B' });
  });

  it('调用方自己的参数与 projectId 合并，且不会覆盖 projectId', async () => {
    const { globals, calls } = await install();
    const git = globals['__EC_GIT__'] as GitApi;

    openProject('P-A');
    await git.log({ limit: 5, path: 'src' });

    expect(calls[0]?.params).toEqual({ projectId: 'P-A', limit: 5, path: 'src' });
  });

  it('未打开项目：如实抛 INVALID_ARGUMENT，且**请求根本不发出**', async () => {
    const { globals, calls } = await install();
    const git = globals['__EC_GIT__'] as GitApi;

    const result = await git.status();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENT');
    expect(result.error?.message).toContain('尚未打开项目');
    // 关键：不能把一个 projectId=undefined 的请求送到主进程
    expect(calls).toHaveLength(0);
  });

  it('未打开项目时 git.info 返回 null（页面展示引导而不是报错）', async () => {
    const { globals } = await install();
    const git = globals['__EC_GIT__'] as GitApi;
    await expect(git.info()).resolves.toBeNull();
  });
});

describe('跨进程错误码映射到端口约定形状', () => {
  it('GitApi 把失败映射为 GitResult{ok:false,error.code} 而不是抛异常', async () => {
    const { globals } = await install({
      script: (request) =>
        request.method === 'status'
          ? { ok: false, error: { code: 'NOT_SUPPORTED', message: 'AI 栈未装配' } }
          : undefined,
    });
    openProject('P-A');
    const git = globals['__EC_GIT__'] as GitApi;

    const result = await git.status();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_SUPPORTED');
    expect(result.error?.message).toBe('AI 栈未装配');
  });

  it('未知错误码退化为 UNKNOWN，不把 undefined 塞进 UI', async () => {
    const { globals } = await install({ script: () => ({ ok: false }) });
    openProject('P-A');
    const git = globals['__EC_GIT__'] as GitApi;
    const result = await git.status();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN');
  });

  it('preview 的失败同样是 PreviewResult 结构（生成类未装配时不伪造成功）', async () => {
    const { globals } = await install({
      script: (request) =>
        request.method === 'startBackend'
          ? { ok: false, error: { code: 'NOT_SUPPORTED', message: '未检测到可托管的开发服务器' } }
          : undefined,
    });
    openProject('P-A');
    const preview = globals['__EC_PREVIEW__'] as {
      startBackend(): Promise<{ ok: boolean; error?: { code: string } | null }>;
    };
    const result = await preview.startBackend();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_SUPPORTED');
  });

  it('pipeline.evaluateImpact 缺技术选型时抛 INVALID_ARGUMENT（不返回空报告）', async () => {
    const { globals } = await install({
      sync: true,
      // getTechChoice 返回 null：尚未完成 S3 问卷
      scriptSync: (request) =>
        request.method === 'getTechChoice' ? { ok: true, result: null } : undefined,
    });
    const pipeline = globals['__EC_PIPELINE__'] as PipelineApi;
    expect(() =>
      pipeline.evaluateImpact('P-A', { kind: 'rename', from: 'a', to: 'b' } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});

describe('进度事件按 requestId 关联', () => {
  it('git.push 的进度只认本次调用的 requestId', async () => {
    const { globals, calls, emit, listeners } = await install();
    openProject('P-A');
    const git = globals['__EC_GIT__'] as GitApi;

    const seen: Array<{ phase: string }> = [];
    const pending = git.push({ remote: 'origin', branch: 'main' }, (event) => seen.push(event));
    const requestId = calls[0]?.requestId as string;
    expect(requestId.startsWith('git-')).toBe(true);

    emit({
      requestId,
      domain: 'git',
      payload: { type: 'git:progress', phase: 'transferring', message: '推送中', percent: 0.4 },
    });
    // 别的调用：丢弃
    emit({
      requestId: 'git-other',
      domain: 'git',
      payload: { type: 'git:progress', phase: 'done', message: '别的调用', percent: 1 },
    });
    // 别的域：丢弃
    emit({
      requestId,
      domain: 'pipeline',
      payload: { type: 'git:progress', phase: 'done', message: '别的域', percent: 1 },
    });
    // 别的类型：丢弃
    emit({ requestId, domain: 'git', payload: { type: 'pipeline:progress', message: 'x' } });

    await pending;
    expect(seen).toEqual([
      { type: 'git:progress', phase: 'transferring', message: '推送中', percent: 0.4 },
    ]);
    // 请求定局即退订，不留悬空监听
    expect(listeners.size).toBe(0);
  });

  it('package.exportPackage 剥掉 onProgress（函数不能跨进程）后再发', async () => {
    const { globals, calls } = await install();
    const pack = globals['__EC_PACKAGE__'] as PackageApi;

    await pack.exportPackage({
      scope: { kind: 'all' } as never,
      outputPath: 'D:/out.ecpkg',
      onProgress: () => undefined,
    } as never);

    const sent = calls.find((item) => item.method === 'exportPackage');
    expect(sent).toBeTruthy();
    expect(sent?.params).toMatchObject({
      request: { scope: { kind: 'all' }, outputPath: 'D:/out.ecpkg' },
    });
    // 函数字段必须已剥掉，否则 Electron 结构化克隆会直接抛错
    const request = (sent?.params as { request: Record<string, unknown> }).request;
    expect('onProgress' in request).toBe(false);
  });

  it('pipeline 事件按项目过滤：切到别的项目后旧项目事件不再投递', async () => {
    const { globals, emit } = await install({ sync: true });
    openProject('P-B');
    const pipeline = globals['__EC_PIPELINE__'] as PipelineApi;

    const seen: unknown[] = [];
    pipeline.subscribe('pipeline:*', (payload) => seen.push(payload));

    emit({
      requestId: 'pipeline-1',
      domain: 'pipeline',
      payload: { type: 'pipeline:stage-event', projectId: 'P-A', event: 'advance' },
    });
    emit({
      requestId: 'pipeline-1',
      domain: 'pipeline',
      payload: { type: 'pipeline:stage-event', projectId: 'P-B', event: 'advance' },
    });

    expect(seen).toEqual([{ type: 'pipeline:stage-event', projectId: 'P-B', event: 'advance' }]);
  });
});

describe('未装配的域不注入任何槽位', () => {
  it('describe 报 available=false 的域既不产端口也不被合并进 installed', async () => {
    const { host } = fakeHost();
    const subscribed: DomainEventSubscriber = (listener) => host.onEvent?.(listener) ?? (() => {});
    const globals: ProductionPortGlobals = {};
    const result = await installProductionPorts(
      host,
      createDomainCaller(host),
      subscribed,
      new Set(['git']), // 只有 git 可用
      globals,
    );

    expect(result.installed).toEqual(['git']);
    expect(globals['__EC_RENAME__']).toBeUndefined();
    expect(globals['__EC_PACKAGE__']).toBeUndefined();
    expect(globals['__EC_DESIGNER__']).toBeUndefined();
  });
});
