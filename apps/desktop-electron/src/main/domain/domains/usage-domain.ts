import type Database from 'better-sqlite3';

import { ShellError } from '@ec/shell-api';

import type { DomainRouter } from '../runtime';
import { createSettingStore, type SettingStore } from '../setting-store';

/**
 * usage 域生产路由（T12-05 用量与预算）。
 *
 * 数据源：usage_record 表（真实 AI gateway 写入路径）；
 * 预算读写走 `setting` 表的 `usage_budget` 键——**必须经 `createSettingStore`**，
 * 因为该表的真实列是 `value_json`（见迁移 0001），且 `user_id` 为 NOT NULL。
 * 早期直接写 `SELECT value FROM setting` 的版本在生产环境会
 * `SqliteError: no such column: value`，预算读写整体失效。
 */

export interface UsageDomainOptions {
  db: Database.Database;
  userId: string;
  /** 预算落库入口；缺省时按 options 自建（测试可注入内存实现） */
  settings?: SettingStore | undefined;
  /**
   * 预算变更回灌钩子（可选）。
   *
   * 为什么需要：`BudgetGuard` 在 AI 栈构造时装载一次配置并常驻内存，
   * 若设置页改了预算而不同步过去，"超限拒绝"要等到下次重启才生效——
   * 用户看到的是"改了预算却还在烧钱"。这里把变更即时推给运行中的网关。
   */
  onBudgetChanged?:
    | ((config: { dailyUsd: number | null; monthlyUsd: number | null; alertRatio: number }) => void)
    | undefined;
}

/** 预算持久化键（与 AI 栈装配侧共用同一口径） */
export const USAGE_BUDGET_SETTING_KEY = 'usage_budget';

interface UsageRow {
  provider_id: string | null;
  model_id: string | null;
  project_id: string | null;
  purpose: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number | null;
  latency_ms: number | null;
  created_at: number;
}

function monthRange(now: number): [number, number] {
  const start = new Date(now);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  end.setMilliseconds(-1);
  return [start.getTime(), end.getTime()];
}

