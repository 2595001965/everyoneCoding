import { z } from 'zod';
import type { UsageRepo } from '../repo/usage-repo';

const budgetSchema = z.object({
  dailyUsd: z.number().finite().nonnegative().nullable(),
  monthlyUsd: z.number().finite().nonnegative().nullable(),
  alertRatio: z.number().finite().positive().max(1),
});

/**
 * 预算护栏（FR-MDL-12）。
 *
 * - 日预算与月预算二选一或同时配置；未配置即不限
 * - 判定基于已落库的用量累加（重启后依然准确）
 * - 超限请求直接拒绝并给出明确提示，不做"偷偷放行"
 */

export interface BudgetConfig {
  /** 单日预算（美元）；null 表示不限 */
  dailyUsd: number | null;
  /** 月度预算（美元）；null 表示不限 */
  monthlyUsd: number | null;
  /** 触发告警的阈值比例（0~1） */
  alertRatio: number;
}

export const DEFAULT_BUDGET: BudgetConfig = { dailyUsd: null, monthlyUsd: null, alertRatio: 0.8 };

export type BudgetDecision =
  | { ok: true; warn?: { scope: 'daily' | 'monthly'; ratio: number; spent: number; limit: number } }
  | { ok: false; scope: 'daily' | 'monthly'; spent: number; limit: number; message: string };

export class BudgetGuard {
  private config: BudgetConfig;

  constructor(
    private readonly usage: UsageRepo,
    private readonly userIdValue: string,
    config: Partial<BudgetConfig> = {},
  ) {
    this.config = budgetSchema.parse({ ...DEFAULT_BUDGET, ...config });
  }

  /** 所属用户（事件回传用） */
  userId(): string {
    return this.userIdValue;
  }

  configure(patch: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  getConfig(): BudgetConfig {
    return { ...this.config };
  }

  /** 已花费（按自然日 / 自然月） */
  spent(): { daily: number; monthly: number } {
    const now = Date.now();
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    return {
      daily: this.usage.totals(this.userIdValue, dayStart, now).cost,
      monthly: this.usage.monthly(this.userIdValue, now).cost,
    };
  }

  /** 请求前检查：超限返回 ok=false */
  check(now: number = Date.now()): BudgetDecision {
    const { dailyUsd, monthlyUsd, alertRatio } = this.config;
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    const daily = this.usage.totals(this.userIdValue, dayStart, now).cost;
    const monthly = this.usage.monthly(this.userIdValue, now).cost;

    if (dailyUsd !== null && daily >= dailyUsd) {
      return {
        ok: false,
        scope: 'daily',
        spent: daily,
        limit: dailyUsd,
        message: `今日预算已用尽（$${daily.toFixed(4)} / $${dailyUsd.toFixed(2)}），可在设置中调整或明日再试`,
      };
    }
    if (monthlyUsd !== null && monthly >= monthlyUsd) {
      return {
        ok: false,
        scope: 'monthly',
        spent: monthly,
        limit: monthlyUsd,
        message: `本月预算已用尽（$${monthly.toFixed(4)} / $${monthlyUsd.toFixed(2)}），可在设置中调整或次月再试`,
      };
    }
    if (dailyUsd !== null && daily >= dailyUsd * alertRatio) {
      return {
        ok: true,
        warn: { scope: 'daily', ratio: daily / dailyUsd, spent: daily, limit: dailyUsd },
      };
    }
    if (monthlyUsd !== null && monthly >= monthlyUsd * alertRatio) {
      return {
        ok: true,
        warn: { scope: 'monthly', ratio: monthly / monthlyUsd, spent: monthly, limit: monthlyUsd },
      };
    }
    return { ok: true };
  }
}

export function describeBudget(decision: BudgetDecision): string {
  if (decision.ok) {
    if (!decision.warn) return '预算充足';
    const scope = decision.warn.scope === 'daily' ? '今日' : '本月';
    return `${scope}预算已使用 ${(decision.warn.ratio * 100).toFixed(0)}%（$${decision.warn.spent.toFixed(
      4,
    )} / $${decision.warn.limit.toFixed(2)}）`;
  }
  return decision.message;
}
