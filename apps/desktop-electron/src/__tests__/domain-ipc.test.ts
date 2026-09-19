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

import {
  CHANNELS,
  EVENT_CHANNELS,
  PRELOAD_METHOD_KEYS,
  PRELOAD_TOP_LEVEL_KEYS,
} from '../main/channels';
import { registerDomainIpc, registerUnavailableDomainIpc } from '../main/ipc/domain';
import { createPreloadApi } from '../preload/api';
import type { IpcMainLike } from '../main/types';
import {
  createDomainEventSink,
  type DomainControlServiceHost,
  type DomainDescriptor,
  type DomainRpcRequest,
} from '@ec/shell-api';
function collector(): {
  ipc: IpcMainLike;
  handlers: Map<string, (event: unknown, payload: unknown) => unknown>;
} {
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
    expect(CHANNELS.domain.event).toBe('ec:domain:event');
    expect((PRELOAD_TOP_LEVEL_KEYS as readonly string[]).includes('domain')).toBe(true);
    expect(PRELOAD_METHOD_KEYS['domain']).toEqual(['invoke', 'describe', 'onEvent']);
  });

  it('事件通道登记为单向推送（无 handler，仅 main→renderer）', () => {
    expect(EVENT_CHANNELS).toContain(CHANNELS.domain.event);
  });
});

