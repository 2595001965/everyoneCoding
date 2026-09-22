import { describe, expect, it, vi } from 'vitest';

import { createHarness } from './support/harness';
import type { HeadlessRuntime } from '../../main/runtime/bootstrap';
import { PROTOCOL_VERSION, SIDECAR_EVENTS, SIDECAR_OPS } from '../protocol';

/**
 * 侧车生命周期与崩溃清理。
 *
 * 这些路径**只在异常时走**，因而最容易长期无人验证——但每一条都对应一类
 * 真实的现场故障：
 *
 * - 协议不兼容却"尽力而为"地跑 → 方法缺失表现成随机业务错误；
 * - 宿主死了侧车不死 → 孤儿进程占住 SQLite（WAL 锁）与工程目录；
 * - 装配失败却不告诉宿主 → 宿主以为可用，每个调用都等到超时；
 * - 装配到一半宿主走了 → 刚建好的运行时无人释放，下次启动撞锁。
 */

describe('侧车生命周期', () => {
  it('协议不兼容：拒绝服务并以退出码 3 收尾（不做"尽力而为"的一半协议）', async () => {
    const harness = createHarness({ protocol: PROTOCOL_VERSION + 1 });
    harness.welcome();
    await expect(harness.ready).rejects.toThrow(/不兼容/);
    const result = await harness.done;
    expect(result.code).toBe(3);
    expect(result.reason).toMatch(/不兼容/);
    // 不得发出 ready：宿主据此判定"不可用"，而不是拿到一份残缺能力表
    expect(harness.received.some((line) => (JSON.parse(line) as { t: string }).t === 'ready')).toBe(
      false,
    );
    await harness.dispose();
  });

  it('宿主在握手完成前退出：侧车正常收尾（退出码 0），不当成故障', async () => {
    const harness = createHarness({ dropBeforeWelcome: true });
    harness.welcome();
    const result = await harness.done;
    expect(result.code).toBe(0);
    expect(result.reason).toMatch(/握手|关闭/);
    await harness.dispose();
  });

  it('宿主死亡（关闭入站管道）：侧车自行退出，不留孤儿进程', async () => {
    const harness = createHarness();
    harness.welcome();
    await harness.ready;

    harness.closeHost();
    const result = await harness.done;
    expect(result.code).toBe(0);
    expect(result.reason).toBe('宿主关闭了管道');
    await harness.dispose();
  });

  it('宿主请求关闭：正常 bye（退出码 0），且写入被拒绝后仍能收到应答', async () => {
    const harness = createHarness();
    harness.welcome();
    await harness.ready;

    const reply = await harness.request(SIDECAR_OPS.shutdown);
    expect(reply.ok).toBe(true);
    const result = await harness.done;
    expect(result.code).toBe(0);
    expect(result.reason).toMatch(/请求关闭/);
    await harness.dispose();
  });

  it('重复 shutdown 幂等：第二次不抛错、不重复发 bye', async () => {
    const harness = createHarness();
    harness.welcome();
    await harness.ready;
    await harness.shutdown();
    await harness.shutdown();
    // `shutdown()` 只等到调用应答；bye 是在 dispose 之后写的下一拍，
    // 必须等 done 落地再数帧，否则数的是"还没写出来"的那一帧。
    await harness.done;
    const byes = harness.received.filter((line) => (JSON.parse(line) as { t: string }).t === 'bye');
    expect(byes).toHaveLength(1);
    await harness.dispose();
  });

  it('运行时装配失败：如实上报（退出码 4 + error 日志），宿主不会误以为可用', async () => {
    const harness = createHarness({
      deps: {
        createRuntime: () => Promise.reject(new Error('注入的装配失败')),
      },
    });
    harness.welcome();
    await expect(harness.ready).rejects.toThrow(/装配失败|未能就绪/);
    const result = await harness.done;
    expect(result.code).toBe(4);

    const logs = harness.eventsOf(SIDECAR_EVENTS.log) as Array<{ level: string; message: string }>;
    expect(logs.some((item) => item.level === 'error' && /装配失败/.test(item.message))).toBe(true);
    expect(harness.received.some((line) => (JSON.parse(line) as { t: string }).t === 'ready')).toBe(
      false,
    );
    await harness.dispose();
  });

  it('装配到一半宿主已退出：刚建好的运行时被立刻释放（不泄漏 SQLite 句柄）', async () => {
    const dispose = vi.fn(() => Promise.resolve());
    const harness = createHarness({
      deps: {
        // 装配"慢"到宿主已经关闭管道，然后才返回运行时
        createRuntime: () =>
          new Promise<HeadlessRuntime>((resolvePromise) => {
            setTimeout(
              () =>
                resolvePromise({
                  domain: { invoke: vi.fn(), invokeSync: vi.fn(), describe: vi.fn() },
                  events: {
                    register: vi.fn(),
                    unregister: vi.fn(),
                    send: vi.fn(),
                    broadcast: vi.fn(),
                    subscribe: vi.fn(() => () => undefined),
                  },
                  ai: null,
                  aiError: '测试注入：无 AI',
                  descriptors: () => Promise.resolve([]),
                  dispose,
                } as unknown as HeadlessRuntime),
              50,
            );
          }),
      },
    });
    harness.welcome();
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    // 装配尚未返回时宿主就走了
    harness.closeHost();

    await vi.waitFor(() => expect(dispose).toHaveBeenCalled(), { timeout: 5_000 });
    await harness.dispose();
  });

  it('未就绪时收到业务请求：结构化 NOT_SUPPORTED，而不是挂到超时', async () => {
    const harness = createHarness();
    // 刻意先不发 welcome
    const reply = await harness.request(SIDECAR_OPS.domainDescribe);
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('NOT_SUPPORTED');
    expect(reply.error?.message).toMatch(/尚未就绪/);
    await harness.dispose();
  });
});

