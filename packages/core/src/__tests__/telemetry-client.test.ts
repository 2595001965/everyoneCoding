/**
 * 埋点客户端测试（T10-01）：缓冲、批量上报、失败重试、一键清除、未授权零写入。
 */

import { describe, expect, it, vi } from 'vitest';

import { Telemetry } from '../telemetry';
import { TelemetryClient, createMemoryBufferStore, type TelemetryBufferStore } from '../telemetry-client';
import { buildEvent } from '../telemetry-events';
import type { TelemetrySink } from '../telemetry';

function makeTelemetry(options?: { sink?: TelemetrySink; enabled?: boolean }): Telemetry {
  return new Telemetry({
    enabled: options?.enabled ?? true,
    ...(options?.sink !== undefined ? { sink: options.sink } : {}),
  });
}

describe('TelemetryClient：缓冲与上报', () => {
  it('track 把事件写入本地缓冲', () => {
    const client = new TelemetryClient({ telemetry: makeTelemetry() });
    client.track(buildEvent('project.create', 'success', { dims: { projectId: 'p1' } }));
    expect(client.buffered()).toBe(1);
  });

  it('未授权时 track 直接丢弃，不写缓冲（零 IO 原则）', () => {
    const client = new TelemetryClient({ telemetry: makeTelemetry({ enabled: false }) });
    client.track(buildEvent('project.create', 'success'));
    expect(client.buffered()).toBe(0);
  });

  it('flush 成功后清空缓冲并返回 sent', async () => {
    const sent: unknown[] = [];
    const telemetry = makeTelemetry({
      sink: async (events) => {
        sent.push(...events);
      },
    });
    const client = new TelemetryClient({ telemetry });
    client.track(buildEvent('git.commit', 'success', { dims: { projectId: 'p1' } }));
    client.track(buildEvent('git.push', 'failure', { errorKind: 'NetworkError' }));
    const outcome = await client.flush();
    expect(outcome).toBe('sent');
    expect(client.buffered()).toBe(0);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ name: 'git.commit' });
  });

  it('上报失败按指数退避重试，最终成功只上报一次', async () => {
    let failures = 2;
    const sleeps: number[] = [];
    const telemetry = makeTelemetry({
      sink: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('网络不可达');
        }
      },
    });
    const client = new TelemetryClient({
      telemetry,
      retryBackoffMs: 100,
      sleeper: async (ms) => {
        sleeps.push(ms);
      },
    });
    client.track(buildEvent('package.export', 'success', { durationMs: 9000, dims: { bytes: 2_000_000 } }));
    const outcome = await client.flush();
    expect(outcome).toBe('sent');
    expect(sleeps).toEqual([100, 200]); // 100 * 2^0, 100 * 2^1
    expect(client.buffered()).toBe(0);
  });

  it('重试耗尽返回 failed 且缓冲保留（下次可续报）', async () => {
    const telemetry = makeTelemetry({
      sink: async () => {
        throw new Error('持续失败');
      },
    });
    const client = new TelemetryClient({ telemetry, maxRetries: 1, retryBackoffMs: 1, sleeper: async () => undefined });
    client.track(buildEvent('auth.login', 'success'));
    const outcome = await client.flush();
    expect(outcome).toBe('failed');
    expect(client.buffered()).toBe(1);
  });

  it('一键清除本地缓冲', () => {
    const client = new TelemetryClient({ telemetry: makeTelemetry() });
    client.track(buildEvent('project.open', 'success', { dims: { projectId: 'p1' } }));
    client.track(buildEvent('app.error', 'failure', { errorKind: 'X' }));
    expect(client.buffered()).toBe(2);
    client.clearLocalBuffer();
    expect(client.buffered()).toBe(0);
  });

  it('持久缓冲的序号延续（重启后不回卷）', () => {
    const store: TelemetryBufferStore = createMemoryBufferStore();
    const first = new TelemetryClient({ telemetry: makeTelemetry(), store });
    first.track(buildEvent('project.create', 'success'));
    const second = new TelemetryClient({ telemetry: makeTelemetry(), store });
    second.track(buildEvent('project.open', 'success'));
    const seqs = store.load().map((record) => record.seq);
    expect(seqs).toEqual([1, 2]);
  });

  it('并发 flush 合并为一次', async () => {
    let flushCount = 0;
    const telemetry = makeTelemetry({
      sink: async () => {
        flushCount += 1;
      },
    });
    const client = new TelemetryClient({ telemetry });
    client.track(buildEvent('git.commit', 'success'));
    const [a, b] = await Promise.all([client.flush(), client.flush()]);
    expect(a).toBe('sent');
    expect(b).toBe('sent');
    expect(flushCount).toBe(1);
  });

  it('缓冲达到水位自动触发上报', async () => {
    const sink = vi.fn(async () => undefined);
    const telemetry = makeTelemetry({ sink });
    const client = new TelemetryClient({ telemetry });
    for (let i = 0; i < 50; i++) {
      client.track(buildEvent('ai.request', 'success', { dims: { purpose: 'generate' } }));
    }
    // 自动 flush 是 void 异步，等微任务队列排空
    await vi.waitFor(() => expect(client.buffered()).toBe(0));
    expect(sink).toHaveBeenCalled();
  });

  it('未授权 flush 返回 skipped_disabled 且零网络调用', async () => {
    const sink = vi.fn(async () => undefined);
    const telemetry = makeTelemetry({ sink, enabled: false });
    const client = new TelemetryClient({ telemetry });
    const outcome = await client.flush();
    expect(outcome).toBe('skipped_disabled');
    expect(sink).not.toHaveBeenCalled();
  });
});
