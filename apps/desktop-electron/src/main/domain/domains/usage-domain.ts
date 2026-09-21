import type Database from 'better-sqlite3';

import { ShellError } from '@ec/shell-api';

import type { DomainRouter } from '../runtime';

/**
 * usage 域生产路由（T12-05 用量与预算）。
 *
 * 数据源：usage_record 表（真实 AI gateway 写入路径）；
 * 预算读写走 BudgetGuard 的持久化落点（setting 表的 usage_budget 键）。
 */

export interface UsageDomainOptions {
  db: Database.Database;
  userId: string;
}

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
  const readBudget = (): { dailyUsd: number | null; monthlyUsd: number | null; alertRatio: number } => {
    const row = options.db
      .prepare(`SELECT value FROM setting WHERE key = 'usage_budget'`)
      .get() as { value: string | null } | undefined;
    if (!row?.value) return { dailyUsd: null, monthlyUsd: null, alertRatio: 0.8 };
    try {
      return JSON.parse(row.value) as ReturnType<typeof readBudget>;
    } catch {
      return { dailyUsd: null, monthlyUsd: null, alertRatio: 0.8 };
    }
  };

  const writeBudget = (config: { dailyUsd: number | null; monthlyUsd: number | null; alertRatio: number }): void => {
    options.db
      .prepare(
        `INSERT INTO setting (key, value) VALUES ('usage_budget', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(config));
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
        return undefined;
      }

      case 'budgetDecision': {
        const config = readBudget();
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
            ? { scope: 'daily' as const, ratio: daily / config.dailyUsd, spent: daily, limit: config.dailyUsd }
            : undefined;
        const warnMonthly =
          config.monthlyUsd !== null && monthly / config.monthlyUsd >= config.alertRatio
            ? { scope: 'monthly' as const, ratio: monthly / config.monthlyUsd, spent: monthly, limit: config.monthlyUsd }
            : undefined;
        return {
          ok: true,
          ...(warnDaily ?? warnMonthly ? { warn: warnDaily ?? warnMonthly } : {}),
        };
      }

      default:
        throw new ShellError('INVALID_ARGUMENT', `usage 域未知方法：${method}`);
    }
  };

  return router;
}
