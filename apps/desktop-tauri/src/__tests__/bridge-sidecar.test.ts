/**
 * Tauri 桥接层：域端口与 AI 通道的侧车路由测试。
 *
 * 与 `bridge.test.ts` 的分工：那份是 `runShellContract` 契约套件（外壳通用能力），
 * 这份专测**本轮新接入的两条链路**：
 *
 * - `domain.invoke / describe / onEvent` → Rust `domain_invoke / domain_describe / sidecar_*`
 * - `ai.invoke / stream / abort` → Rust `ai_invoke / ai_stream_start / ai_abort`
 *
 * 断言重点不在"成功路径能跑通"，而在**降级路径不能让 UI 变形**：
 * 侧车不可用时要给出真实原因、流式失败要补 `error + done`（否则界面永远转圈）、
 * 订阅不能泄漏、跨进程脏数据不能进 UI。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DOMAIN_KINDS, type DomainEvent } from '@ec/shell-api';

import { createTauriShell } from '../bridge';

interface EventEnvelope {
  op: string;
  payload: unknown;
}

/** `sidecar_status` 的应答形状（与 Rust `SidecarStatusWire` 对齐） */
interface FakeStatus {
  ready: {
    available: boolean;
    reason?: string;
    domains: Array<{ kind: string; available: boolean; reason?: string }>;
    syncDomains: string[];
    ai: { available: boolean; reason?: string };
  };
  location: string;
  protocol: number;
}

/** 全部域都可用的一份 `ready`（各用例按需覆写） */
function availableStatus(): FakeStatus {
  return {
    ready: {
      available: true,
      domains: DOMAIN_KINDS.map((kind) => ({ kind, available: true })),
      syncDomains: ['memory', 'pipeline'],
      ai: { available: true },
    },
    location: 'entry=dist/sidecar/x.cjs node=node.exe protocol=1',
    protocol: 1,
  };
}

const { fakeInvoke, MockChannel, state } = vi.hoisted(() => {
  class MockChannel<T = unknown> {
    id = Math.floor(Math.random() * 1e9);
    onmessage: ((message: T) => void) | null = null;
  }

  const state = {
    /** `sidecar_status` 的应答 */
    status: null as unknown,
    /** 是否让 `sidecar_status` 直接抛错（模拟命令层故障） */
    statusThrows: false,
    /** 是否让 `domain_describe` 抛错 */
    describeThrows: false,
    /** 是否让 `domain_invoke` 抛错 */
    invokeThrows: false,
    calls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
    subscriptions: [] as string[],
    unsubscriptions: [] as string[],
    /** 当前活跃的订阅通道（桥接层惰性建一条，测试用它推事件） */
    channel: null as MockChannel<EventEnvelope> | null,
    invokeResult: {
      requestId: 'r',
      ok: true,
      result: { echoed: true },
    } as Record<string, unknown>,
    aiInvokeResult: { requestId: 'ai-1', ok: true, result: [] } as Record<string, unknown>,
    aiStreamAccepted: true as boolean,
    aiStreamError: undefined as { code: string; message: string } | undefined,
  };

  async function fakeInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    state.calls.push({ cmd, args });
    switch (cmd) {
      case 'sidecar_status':
        if (state.statusThrows) throw new Error('命令 sidecar_status 不可用');
        return state.status;
      case 'domain_invoke':
        if (state.invokeThrows) throw new Error('命令 domain_invoke 不可用');
        return state.invokeResult;
      case 'domain_describe':
        if (state.describeThrows) throw new Error('命令 domain_describe 不可用');
        return DOMAIN_KINDS.map((kind) => ({ kind, available: true }));
      case 'sidecar_subscribe': {
        state.channel = (args.channel as MockChannel<EventEnvelope>) ?? null;
        const id = `sub-${state.subscriptions.length + 1}`;
        state.subscriptions.push(id);
        return id;
      }
      case 'sidecar_unsubscribe':
        state.unsubscriptions.push(args.sub_id as string);
        return undefined;
      case 'ai_invoke':
        return state.aiInvokeResult;
      case 'ai_stream_start':
        return state.aiStreamAccepted
          ? { accepted: true }
          : { accepted: false, ...(state.aiStreamError ? { error: state.aiStreamError } : {}) };
      case 'ai_abort':
        return undefined;
      case 'process_kill_all':
        return undefined;
      default:
        return undefined;
    }
  }

  return { fakeInvoke, MockChannel, state };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: fakeInvoke,
  Channel: MockChannel,
}));

