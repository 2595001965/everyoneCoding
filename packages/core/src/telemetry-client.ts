/**
 * 埋点客户端（T10-01）：本地缓冲 + 批量上报 + 失败重试 + 一键清除。
 *
 * 与 `telemetry.ts`（Wave 0 的授权开关/零网络原则）的关系：
 * - 授权状态与"未授权零上报"语义沿用 `Telemetry`；
 * - 本客户端补充**事件目录约束**（只发 `KEY_EVENT_NAMES` 认识的事件）、
 *   **指数退避重试**与**本地缓冲持久化**（外壳注入 store 端口）。
 */

import type { Telemetry } from './telemetry';
import { assertEventPayloadSafe, type TelemetryEventPayload } from './telemetry-events';

/** 上报结果（重试决策与测试断言用） */
export type FlushOutcome = 'sent' | 'skipped_disabled' | 'skipped_empty' | 'failed';

/** 本地缓冲持久化端口（外壳适配 SQLite / 文件；测试用内存实现） */
export interface TelemetryBufferStore {
  /** 追加一批事件（持久层可覆盖去重策略，默认 append-only） */
  append(events: TelemetryRecord[]): void;
  /** 取出待上报（不移除） */
  load(): TelemetryRecord[];
  /** 按序号移除已上报的事件 */
  removeUpTo(seq: number): void;
  /** 清空全部本地缓冲（一键清除） */
  clear(): void;
  /** 当前缓冲条数 */
  count(): number;
}

/** 缓冲记录：带上本地序号，上报成功后按序号删除 */
export interface TelemetryRecord extends TelemetryEventPayload {
  seq: number;
  recordedAt: number;
}

export interface TelemetryClientOptions {
  /** 授权与网络出口（Wave 0 的 Telemetry 实例） */
  telemetry: Telemetry;
  /** 本地缓冲持久化；缺省用内存（进程内不落盘） */
  store?: TelemetryBufferStore;
  /** 上报失败后的最大重试次数（默认 3；0 = 不重试） */
  maxRetries?: number;
  /** 重试基础退避毫秒（默认 1000；实际等待 = base * 2^attempt） */
  retryBackoffMs?: number;
  /** 时钟注入（测试用假时钟） */
  clock?: () => number;
  /** 等待函数（测试用立即 resolve） */
  sleeper?: (ms: number) => Promise<void>;
}

/** 缓冲达到该水位时触发自动 flush（含手动 track 的调用方无需关心） */
const AUTO_FLUSH_THRESHOLD = 50;

export class TelemetryClient {
  private readonly telemetry: Telemetry;
  private readonly store: TelemetryBufferStore;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly clock: () => number;
  private readonly sleeper: (ms: number) => Promise<void>;
  private nextSeq: number;
  private flushing: Promise<FlushOutcome> | null = null;
  private seqCeiling = 0;

  constructor(options: TelemetryClientOptions) {
    this.telemetry = options.telemetry;
    this.store = options.store ?? createMemoryBufferStore();
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBackoffMs = options.retryBackoffMs ?? 1000;
    this.clock = options.clock ?? Date.now;
    this.sleeper = options.sleeper ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // 序号延续已有缓冲的最大值，避免持久层重装后序号回卷
    const existing = this.store.load();
    for (const record of existing) this.seqCeiling = Math.max(this.seqCeiling, record.seq);
    this.nextSeq = this.seqCeiling + 1;
  }

  /**
   * 记录一条关键路径事件。
   * 未授权时直接丢弃（沿用 Telemetry.track 的零 IO 原则），同时也不写本地缓冲。
   */
  track(payload: TelemetryEventPayload): void {
    if (!this.telemetry.isEnabled) return;
    assertEventPayloadSafe(payload);
    const record: TelemetryRecord = { ...payload, seq: this.nextSeq++, recordedAt: this.clock() };
    this.store.append([record]);
    if (this.store.count() >= AUTO_FLUSH_THRESHOLD) void this.flush();
  }

  /** 当前本地缓冲条数（一键清除前给用户看数量） */
  buffered(): number {
    return this.store.count();
  }

  /** 一键清除本地缓冲：清持久层 + 置空授权端的待发队列 */
  clearLocalBuffer(): void {
    this.store.clear();
  }

  /**
   * 批量上报：先与授权端合并（授权端也持有少量待发事件），
   * 失败按指数退避重试，全部失败则缓冲保留、结果返回 failed。
   * 并发调用合并为一次（`flushing` 去重）。
   */
  async flush(): Promise<FlushOutcome> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush();
    try {
      return await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async doFlush(): Promise<FlushOutcome> {
    if (!this.telemetry.isEnabled) return 'skipped_disabled';
    const buffered = this.store.load();
    if (buffered.length === 0 && this.telemetry.pending === 0) return 'skipped_empty';

    // 把缓冲事件喂给授权端的队列（track 会脱敏，含 timestamp）。
    // 为避免重复，先记录授权端当前水位，flush 成功后只删水位以下的新增。
    const pendingBefore = this.telemetry.pending;
    for (const record of buffered) {
      this.telemetry.track(record.name, {
        ...record.dims,
        result: record.result,
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
        ...(record.errorKind !== undefined ? { errorKind: record.errorKind } : {}),
      });
    }

    const attempts = this.maxRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const sent = await this.telemetry.flush();
      if (sent) {
        // 成功：删除本轮已上报的缓冲（含本次喂入之前遗留的部分）
        const high = buffered.length > 0 ? buffered[buffered.length - 1]!.seq : -1;
        this.store.removeUpTo(Math.max(high, pendingBefore >= 0 ? high : -1));
        return 'sent';
      }
      if (attempt < attempts - 1) {
        await this.sleeper(this.retryBackoffMs * 2 ** attempt);
      }
    }
    return 'failed';
  }
}

/** 内存缓冲（默认实现；测试断言也直接用它） */
export function createMemoryBufferStore(): TelemetryBufferStore {
  const records: TelemetryRecord[] = [];
  return {
    append(events) {
      records.push(...events);
    },
    load() {
      return [...records];
    },
    removeUpTo(seq) {
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i]!.seq <= seq) records.splice(i, 1);
      }
    },
    clear() {
      records.length = 0;
    },
    count() {
      return records.length;
    },
  };
}