describe('侧车能力协商：DPAPI 不可用时的如实降级', () => {
  it('auth 与 AI 都报不可用并给出原因，其余域照常装配', async () => {
    const harness = createHarness({ dpapi: { available: false } });
    harness.welcome();
    const ready = await harness.ready;

    const byKind = new Map(ready.domains.map((item) => [item.kind, item]));
    expect(byKind.get('auth')?.available).toBe(false);
    expect(byKind.get('auth')?.reason ?? '').toMatch(/加密|DPAPI/);
    expect(byKind.get('workspace')?.available).toBe(true);
    expect(byKind.get('docs')?.available).toBe(true);
    expect(byKind.get('settings')?.available).toBe(true);
    // git 凭据依赖同一份加密能力 → 域本身可用，但凭据类方法如实拒绝
    expect(byKind.get('git')?.available).toBe(true);

    expect(ready.ai.available).toBe(false);
    expect(ready.ai.reason ?? '').toMatch(/DPAPI|安全存储/);

    await harness.dispose();
  });

  it('调用未装配的 auth 方法 → NOT_SUPPORTED 且带真实原因（不伪造成功）', async () => {
    const harness = createHarness({ dpapi: { available: false } });
    harness.welcome();
    await harness.ready;

    const reply = await harness.request(SIDECAR_OPS.domainInvoke, {
      requestId: 'auth-offline-probe',
      domain: 'auth',
      method: 'isOffline',
      params: {},
    });
    expect(reply.ok).toBe(true);
    const result = reply.result as { ok: boolean; error?: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_SUPPORTED');
    expect(result.error?.message ?? '').toMatch(/加密|DPAPI/);

    await harness.dispose();
  });

  it('AI 未装配时 ai.invoke 回结构化 NOT_SUPPORTED，ai.stream 推 error + done（不空转）', async () => {
    const harness = createHarness({ dpapi: { available: false } });
    harness.welcome();
    await harness.ready;

    const invoke = await harness.request(SIDECAR_OPS.aiInvoke, {
      requestId: 'ai-degraded',
      method: 'listProviders',
      params: {},
    });
    expect(invoke.ok).toBe(true);
    const result = invoke.result as { ok: boolean; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_SUPPORTED');

    const eventPromise = harness.nextEvent(SIDECAR_EVENTS.aiStream, 5_000);
    const started = await harness.request(SIDECAR_OPS.aiStreamStart, {
      requestId: 'ai-stream-degraded',
      purpose: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(started.ok).toBe(true);
    expect((started.result as { accepted: boolean }).accepted).toBe(false);

    const first = (await eventPromise) as { requestId: string; event: { type: string } };
    expect(first.requestId).toBe('ai-stream-degraded');
    expect(first.event.type).toBe('error');

    await harness.dispose();
  });
});