describe('未装配域运行时的兜底行为', () => {
  it('invoke 返回 NOT_SUPPORTED，且保留调用方 requestId 便于归因', async () => {
    const { ipc, handlers } = collector();
    registerUnavailableDomainIpc(ipc);
    const handler = handlers.get(CHANNELS.domain.invoke);
    expect(handler).toBeDefined();

    const response = (await handler?.(
      {},
      { requestId: 'req-7', domain: 'docs', method: 'listDocuments' },
    )) as {
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
      events: createDomainEventSink(),
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
    await expect(handlers.get(CHANNELS.domain.describe)?.({}, undefined)).resolves.toEqual(
      descriptors,
    );
  });
});

describe('域事件下发（invoke 期间按 requestId 绑定发送器）', () => {
  const descriptors: DomainDescriptor[] = [{ kind: 'workspace', available: true }];

  /** 宿主在路由执行期间推一条进度事件，模拟 `workspace.importFromGit` */
  function eventingHost(): DomainControlServiceHost {
    const host: DomainControlServiceHost = {
      events: createDomainEventSink(),
      describe: vi.fn(async () => descriptors),
      dispose: vi.fn(async () => undefined),
      invoke: vi.fn(async (request: DomainRpcRequest) => {
        host.events.send({
          requestId: request.requestId,
          domain: request.domain,
          payload: {
            type: 'workspace:import-progress',
            stage: 'clone',
            ratio: 0.5,
            message: '克隆中',
          },
        });
        return { requestId: request.requestId, ok: true, result: null };
      }),
    };
    return host;
  }

  function senderCollector(): {
    sender: { send(channel: string, payload: unknown): void };
    sent: Array<{ channel: string; payload: unknown }>;
  } {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    return {
      sent,
      sender: {
        send: (channel, payload) => {
          sent.push({ channel, payload });
        },
      },
    };
  }

  it('事件走 ec:domain:event 并携带 requestId/domain 供渲染层关联', async () => {
    const host = eventingHost();
    const { ipc, handlers } = collector();
    registerDomainIpc(ipc, host);
    const { sender, sent } = senderCollector();

    await handlers.get(CHANNELS.domain.invoke)?.(
      { sender },
      { requestId: 'workspace-1', domain: 'workspace', method: 'importFromGit', params: {} },
    );

    expect(sent).toEqual([
      {
        channel: CHANNELS.domain.event,
        payload: {
          requestId: 'workspace-1',
          domain: 'workspace',
          payload: {
            type: 'workspace:import-progress',
            stage: 'clone',
            ratio: 0.5,
            message: '克隆中',
          },
        },
      },
    ]);
  });

  it('请求结束后注销发送器，后续事件不再投递给该请求', async () => {
    const host = eventingHost();
    const { ipc, handlers } = collector();
    registerDomainIpc(ipc, host);
    const { sender, sent } = senderCollector();

    await handlers.get(CHANNELS.domain.invoke)?.(
      { sender },
      { requestId: 'workspace-1', domain: 'workspace', method: 'importFromGit', params: {} },
    );
    expect(sent).toHaveLength(1);

    host.events.send({
      requestId: 'workspace-1',
      domain: 'workspace',
      payload: { stage: 'inspect' },
    });
    expect(sent).toHaveLength(1);
  });

  it('宿主抛错时 finally 照样注销（失败请求不留悬空回调）', async () => {
    const host: DomainControlServiceHost = {
      events: createDomainEventSink(),
      describe: vi.fn(async () => descriptors),
      dispose: vi.fn(async () => undefined),
      invoke: vi.fn(async () => {
        throw new Error('克隆失败');
      }),
    };
    const { ipc, handlers } = collector();
    registerDomainIpc(ipc, host);
    const { sender, sent } = senderCollector();

    await expect(async () => {
      await handlers.get(CHANNELS.domain.invoke)?.(
        { sender },
        { requestId: 'workspace-bad', domain: 'workspace', method: 'importFromGit', params: {} },
      );
    }).rejects.toThrowError(/克隆失败/);

    host.events.send({ requestId: 'workspace-bad', domain: 'workspace', payload: 'x' });
    expect(sent).toEqual([]);
  });

  it('无 sender 或 requestId 缺失时不注册，也不影响调用结果', async () => {
    const host = eventingHost();
    const { ipc, handlers } = collector();
    registerDomainIpc(ipc, host);

    // 事件没有投递目标，但调用本身照常成功
    const noSender = (await handlers.get(CHANNELS.domain.invoke)?.(
      {},
      { requestId: 'workspace-1', domain: 'workspace', method: 'importFromGit', params: {} },
    )) as { ok: boolean };
    expect(noSender.ok).toBe(true);

    const { sender, sent } = senderCollector();
    const noRequestId = (await handlers.get(CHANNELS.domain.invoke)?.(
      { sender },
      { domain: 'workspace', method: 'importFromGit', params: {} },
    )) as { ok: boolean };
    expect(noRequestId.ok).toBe(true);
    expect(sent).toEqual([]);
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

describe('preload 域事件订阅', () => {
  function makeEventApi(): {
    domain: { onEvent(listener: (event: unknown) => void): () => void };
    listeners: Map<string, (event: unknown, payload: unknown) => void>;
  } {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const api = createPreloadApi({
      invoke: async () => ({ requestId: 'x', ok: true }),
      on: (channel, listener) => {
        listeners.set(channel, listener);
      },
      off: (channel) => {
        listeners.delete(channel);
      },
    });
    return { domain: api['domain'] as never, listeners };
  }

  it('订阅走 ec:domain:event，退订后解绑', () => {
    const { domain, listeners } = makeEventApi();
    const seen: unknown[] = [];
    const off = domain.onEvent((event) => seen.push(event));

    const deliver = listeners.get(CHANNELS.domain.event);
    expect(deliver).toBeDefined();
    deliver?.({}, { requestId: 'r1', domain: 'workspace', payload: { stage: 'clone' } });
    expect(seen).toHaveLength(1);

    off();
    expect(listeners.has(CHANNELS.domain.event)).toBe(false);
  });

  it('丢弃缺 requestId 的载荷（渲染层无从关联到调用）', () => {
    const { domain, listeners } = makeEventApi();
    const seen: unknown[] = [];
    domain.onEvent((event) => seen.push(event));
    const deliver = listeners.get(CHANNELS.domain.event);

    deliver?.({}, { requestId: '', domain: 'workspace' });
    deliver?.({}, { domain: 'workspace' });
    deliver?.({}, null);
    deliver?.({}, 'not-an-object');
    expect(seen).toEqual([]);
  });

  it('listener 不是函数时抛 TypeError', () => {
    const { domain } = makeEventApi();
    expect(() => domain.onEvent('nope' as never)).toThrow(TypeError);
  });
});
