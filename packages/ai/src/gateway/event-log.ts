import { mask } from '@ec/core';

import type { GatewayEvent } from './client';
import type { FailoverEvent } from './failover';

/**
 * 网关运维事件记录（FR-MDL-10「切换时通知用户并记录」）。
 *
 * 只记「值得回看」的事件：容灾切换 / 降级 / 恢复、重试、预算拒绝、最终错误。
 * 每条都在入库前脱敏（原因文本常回显服务端报文，可能含 Key），
 * 环形缓冲定长，不会因为长时间故障把内存吃满。
 */

export interface AiEventRecord {
  at: number;
  kind:
    | 'failover'
    | 'degraded'
    | 'recovered'
    | 'retry'
    | 'budget-exceeded'
    | 'budget-warning'
    | 'error';
  providerId: string | null;
  toProviderId: string | null;
  message: string;
}

export class AiEventLog {
  private readonly records: AiEventRecord[] = [];

  constructor(
    private readonly capacity = 200,
    private readonly sink: ((record: AiEventRecord) => void) | null = null,
  ) {}

  fromGateway(event: GatewayEvent): void {
    switch (event.type) {
      case 'failover':
        // 切换本身由 FailoverController 的 switch 事件记录，这里不重复
        return;
      case 'retry':
        this.push({
          kind: 'retry',
          providerId: event.providerId,
          toProviderId: null,
          message: `第 ${event.attempt} 次重试（${event.delayMs}ms 后）：${event.reason}`,
        });
        return;
      case 'budget-exceeded':
      case 'budget-warning':
        this.push({
          kind: event.type,
          providerId: null,
          toProviderId: null,
          message: event.message,
        });
        return;
      case 'error':
        this.push({
          kind: 'error',
          providerId: event.error.providerId ?? null,
          toProviderId: null,
          message: event.error.message,
        });
        return;
      default:
        return;
    }
  }

  fromFailover(event: FailoverEvent): void {
    this.push({
      kind: event.type === 'switch' ? 'failover' : event.type,
      providerId: event.fromProviderId,
      toProviderId: event.toProviderId ?? null,
      message: event.reason,
      at: event.at,
    });
  }

  /** 最近的记录（新 → 旧） */
  recent(limit = 50): AiEventRecord[] {
    return this.records.slice(-Math.max(1, limit)).reverse();
  }

  clear(): void {
    this.records.length = 0;
  }

  private push(input: Omit<AiEventRecord, 'at'> & { at?: number }): void {
    const record: AiEventRecord = {
      at: input.at ?? Date.now(),
      kind: input.kind,
      providerId: input.providerId,
      toProviderId: input.toProviderId,
      message: mask(input.message),
    };
    this.records.push(record);
    if (this.records.length > this.capacity)
      this.records.splice(0, this.records.length - this.capacity);
    this.sink?.(record);
  }
}