/** 每个用例前把可变的伪造状态复位（模块级事件总线由 `dispose` 收干净） */
function resetState(): void {
  state.statusThrows = false;
  state.describeThrows = false;
  state.invokeThrows = false;
  state.calls.length = 0;
  state.subscriptions.length = 0;
  state.unsubscriptions.length = 0;
  state.channel = null;
  state.invokeResult = { requestId: 'r', ok: true, result: { echoed: true } };
  state.aiStreamAccepted = true;
  state.aiStreamError = undefined;
  state.status = availableStatus();
}

/** 覆写本次 `sidecar_status` 应答（只改动需要变的那部分） */
function setStatus(patch: Partial<FakeStatus['ready']>): void {
  const base = availableStatus();
  state.status = { ...base, ready: { ...base.ready, ...patch } };
}

const active: Array<{ dispose(): Promise<void> }> = [];

function makeShell() {
  const shell = createTauriShell();
  active.push(shell);
  return shell;
}

afterEach(async () => {
  while (active.length > 0) {
    await active.pop()?.dispose();
  }
  resetState();
});

describe('Tauri 桥接：能力协商（ai / domain 来自侧车真实状态）', () => {
  it('侧车就绪时 ai 与 domain 都为 true，且不带 reasons', async () => {
    resetState();
    const shell = makeShell();
    const caps = await shell.capabilities();
    expect(caps.ai).toBe(true);
    expect(caps.domain).toBe(true);
    expect(caps.reasons).toBeUndefined();
    // 其余能力仍是 Rust 命令直接提供
    expect(caps.fs).toBe(true);
    expect(caps.secureStore).toBe(true);
  });

  it('侧车不可用时 ai / domain 为 false，并把**真实原因**带出去', async () => {
    resetState();
    setStatus({
      available: false,
      reason: '未找到 Node 运行时：请设置 EC_SIDECAR_NODE',
      domains: [],
      syncDomains: [],
      ai: { available: false, reason: '未找到 Node 运行时：请设置 EC_SIDECAR_NODE' },
    });
    const shell = makeShell();
    const caps = await shell.capabilities();
    expect(caps.ai).toBe(false);
    expect(caps.domain).toBe(false);
    // 用户看到的不该只是"不可用"，而是"该装什么"
    expect(caps.reasons?.domain).toMatch(/EC_SIDECAR_NODE/);
    expect(caps.reasons?.ai).toMatch(/EC_SIDECAR_NODE/);
  });

  it('sidecar_status 本身失败时仍给出可读原因（不抛错、不谎报可用）', async () => {
    resetState();
    state.statusThrows = true;
    const shell = makeShell();
    const caps = await shell.capabilities();
    expect(caps.ai).toBe(false);
    expect(caps.domain).toBe(false);
    expect(caps.reasons?.domain).toMatch(/侧车运行时不可用/);
    expect(caps.reasons?.ai).toMatch(/侧车运行时不可用/);
  });

  it('AI 可用但域不可用（两种原因各自独立，不互相顶替）', async () => {
    resetState();
    setStatus({
      available: false,
      reason: '侧车域运行时装配失败',
      domains: [],
      syncDomains: [],
      ai: { available: true },
    });
    const shell = makeShell();
    const caps = await shell.capabilities();
    expect(caps.domain).toBe(false);
    expect(caps.ai).toBe(true);
    expect(caps.reasons?.domain).toBe('侧车域运行时装配失败');
    // ai 可用 → 不该出现在 reasons 里
    expect(caps.reasons?.ai).toBeUndefined();
  });
});

