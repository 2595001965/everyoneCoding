/**
 * 域端口 IPC 测试（Wave 9 装配补齐 / M-07 四端口）。
 *
 * 覆盖两条路径：
 * 1. 未装配域运行时 → 兜底 handler 必须如实返回 NOT_SUPPORTED 与空 describe；
 * 2. 已装配域运行时 → invoke 透传给宿主，describe 原样回传。
 *
 * 另外单独锁住 preload 的域请求形状校验：方法名**不在** preload 校验范围内
 * （白名单是主进程职责），但 requestId/domain/method 缺一不可。
 */
import { describe, expect, it, vi } from 'vitest';

import { CHANNELS, PRELOAD_METHOD_KEYS, PRELOAD_TOP_LEVEL_KEYS } from '../main/channels';
import { registerDomainIpc, registerUnavailableDomainIpc } from '../main/ipc/domain';
import { createPreloadApi } from '../preload/api';
import type { IpcMainLike } from '../main/types';
import type { DomainControlServiceHost, DomainDescriptor, DomainRpcRequest } from '@ec/shell-api';

function collector(): { ipc: IpcMainLike; handlers: Map<string, (event: unknown, payload: unknown) => unknown> } {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  return {
    handlers,
    ipc: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (event: unknown, payload: unknown) => unknown);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    },
  };
}

describe('域端口通道登记', () => {
  it('通道名与 preload 白名单一致', () => {
    expect(CHANNELS.domain.invoke).toBe('ec:domain:invoke');
    expect(CHANNELS.domain.describe).toBe('ec:domain:describe');
    expect((PRELOAD_TOP_LEVEL_KEYS as readonly string[]).includes('domain')).toBe(true);
    expect(PRELOAD_METHOD_KEYS['domain']).toEqual(['invoke', 'describe']);
  });
});

describe('未装配域运行时的兜底行为', () => {
  it('invoke 返回 NOT_SUPPORTED，且保留调用方 requestId 便于归因', async () => {
    const { ipc, handlers } = collector();
    registerUnavailableDomainIpc(ipc);
    const handler = handlers.get(CHANNELS.domain.invoke);
    expect(handler).toBeDefined();

    const response = (await handler?.({}, { requestId: 'req-7', domain: 'docs', method: 'listDocuments' })) as {
      requestId: string;
      ok: boolean;
      error?: { code: string };
    };
    expect(response.requestId).toBe('req-7');
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('NOT_SUPPORTED');
  });

  it('requestId 缺失时不抛错，用占位值兜住', async () => {
    const { ipc, handlers } = collector();
    registerUnavailableDomainIpc(ipc);
    const response = (await handlers.get(CHANNELS.domain.invoke)?.({}, undefined)) as {
      requestId: string;
      ok: boolean;
    };
    expect(response.requestId).toBe('unsupported');
    expect(response.ok).toBe(false);
  });

  it('describe 返回空清单而不是伪造四个域可用', async () => {
    const { ipc, handlers } = collector();
    registerUnavailableDomainIpc(ipc);
    await expect(handlers.get(CHANNELS.domain.describe)?.({}, undefined)).resolves.toEqual([]);
  });
});

describe('已装配域运行时的透传', () => {
  const descriptors: DomainDescriptor[] = [
    { kind: 'settings', available: true },
    { kind: 'workspace', available: false, reason: '未装配' },
  ];

  function fakeHost(): DomainControlServiceHost {
    return {
      invoke: vi.fn(async (request: DomainRpcRequest) => ({
        requestId: request.requestId,
        ok: true,
        result: { echoed: request.method },
      })),
      describe: vi.fn(async () => descriptors),
      dispose: vi.fn(async () => undefined),
    };
  }

  it('invoke 透传给宿主并回传结果', async () => {
    const host = fakeHost();
    const { ipc, handlers } = collector();
    registerDomainIpc(ipc, host);

    const response = await handlers.get(CHANNELS.domain.invoke)?.(
      {},
      { requestId: 'r1', domain: 'settings', method: 'getAll', params: {} },
    );
    expect(response).toEqual({ requestId: 'r1', ok: true, result: { echoed: 'getAll' } });
    expect(host.invoke).toHaveBeenCalledTimes(1);
  });

  it('describe 原样回传装配状态', async () => {
    const { ipc, handlers } = collector();
    registerDomainIpc(ipc, fakeHost());
    await expect(handlers.get(CHANNELS.domain.describe)?.({}, undefined)).resolves.toEqual(descriptors);
  });
});

describe('preload 域请求形状校验', () => {
  function makeApi() {
    const invoked: Array<{ channel: string; payload: unknown }> = [];
    const api = createPreloadApi({
      invoke: async (channel, payload) => {
        invoked.push({ channel, payload });
        return { requestId: 'x', ok: true };
      },
      on: () => undefined,
      off: () => undefined,
    });
    return { api, invoked };
  }

  it('缺少 requestId / domain / method 时抛 TypeError', () => {
    const { api } = makeApi();
    const domain = api['domain'] as {
      invoke(request: unknown): Promise<unknown>;
      describe(): Promise<unknown>;
    };
    expect(() => domain.invoke({ domain: 'settings', method: 'getAll' })).toThrow(TypeError);
    expect(() => domain.invoke({ requestId: 'r', method: 'getAll' })).toThrow(TypeError);
    expect(() => domain.invoke({ requestId: 'r', domain: 'settings' })).toThrow(TypeError);
  });

  it('合法请求走 ec:domain:invoke，且方法名不由 preload 拦（白名单归主进程）', async () => {
    const { api, invoked } = makeApi();
    const domain = api['domain'] as { invoke(request: unknown): Promise<unknown> };
    await domain.invoke({ requestId: 'r', domain: 'settings', method: '不存在的放法', params: 1 });
    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.channel).toBe(CHANNELS.domain.invoke);
  });

  it('describe 走 ec:domain:describe', async () => {
    const { api, invoked } = makeApi();
    const domain = api['domain'] as { describe(): Promise<unknown> };
    await domain.describe();
    expect(invoked[0]?.channel).toBe(CHANNELS.domain.describe);
  });
});
