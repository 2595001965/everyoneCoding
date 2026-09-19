import type { Database } from 'better-sqlite3';
import { Repository, newUlid, type Row } from '@ec/data';
import type { UsageRecordRow } from '@ec/data';

import type { AiPurpose } from '../domain/purpose-binding';

/**
 * 用量仓库（FR-AI-09 / FR-MDL-12）。
 *
 * 统计口径：
 * - 月度按「自然月本地时区」切分
 * - 费用按每条记录入库时的单价累加；存在单价缺失记录时 `complete=false`，
 *   UI 需展示"部分模型缺少单价，费用为估算下限"
 */

export interface UsageRecord {
  id: string;
  userId: string;
  providerId: string | null;
  modelId: string | null;
  projectId: string | null;
  purpose: AiPurpose | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number | null;
  latencyMs: number | null;
  createdAt: number;
}

export interface UsageInput {
  userId: string;
  providerId?: string | null;
  modelId?: string | null;
  projectId?: string | null;
  purpose?: AiPurpose | null;
  promptTokens: number;
  completionTokens: number;
  cost: number | null;
  latencyMs?: number | null;
}

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  /** 单价缺失导致费用不全时为 false */
  complete: boolean;
}

export class UsageRepo {
  private readonly repo: Repository<UsageRecordRow & Row>;

  constructor(private readonly db: Database) {
    this.repo = new Repository<UsageRecordRow & Row>(db, 'usage_record');
  }

  record(input: UsageInput): UsageRecord {
    const now = Date.now();
    const prompt = Math.max(0, Math.round(input.promptTokens));
    const completion = Math.max(0, Math.round(input.completionTokens));
    const row: UsageRecordRow = {
      id: newUlid(),
      user_id: input.userId,
      provider_id: input.providerId ?? null,
      model_id: input.modelId ?? null,
      project_id: input.projectId ?? null,
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      cost: input.cost,
      purpose: input.purpose ?? null,
      latency_ms: input.latencyMs ?? null,
      created_at: now,
    };
    this.repo.insert(row as UsageRecordRow & Row, { timestamps: false });
    return toRecord(row);
  }

  /** 某时间范围内的汇总 */
  totals(userId: string, since: number, until: number = Date.now()): UsageTotals {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt,
                COALESCE(SUM(completion_tokens), 0) AS completion,
                COALESCE(SUM(total_tokens), 0) AS total,
                COALESCE(SUM(cost), 0) AS cost,
                SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS missing_cost
         FROM usage_record
         WHERE user_id = ? AND created_at >= ? AND created_at <= ?`,
      )
      .get(userId, since, until) as
      | {
          requests: number;
          prompt: number;
          completion: number;
          total: number;
          cost: number;
          missing_cost: number;
        }
      | undefined;

    return {
      requests: row?.requests ?? 0,
      promptTokens: row?.prompt ?? 0,
      completionTokens: row?.completion ?? 0,
      totalTokens: row?.total ?? 0,
      cost: row?.cost ?? 0,
      complete: (row?.missing_cost ?? 0) === 0,
    };
  }

  /** 自然月汇总（本地时区） */
  monthly(userId: string, now: number = Date.now()): UsageTotals {
    const [since, until] = monthRange(now);
    return this.totals(userId, since, until);
  }

  /** 按模型分组汇总 */
  byModel(
    userId: string,
    since: number,
    until: number = Date.now(),
  ): Array<{ modelId: string; totals: UsageTotals }> {
    const rows = this.db
      .prepare(
        `SELECT model_id,
                COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt,
                COALESCE(SUM(completion_tokens), 0) AS completion,
                COALESCE(SUM(total_tokens), 0) AS total,
                COALESCE(SUM(cost), 0) AS cost,
                SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS missing_cost
         FROM usage_record
         WHERE user_id = ? AND created_at >= ? AND created_at <= ?
         GROUP BY model_id`,
      )
      .all(userId, since, until) as Array<{
      model_id: string | null;
      requests: number;
      prompt: number;
      completion: number;
      total: number;
      cost: number;
      missing_cost: number;
    }>;

    return rows.map((row) => ({
      modelId: row.model_id ?? '(未记录)',
      totals: {
        requests: row.requests,
        promptTokens: row.prompt,
        completionTokens: row.completion,
        totalTokens: row.total,
        cost: row.cost,
        complete: row.missing_cost === 0,
      },
    }));
  }

  recent(userId: string, limit = 50): UsageRecord[] {
    return this.db
      .prepare('SELECT * FROM usage_record WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit)
      .map((row) => toRecord(row as UsageRecordRow));
  }
}

/** 自然月起止毫秒（本地时区），返回 [含首, 含尾] */
export function monthRange(now: number): [number, number] {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0).getTime();
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1, 0, 0, 0, 0).getTime() - 1;
  return [start, end];
}

function toRecord(row: UsageRecordRow): UsageRecord {
  return {
    id: row.id,
    userId: row.user_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    projectId: row.project_id,
    purpose: (row.purpose as AiPurpose | null) ?? null,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    cost: row.cost,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}