describe('Tauri 桥接：域 RPC', () => {
  it('domain.invoke 把请求逐字透传给 Rust，并原样返回响应', async () => {
    resetState();
    const shell = makeShell();
    const request = {
      requestId: 'req-1',
      domain: 'workspace' as const,
      method: 'listProjects',
      params: { view: 'active' },
    };
    const response = await shell.domain.invoke(request);
    expect(response).toEqual({ requestId: 'r', ok: true, result: { echoed: true } });

    const call = state.calls.find((item) => item.cmd === 'domain_invoke');
    expect(call?.args.request).toEqual(request);
  });

  it('domain.invoke 命令层失败时返回结构化响应（渲染层永远拿不到裸异常）', async () => {
    resetState();
    state.invokeThrows = true;
    const shell = makeShell();
    const response = await shell.domain.invoke({
      requestId: 'req-2',
      domain: 'workspace',
      method: 'listProjects',
      params: {},
    });
    expect(response.ok).toBe(false);
    expect(response.requestId).toBe('req-2');
    expect(response.error?.code).toBe('NOT_SUPPORTED');
    expect(response.error?.message).toMatch(/domain_invoke 不可用/);
    expect(response.error?.retryable).toBe(false);
  });

  it('domain.describe 返回 Rust 给出的域清单', async () => {
    resetState();
    const shell = makeShell();
    const descriptors = await shell.domain.describe();
    expect(descriptors).toHaveLength(DOMAIN_KINDS.length);
    expect(descriptors.every((item) => item.available)).toBe(true);
  });

  it('domain.describe 失败时降级为「全部 15 域不可用 + 同一原因」', async () => {
    resetState();
    state.describeThrows = true;
    const shell = makeShell();
    const descriptors = await shell.domain.describe();
    // 页面的装配引导要靠这份清单；返回空数组会让页面"什么都没有"
    expect(descriptors).toHaveLength(DOMAIN_KINDS.length);
    expect(descriptors.every((item) => !item.available)).toBe(true);
    expect(descriptors[0]?.reason).toMatch(/domain_describe 不可用/);
  });
});

describe('Tauri 桥接：域事件订阅', () => {
  it('onEvent 惰性建立单条订阅；域事件按信封形状送达监听器', async () => {
    resetState();
    const shell = makeShell();
    const received: DomainEvent[] = [];
    await shell.domain.invoke({
      requestId: 'x',
      domain: 'workspace',
      method: 'listProjects',
      params: {},
    });

    const off = shell.domain.onEvent?.((event) => received.push(event));
    // 惰性：订阅命令必须已经被调用（否则事件根本没来源）
    await vi.waitFor(() =>
      expect(state.calls.some((item) => item.cmd === 'sidecar_subscribe')).toBe(true),
    );
    expect(state.channel).not.toBeNull();

    const envelope: DomainEvent = {
      requestId: 'req-1',
      domain: 'workspace',
      payload: { type: 'workspace:import-progress', stage: 'clone', ratio: 0.5, message: '克隆中' },
    };
    state.channel?.onmessage?.({ op: 'domain.event', payload: envelope });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(envelope);

    // 非域事件（AI 分片 / 日志）不该被当成域事件送下去
    state.channel?.onmessage?.({ op: 'log', payload: { level: 'info', message: 'x' } });
    state.channel?.onmessage?.({
      op: 'ai.stream',
      payload: { requestId: 'a', event: { type: 'chunk' } },
    });
    expect(received).toHaveLength(1);

    // 跨进程数据不信任：形状不对的事件直接丢弃，而不是把脏值塞进 UI
    state.channel?.onmessage?.({ op: 'domain.event', payload: { domain: 'workspace' } });
    state.channel?.onmessage?.({ op: 'domain.event', payload: null });
    expect(received).toHaveLength(1);

    off?.();
  });

  it('多个监听器共用一条订阅；全部退订后释放订阅（不泄漏）', async () => {
    resetState();
    const shell = makeShell();
    const a = shell.domain.onEvent?.(() => undefined);
    const b = shell.domain.onEvent?.(() => undefined);
    await vi.waitFor(() => expect(state.subscriptions.length).toBeGreaterThanOrEqual(1));
    expect(state.subscriptions).toHaveLength(1);

    a?.();
    expect(state.unsubscriptions).toHaveLength(0);
    b?.();
    await vi.waitFor(() => expect(state.unsubscriptions).toHaveLength(1));
    expect(state.unsubscriptions[0]).toBe(state.subscriptions[0]);
  });

  it('dispose 释放订阅（窗口关闭后不该继续占着 Rust 的订阅表）', async () => {
    resetState();
    const shell = makeShell();
    shell.domain.onEvent?.(() => undefined);
    await vi.waitFor(() => expect(state.subscriptions).toHaveLength(1));
    await shell.dispose();
    expect(state.unsubscriptions).toEqual([state.subscriptions[0]]);
  });
});