export function createUsageDomain(options: UsageDomainOptions): DomainRouter {
  const settings: SettingStore =
    options.settings ?? createSettingStore({ db: options.db, userId: options.userId });

  const readBudget = (): {
    dailyUsd: number | null;
    monthlyUsd: number | null;
    alertRatio: number;
  } => {
    const stored = settings.read<Partial<ReturnType<typeof readBudget>>>(USAGE_BUDGET_SETTING_KEY);
    if (stored === null || typeof stored !== 'object') {
      return { dailyUsd: null, monthlyUsd: null, alertRatio: 0.8 };
    }
    // 逐字段校验：坏配置不得让预算静默变成"不限"
    const daily = stored.dailyUsd;
    const monthly = stored.monthlyUsd;
    const alert = stored.alertRatio;
    return {
      dailyUsd: typeof daily === 'number' && Number.isFinite(daily) && daily >= 0 ? daily : null,
      monthlyUsd:
        typeof monthly === 'number' && Number.isFinite(monthly) && monthly >= 0 ? monthly : null,
      alertRatio:
        typeof alert === 'number' && Number.isFinite(alert) && alert > 0 && alert <= 1
          ? alert
          : 0.8,
    };
  };

  const writeBudget = (config: {
    dailyUsd: number | null;
    monthlyUsd: number | null;
    alertRatio: number;
  }): void => {
    settings.write(USAGE_BUDGET_SETTING_KEY, config);
  };

  /** 预算判定（域侧与网关侧共用同一口径，避免两处算法漂移） */
  const decide = (
    config: ReturnType<typeof readBudget>,
  ): {
    ok: boolean;
    scope?: 'daily' | 'monthly' | undefined;
    spent?: number | undefined;
    limit?: number | undefined;
    message?: string | undefined;
    warn?: { scope: 'daily' | 'monthly'; ratio: number; spent: number; limit: number } | undefined;
  } => {
    const now = Date.now();
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    const [monthStart, monthEnd] = monthRange(now);
    const sumSince = (since: number, until: number): number => {
      const row = options.db
        .prepare(
          `SELECT COALESCE(SUM(cost), 0) AS total FROM usage_record WHERE user_id = ? AND created_at >= ? AND created_at <= ?`,
        )
        .get(options.userId, since, until) as { total: number };
      return row.total;
    };
    const daily = sumSince(dayStart, now);
    const monthly = sumSince(monthStart, monthEnd);
    if (config.dailyUsd !== null && daily >= config.dailyUsd) {
      return {
        ok: false,
        scope: 'daily',
        spent: daily,
        limit: config.dailyUsd,
        message: `今日预算已用尽（$${daily.toFixed(4)} / $${config.dailyUsd.toFixed(2)}）`,
      };
    }
    if (config.monthlyUsd !== null && monthly >= config.monthlyUsd) {
      return {
        ok: false,
        scope: 'monthly',
        spent: monthly,
        limit: config.monthlyUsd,
        message: `本月预算已用尽（$${monthly.toFixed(4)} / $${config.monthlyUsd.toFixed(2)}）`,
      };
    }
    const warnDaily =
      config.dailyUsd !== null && daily / config.dailyUsd >= config.alertRatio
        ? {
            scope: 'daily' as const,
            ratio: daily / config.dailyUsd,
            spent: daily,
            limit: config.dailyUsd,
          }
        : undefined;
    const warnMonthly =
      config.monthlyUsd !== null && monthly / config.monthlyUsd >= config.alertRatio
        ? {
            scope: 'monthly' as const,
            ratio: monthly / config.monthlyUsd,
            spent: monthly,
            limit: config.monthlyUsd,
          }
        : undefined;
    return {
      ok: true,
      ...((warnDaily ?? warnMonthly) ? { warn: warnDaily ?? warnMonthly } : {}),
    };
  };

  const router: DomainRouter = async (method, params) => {
    switch (method) {
      case 'listRows': {
        const [since, until] = monthRange(Date.now());
        const rows = options.db
          .prepare(
            `SELECT provider_id, model_id, project_id, purpose, prompt_tokens, completion_tokens,
                    total_tokens, cost, latency_ms, created_at
             FROM usage_record WHERE user_id = ? AND created_at >= ? AND created_at <= ?
             ORDER BY created_at DESC LIMIT 2000`,
          )
          .all(options.userId, since, until) as UsageRow[];
        return rows.map((row) => ({
          providerId: row.provider_id,
          modelId: row.model_id,
          projectId: row.project_id,
          purpose: row.purpose,
          promptTokens: row.prompt_tokens,
          completionTokens: row.completion_tokens,
          totalTokens: row.total_tokens,
          cost: row.cost,
          latencyMs: row.latency_ms,
          createdAt: row.created_at,
        }));
      }

      case 'getBudget':
        return readBudget();

      case 'setBudget': {
        const config = params['config'] as Record<string, unknown>;
        const daily = config['dailyUsd'];
        const monthly = config['monthlyUsd'];
        const alert = config['alertRatio'];
        if (daily !== null && typeof daily !== 'number') {
          throw new ShellError('INVALID_ARGUMENT', 'dailyUsd 必须为数字或 null');
        }
        if (monthly !== null && typeof monthly !== 'number') {
          throw new ShellError('INVALID_ARGUMENT', 'monthlyUsd 必须为数字或 null');
        }
        if (typeof alert !== 'number' || alert <= 0 || alert > 1) {
          throw new ShellError('INVALID_ARGUMENT', 'alertRatio 必须在 (0, 1] 区间');
        }
        writeBudget({
          dailyUsd: daily as number | null,
          monthlyUsd: monthly as number | null,
          alertRatio: alert,
        });
        // 即时回灌运行中的网关：预算变更必须当场生效，不能等重启
        options.onBudgetChanged?.({
          dailyUsd: daily as number | null,
          monthlyUsd: monthly as number | null,
          alertRatio: alert,
        });
        return undefined;
      }

      case 'budgetDecision':
        return decide(readBudget());

      default:
        throw new ShellError('INVALID_ARGUMENT', `usage 域未知方法：${method}`);
    }
  };

  return router;
}
