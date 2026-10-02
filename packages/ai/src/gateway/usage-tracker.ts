import { type Logger, type V2EventEnvelope, type NormalizedUsage } from '@ec/core';
import { newUlid } from '@ec/data';
import { costForAttempt, type MeteredAttempt } from './metering-record';
import { safeRawUsage } from '../core/metering';

import type { UsageRepo, UsageTotals } from '../repo/usage-repo';
import { monthRange } from '../repo/usage-repo';
import type { UsagePurpose } from '../domain/purpose-binding';
import type { ModelPrice } from '../core/usage';
import { computeCost, type Usage } from '../core/usage';
import type { BudgetGuard } from './budget';
import { type BudgetDecision } from './budget';

/**
 * 用量统计（FR-AI-09）。
 *
 * 每次对话结束后按 provider / model / project / purpose 落一条 usage_record，
 * 并按月汇总；接近或超出预算时发出事件（UI 订阅后弹提示条）。
 */

export interface UsageEntry {
  userId: string;
  providerId: string | null;
  modelId: string | null;
  projectId?: string | null;
  purpose?: UsagePurpose | null;
  usage: Usage;
  price: ModelPrice | null;
  latencyMs: number | null;
}

export type UsageEvent =
  | { type: 'attempt-updated'; event: V2EventEnvelope }
  | { type: 'recorded'; userId: string; cost: number | null; complete: boolean }
  | { type: 'budget-warning'; userId: string; decision: Extract<BudgetDecision, { ok: true }> }
  | { type: 'budget-exceeded'; userId: string; decision: Extract<BudgetDecision, { ok: false }> };

export class UsageTracker {
  private readonly listeners = new Set<(event: UsageEvent) => void>();
  private warnedInMonth = new Set<string>();

  constructor(
    private readonly repo: UsageRepo,
    private readonly budget: BudgetGuard,
    private readonly logger: Logger | null = null,
  ) {}

  onEvent(listener: (event: UsageEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginAttempt(input: Omit<MeteredAttempt, 'attemptId' | 'revision' | 'cost'>): MeteredAttempt {
    const attempt: MeteredAttempt = { ...input, attemptId: newUlid(), revision: 1, cost: null };
    const event = this.repo.attempts.save(attempt);
    if (event) this.emit({ type: 'attempt-updated', event });
    return attempt;
  }

  updateAttempt(attempt: MeteredAttempt): MeteredAttempt {
    const next = { ...attempt, revision: attempt.revision + 1, cost: costForAttempt(attempt) };
    const event = this.repo.attempts.save(next);
    if (event) this.emit({ type: 'attempt-updated', event });
    if (next.endedAt !== null) this.checkBudget();
    return next;
  }

  /** 内部可信对账入口；不向 renderer 暴露写入。重复回调和重启重放保持幂等。 */
  correctFinal(
    userId: string,
    attemptId: string,
    eventId: string,
    final: NormalizedUsage,
    raw: unknown,
  ): MeteredAttempt {
    if (final.quality !== 'upstream_final') throw new Error('更正必须提供上游最终 usage');
    const current = this.repo.attempts.find(userId, attemptId);
    if (!current || current.endedAt === null) throw new Error('attempt 尚未结束或不存在');
    const next: MeteredAttempt = {
      ...current,
      normalized: final,
      rawUsage: safeRawUsage(raw),
      context: { ...current.context, measuredSentInputTokens: final.totalInput },
      usageSource: final.quality,
      billingState: 'estimated',
      revision: current.revision + 1,
    };
    next.cost = costForAttempt(next);
    const event = this.repo.attempts.save(next, eventId);
    if (event) {
      this.emit({ type: 'attempt-updated', event });
      this.checkBudget();
    }
    return event ? next : current;
  }

  recoverInterrupted(userId: string): void {
    for (const event of this.repo.attempts.recover(userId))
      this.emit({ type: 'attempt-updated', event });
  }

  /** 记录一次调用；返回入库的费用（单价缺失时为 null） */
  record(entry: UsageEntry): { cost: number | null; complete: boolean } {
    const cost = computeCost(entry.usage, entry.price);
    this.repo.record({
      userId: entry.userId,
      providerId: entry.providerId,
      modelId: entry.modelId,
      projectId: entry.projectId ?? null,
      purpose: entry.purpose ?? null,
      promptTokens: entry.usage.promptTokens,
      completionTokens: entry.usage.completionTokens,
      cost: cost.complete ? cost.total : null,
      latencyMs: entry.latencyMs,
    });

    this.logger?.debug('AI 用量已记录', {
      providerId: entry.providerId ?? '-',
      modelId: entry.modelId ?? '-',
      promptTokens: entry.usage.promptTokens,
      completionTokens: entry.usage.completionTokens,
      cost: cost.complete ? Number(cost.total.toFixed(6)) : null,
    });

    this.emit({
      type: 'recorded',
      userId: entry.userId,
      cost: cost.complete ? cost.total : null,
      complete: cost.complete,
    });
    this.checkBudget();
    return { cost: cost.complete ? cost.total : null, complete: cost.complete };
  }

  /** 月度汇总（含请求数、token、费用与"费用是否完整"标记） */
  monthly(userId: string, now: number = Date.now()): UsageTotals & { complete: boolean } {
    const totals = this.repo.monthly(userId, now);
    return { ...totals, complete: totals.complete };
  }

  byModel(
    userId: string,
    now: number = Date.now(),
  ): Array<{ modelId: string; totals: UsageTotals }> {
    const [since, until] = monthRange(now);
    return this.repo.byModel(userId, since, until);
  }

  budgetState(): BudgetDecision {
    return this.budget.check();
  }

  private checkBudget(): void {
    const userId = this.budget.userId();
    const decision = this.budget.check();
    if (!decision.ok) {
      this.emit({ type: 'budget-exceeded', userId, decision });
      return;
    }
    if (decision.warn && decision.warn.ratio >= 1) return;
    if (decision.warn) {
      const now = new Date();
      const period =
        decision.warn.scope === 'daily'
          ? `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`
          : `${now.getFullYear()}-${now.getMonth()}`;
      const warningKey = `${userId}:${period}:${decision.warn.scope}:${decision.warn.limit}`;
      if (this.warnedInMonth.has(warningKey)) return;
      this.warnedInMonth.add(warningKey);
      this.emit({ type: 'budget-warning', userId, decision });
    }
  }

  private emit(event: UsageEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.logger?.warn('用量订阅回调失败');
      }
    }
  }
}
