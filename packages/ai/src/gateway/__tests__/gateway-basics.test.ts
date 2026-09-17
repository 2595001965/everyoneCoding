import { describe, it, expect, vi } from 'vitest';

import { DEFAULT_RETRY_POLICY, delayFor, shouldRetry, withRetry } from '../retry';
import { RequestQueue } from '../queue';
import { FailoverController } from '../failover';
import {
  AuthError,
  ContextLengthError,
  ProviderUnavailableError,
  RateLimitError,
  TimeoutError,
} from '../../core/error';

describe('重试策略', () => {
  it('只对可重试错误重试：401 / 上下文超限 / 内容过滤直接失败', () => {
    expect(shouldRetry(new TimeoutError())).toBe(true);
    expect(shouldRetry(new RateLimitError())).toBe(true);
    expect(shouldRetry(new ProviderUnavailableError())).toBe(true);
    expect(shouldRetry(new AuthError())).toBe(false);
    expect(shouldRetry(new ContextLengthError())).toBe(false);
    expect(shouldRetry(new Error('unknown'))).toBe(false);
  });

  it('退避时间指数增长且带抖动（500ms → 1000ms → 2000ms 量级）', () => {
    const noJitter = () => 0.5;
    expect(delayFor(1, DEFAULT_RETRY_POLICY, undefined, noJitter)).toBe(500);
    expect(delayFor(2, DEFAULT_RETRY_POLICY, undefined, noJitter)).toBe(1000);
    expect(delayFor(3, DEFAULT_RETRY_POLICY, undefined, noJitter)).toBe(2000);
    // 抖动上限不超过 maxDelayMs
    expect(delayFor(20, DEFAULT_RETRY_POLICY, undefined, () => 1)).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it('429 优先遵循服务端 Retry-After', () => {
    expect(delayFor(1, DEFAULT_RETRY_POLICY, 3000, () => 0.5)).toBeGreaterThanOrEqual(3000);
  });

  it('两次 429 后成功的事件序列正确', async () => {
    const sleeps: number[] = [];
    let attempt = 0;
    const result = await withRetry(
      async (index) => {
        attempt = index;
        if (index < 2) throw new RateLimitError('限流', 50);
        return 'ok';
      },
      DEFAULT_RETRY_POLICY,
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe('ok');
    expect(attempt).toBe(2);
    expect(sleeps).toHaveLength(2);
  });

  it('非重试类错误立即失败且不再 sleep', async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(withRetry(async () => { throw new AuthError(); }, DEFAULT_RETRY_POLICY, { sleep })).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it('重试次数用尽后抛出最后一次错误', async () => {
    await expect(
      withRetry(
        async () => {
          throw new ProviderUnavailableError();
        },
        { ...DEFAULT_RETRY_POLICY, maxRetries: 1 },
        { sleep: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('限流队列', () => {
  it('并发上限生效：超限请求排队而非丢弃', async () => {
    const queue = new RequestQueue();
    queue.configure('p1', { concurrency: 1, qps: 0 });

    const release1 = await queue.acquire('p1');
    expect(queue.running('p1')).toBe(1);

    let acquired = false;
    const pending = queue.acquire('p1').then((release) => {
      acquired = true;
      return release;
    });
    expect(queue.waiting('p1')).toBe(1);
    expect(acquired).toBe(false);

    release1();
    const release2 = await pending;
    expect(acquired).toBe(true);
    release2();
    expect(queue.running('p1')).toBe(0);
  });

  it('QPS 上限生效：同一秒内的第三个请求需等待', async () => {
    const queue = new RequestQueue();
    queue.configure('p2', { concurrency: 10, qps: 2 });

    const a = await queue.acquire('p2');
    const b = await queue.acquire('p2');
    const started: string[] = [];
    const events: number[] = [];
    queue.onEvent((event) => {
      if (event.type === 'enqueued') events.push(event.position);
    });
    const c = queue.acquire('p2').then((release) => {
      started.push('c');
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toHaveLength(0);
    a();
    b();
    await c;
    expect(started).toEqual(['c']);
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('容灾切换', () => {
  const providers = [
    { id: 'p1', order: 0, enabled: true, name: '主' },
    { id: 'p2', order: 1, enabled: true, name: '备' },
  ] as never[];

  it('连续失败达阈值后切换到下一个 Provider 并发事件', () => {
    const failover = new FailoverController({ failureThreshold: 2 });
    const events: string[] = [];
    failover.onEvent((event) => events.push(event.type));

    expect(failover.recordFailure('p1', 'boom')).toBe(false);
    expect(failover.isDegraded('p1')).toBe(false);
    expect(failover.recordFailure('p1', 'boom')).toBe(true);
    expect(failover.isDegraded('p1')).toBe(true);
    expect(events).toContain('degraded');

    failover.notifySwitch('p1', 'p2', '连续失败');
    expect(events).toContain('switch');
    expect(failover.next(providers, 'p1')?.id).toBe('p2');
  });

  it('成功后恢复，降级状态解除', () => {
    const failover = new FailoverController({ failureThreshold: 1 });
    failover.recordFailure('p1', 'boom');
    expect(failover.isDegraded('p1')).toBe(true);
    failover.recordSuccess('p1');
    expect(failover.isDegraded('p1')).toBe(false);
  });

  it('降级状态超过 resetAfterMs 自动解除', () => {
    const failover = new FailoverController({ failureThreshold: 1, resetAfterMs: 1000 });
    const now = Date.now();
    failover.recordFailure('p1', 'boom', now);
    expect(failover.isDegraded('p1', now + 500)).toBe(true);
    expect(failover.isDegraded('p1', now + 2000)).toBe(false);
  });
});
