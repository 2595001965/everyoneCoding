import type { ShellHost } from '@ec/shell-api';
import { maskObject } from './redaction';

/**
 * 遥测（NFR-S-03）。
 *
 * 原则：
 * - 默认关闭，必须用户显式授权
 * - 未授权时**零网络调用**（不是"发了但被丢弃"）
 * - AI 请求内容默认不上传；仅上报不含内容的埋点（操作名、耗时、成功与否）
 */

export interface TelemetryEvent {
  name: string;
  /** 只允许结构化元数据，禁止塞入用户内容或 AI 上下文 */
  properties?: Record<string, string | number | boolean>;
  timestamp: number;
}

export type TelemetrySink = (events: TelemetryEvent[]) => void | Promise<void>;

export interface TelemetryOptions {
  enabled: boolean;
  /** 上报目标（用户自配）；未配置时启用也不发网络请求 */
  endpoint?: string;
  shell?: ShellHost;
  /** 自定义接收端（测试用） */
  sink?: TelemetrySink;
  /** 批量上报阈值 */
  batchSize?: number;
}

export class Telemetry {
  private enabled: boolean;
  private readonly queue: TelemetryEvent[] = [];
  private readonly options: TelemetryOptions;

  constructor(options: TelemetryOptions) {
    this.enabled = options.enabled;
    this.options = options;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 用户显式授权/撤销；撤销时清空待发队列 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.queue.length = 0;
  }

  /** 记录埋点；未启用时直接丢弃，不产生任何 IO */
  track(name: string, properties?: Record<string, string | number | boolean>): void {
    if (!this.enabled) return;
    this.queue.push({
      name,
      ...(properties !== undefined ? { properties: maskObject(properties) } : {}),
      timestamp: Date.now(),
    });
    if (this.queue.length >= (this.options.batchSize ?? 20)) {
      void this.flush();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  /** 上报并清空队列；未授权或无端点时直接返回 false，零网络调用 */
  async flush(): Promise<boolean> {
    if (!this.enabled || this.queue.length === 0) return false;

    const events = this.queue.splice(0, this.queue.length);
    if (this.options.sink) {
      try {
        await this.options.sink(events);
        return true;
      } catch {
        // sink 失败：事件回队，避免整批丢失（TelemetryClient 会退避重试）
        this.queue.unshift(...events);
        return false;
      }
    }
    const shell = this.options.shell;
    const endpoint = this.options.endpoint;
    if (!shell || !endpoint) {
      // 无接收端：丢弃，绝不静默发往任何默认服务器
      return false;
    }
    try {
      const host = new URL(endpoint).host;
      if (!shell.net.isHostAllowed(host)) return false;
      await shell.net.fetch({
        url: endpoint,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      return true;
    } catch {
      // 网络失败：事件回队，供下次 flush 重试
      this.queue.unshift(...events);
      return false;
    }
  }
}