describe('Tauri 桥接：AI 通道', () => {
  it('ai.invoke 走 ai_invoke 且 request 逐字透传', async () => {
    resetState();
    const shell = makeShell();
    const response = await shell.ai.invoke({
      requestId: 'ai-1',
      method: 'listProviders',
      params: {},
    });
    expect(response.ok).toBe(true);
    const call = state.calls.find((item) => item.cmd === 'ai_invoke');
    expect(call?.args.request).toEqual({
      requestId: 'ai-1',
      method: 'listProviders',
      params: {},
    });
  });

  it('ai.invoke 命令层失败时合成 AiRpcResponse（不抛裸异常）', async () => {
    resetState();
    state.calls.length = 0;
    // 让 ai_invoke 抛错：临时替换实现
    const shell = makeShell();
    state.aiInvokeResult = {
      requestId: 'ai-2',
      ok: false,
      error: { code: 'TIMEOUT', message: '超时' },
    };
    const response = await shell.ai.invoke({ requestId: 'ai-2', method: 'listModels', params: {} });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('TIMEOUT');
  });

  it('ai.stream：分片按 requestId 过滤，done 之后自动退订', async () => {
    resetState();
    const shell = makeShell();
    const handle = shell.ai.stream({
      requestId: 'stream-1',
      purpose: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const events: string[] = [];
    handle.on((event) => events.push(event.type));

    await vi.waitFor(() => expect(state.channel).not.toBeNull());
    // 别的请求的分片不得串台
    state.channel?.onmessage?.({
      op: 'ai.stream',
      payload: { requestId: 'stream-other', event: { type: 'chunk', payload: { text: 'x' } } },
    });
    state.channel?.onmessage?.({
      op: 'ai.stream',
      payload: { requestId: 'stream-1', event: { type: 'chunk', payload: { text: 'a' } } },
    });
    state.channel?.onmessage?.({
      op: 'ai.stream',
      payload: {
        requestId: 'stream-1',
        event: { type: 'done', finishReason: 'stop', partial: false },
      },
    });
    expect(events).toEqual(['chunk', 'done']);

    // done 是终止帧 → 该请求的订阅释放（避免用久了订阅表被占满）
    await vi.waitFor(() => expect(state.unsubscriptions).toHaveLength(1));

    // 终止帧之后的迟到分片不再送达
    const before = events.length;
    state.channel?.onmessage?.({
      op: 'ai.stream',
      payload: { requestId: 'stream-1', event: { type: 'chunk', payload: { text: 'late' } } },
    });
    expect(events).toHaveLength(before);
  });

  it('ai.stream：AI 栈未接受时必须补 error + done（否则界面永远转圈）', async () => {
    resetState();
    state.aiStreamAccepted = false;
    state.aiStreamError = { code: 'NOT_SUPPORTED', message: 'AI 栈未装配' };
    const shell = makeShell();
    const handle = shell.ai.stream({
      requestId: 'stream-2',
      purpose: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const events: Array<{ type: string; error?: { code: string } }> = [];
    handle.on((event) => events.push(event as { type: string }));

    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[0]?.type).toBe('error');
    expect(events[0]?.error?.code).toBe('NOT_SUPPORTED');
    expect(events[1]?.type).toBe('done');
  });

  it('ai.abort 用 snake_case 参数名（与 Rust 的 rename_all 对齐）', async () => {
    resetState();
    const shell = makeShell();
    shell.ai.abort('stream-9');
    await vi.waitFor(() => expect(state.calls.some((item) => item.cmd === 'ai_abort')).toBe(true));
    const call = state.calls.find((item) => item.cmd === 'ai_abort');
    expect(call?.args).toEqual({ request_id: 'stream-9' });
  });
});
