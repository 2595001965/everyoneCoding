import type { Provider } from '../domain/provider';

/**
 * 多 Provider 容灾（FR-MDL-10）。
 *
 * 规则：
 * - 同一 Provider 连续失败 N 次即标记为降级，切换下一个（按 sort_order）
 * - 成功后计数清零
 * - 降级状态在 `resetAfterMs` 后自动解除，避免"一次抖动永久拉黑"
 * - 切换前发事件通知 UI，切换动作写日志（含原因）
 */

export interface FailoverPolicy {
  /** 连续失败多少次触发切换 */
  failureThreshold: number;
  /** 降级状态自动解除时间（毫秒） */
  resetAfterMs: number;
}

export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = {
  failureThreshold: 2,
  resetAfterMs: 5 * 60_000,
};

export interface FailoverEvent {
  type: 'degraded' | 'recovered' | 'switch';
  fromProviderId: string;
  toProviderId?: string;
  reason: string;
  at: number;
}

export class FailoverController {
  private readonly failures = new Map<string, { count: number; since: number }>();
  private readonly listeners = new Set<(event: FailoverEvent) => void>();
  private policy: FailoverPolicy;

  constructor(policy: Partial<FailoverPolicy> = {}) {
    this.policy = { ...DEFAULT_FAILOVER_POLICY, ...policy };
  }

  configure(patch: Partial<FailoverPolicy>): void {
    this.policy = { ...this.policy, ...patch };
  }

  onEvent(listener: (event: FailoverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 当前是否处于降级状态（含自动解除判定） */
  isDegraded(providerId: string, now: number = Date.now()): boolean {
    const record = this.failures.get(providerId);
    if (!record) return false;
    if (now - record.since > this.policy.resetAfterMs) {
      this.failures.delete(providerId);
      return false;
    }
    return record.count >= this.policy.failureThreshold;
  }

  failureCount(providerId: string, now: number = Date.now()): number {
    if (this.isDegraded(providerId, now)) return this.failures.get(providerId)?.count ?? 0;
    return this.failures.get(providerId)?.count ?? 0;
  }

  /** 记录一次失败；返回 true 表示已达到切换阈值 */
  recordFailure(providerId: string, reason: string, now: number = Date.now()): boolean {
    const record = this.failures.get(providerId);
    const count = (record?.count ?? 0) + 1;
    this.failures.set(providerId, { count, since: record?.since ?? now });
    if (count === this.policy.failureThreshold) {
      this.emit({ type: 'degraded', fromProviderId: providerId, reason, at: now });
    }
    return count >= this.policy.failureThreshold;
  }

  /** 记录一次成功；若此前处于降级则发出恢复事件 */
  recordSuccess(providerId: string, now: number = Date.now()): void {
    const record = this.failures.get(providerId);
    this.failures.delete(providerId);
    if (record && record.count >= this.policy.failureThreshold) {
      this.emit({ type: 'recovered', fromProviderId: providerId, reason: '请求成功', at: now });
    }
  }

  /**
   * 在候选列表里挑下一个可用 Provider。
   * 顺序：当前 Provider 未降级则用它，否则按 sort_order 找第一个未降级的。
   */
  next(
    providers: readonly Provider[],
    preferredId?: string,
    now: number = Date.now(),
  ): Provider | null {
    const sorted = [...providers]
      .filter((provider) => provider.enabled)
      .sort((a, b) => a.order - b.order);
    if (sorted.length === 0) return null;
    if (preferredId) {
      const preferred = sorted.find((provider) => provider.id === preferredId);
      if (preferred && !this.isDegraded(preferred.id, now)) return preferred;
    }
    return sorted.find((provider) => !this.isDegraded(provider.id, now)) ?? null;
  }

  /** 发生切换时通知 UI（谁 → 谁、原因） */
  notifySwitch(fromProviderId: string, toProviderId: string, reason: string): void {
    this.emit({ type: 'switch', fromProviderId, toProviderId, reason, at: Date.now() });
  }

  reset(): void {
    this.failures.clear();
  }

  private emit(event: FailoverEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
