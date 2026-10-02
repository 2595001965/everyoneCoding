import type { Database } from 'better-sqlite3';
import { newUlid } from '@ec/data';
import {
  addMoney, cacheHitRateOf, consumedTokensOf, usageAttemptSchema,
  type MoneyAmount, type NormalizedUsage, type V2EventEnvelope,
} from '@ec/core';
import type { MeteredAttempt } from '../gateway/metering-record';

export interface AttemptFilter {
  since?: number;
  until?: number;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  logicalRequestId?: string;
  providerId?: string;
  modelRowId?: string;
  route?: string;
  purpose?: string;
}
export type AttemptGroup = 'projectId' | 'sessionId' | 'taskId' | 'providerId' | 'modelRowId' | 'route' | 'purpose' | 'date';
export interface AttemptAggregate {
  attempts: number;
  logicalRequests: number;
  normalized: NormalizedUsage;
  consumedTokens: number | null;
  coverage: { measured: number; estimated: number; unknown: number; completeTokens: number; cache: number };
  cacheHitRate: ReturnType<typeof cacheHitRateOf>;
  costs: Array<{ amount: MoneyAmount; complete: boolean; coverage: number; kind: 'external_estimate' }>;
}

/** 使用 UsageRepo 同一个连接：attempt、兼容投影、可恢复事件在一个事务里更新。 */
export class AttemptStore {
  constructor(private readonly db: Database) {}

  find(userId: string, attemptId: string): MeteredAttempt | null {
    const row = this.db.prepare('SELECT payload_json FROM usage_attempt WHERE user_id = ? AND attempt_id = ?')
      .get(userId, attemptId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as MeteredAttempt : null;
  }

  list(userId: string, filter: AttemptFilter = {}): MeteredAttempt[] {
    const clauses = ['user_id = ?'];
    const values: Array<string | number> = [userId];
    for (const [key, column] of Object.entries({ projectId: 'project_id', sessionId: 'session_id',
      taskId: 'task_id', providerId: 'provider_id', modelRowId: 'model_id', logicalRequestId: 'logical_request_id',
      route: 'route', purpose: 'purpose' })) {
      const value = filter[key as keyof AttemptFilter];
      if (value !== undefined) { clauses.push(`${column} = ?`); values.push(value); }
    }
    if (filter.since !== undefined) { clauses.push('started_at >= ?'); values.push(filter.since); }
    if (filter.until !== undefined) { clauses.push('started_at <= ?'); values.push(filter.until); }
    const rows = this.db.prepare(`SELECT payload_json FROM usage_attempt WHERE ${clauses.join(' AND ')} ORDER BY started_at, attempt_id`)
      .all(...values) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as MeteredAttempt);
  }

  save(attempt: MeteredAttempt, correctionKey?: string): V2EventEnvelope | null {
    // 已保存模型必须遵守 D00 的公共路由契约；草稿允许明确的 null 路由。
    if (attempt.route !== null) usageAttemptSchema.parse(attempt);
    return this.db.transaction(() => {
      const key = correctionKey ? `correction:${attempt.userId}:${attempt.attemptId}:${correctionKey}`
        : `attempt:${attempt.attemptId}:${attempt.revision}`;
      if (this.db.prepare('SELECT 1 FROM usage_event WHERE dedup_key = ?').get(key)) return null;
      const existing = this.find(attempt.userId, attempt.attemptId);
      if (attempt.revision !== (existing?.revision ?? 0) + 1) {
        throw new Error('用量更正版本冲突，请读取最新 attempt');
      }
      this.db.prepare(`INSERT INTO usage_attempt
        (attempt_id,user_id,logical_request_id,provider_id,model_id,project_id,session_id,task_id,purpose,route,started_at,ended_at,status,revision,payload_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(attempt_id) DO UPDATE SET ended_at=excluded.ended_at,status=excluded.status,
          revision=excluded.revision,payload_json=excluded.payload_json`).run(
          attempt.attemptId, attempt.userId, attempt.logicalRequestId, attempt.providerId, attempt.modelRowId,
          attempt.projectId, attempt.sessionId, attempt.taskId, attempt.purpose, attempt.route,
          attempt.startedAt, attempt.endedAt, attempt.status, attempt.revision, JSON.stringify(attempt));
      this.project(attempt);
      const eventId = newUlid();
      const inserted = this.db.prepare(`INSERT INTO usage_event(event_id,user_id,attempt_id,dedup_key,envelope_json)
        VALUES (?,?,?,?,?)`).run(eventId, attempt.userId, attempt.attemptId, key, '{}');
      // 原始 usage 不进入跨窗口事件；快照只带身份、指标、上下文和成本估算。
      const { rawUsage: _raw, ...payload } = attempt;
      const event: V2EventEnvelope = { eventId, type: 'usage.updated', sequence: Number(inserted.lastInsertRowid),
        sequenceSource: `usage:${attempt.userId}`, dedupKey: key, occurredAt: Date.now(),
        requestId: attempt.logicalRequestId, attemptId: attempt.attemptId,
        sessionId: attempt.sessionId, taskId: attempt.taskId, payload };
      this.db.prepare('UPDATE usage_event SET envelope_json = ? WHERE event_id = ?').run(JSON.stringify(event), eventId);
      return event;
    })();
  }

  private project(attempt: MeteredAttempt): void {
    const usage = attempt.normalized;
    if (!usage || usage.totalInput === null || usage.totalOutput === null) return;
    const exists = (table: 'provider' | 'model' | 'project', id: string | null): string | null =>
      id && this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) ? id : null;
    const cost = attempt.cost?.complete && attempt.cost.total.currency === 'USD'
      ? attempt.cost.total.micros / 1_000_000 : null;
    this.db.prepare(`INSERT INTO usage_record
      (id,user_id,provider_id,model_id,project_id,purpose,prompt_tokens,completion_tokens,total_tokens,cost,latency_ms,created_at,attempt_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) WHERE attempt_id IS NOT NULL DO UPDATE SET
      prompt_tokens=excluded.prompt_tokens,completion_tokens=excluded.completion_tokens,total_tokens=excluded.total_tokens,
      cost=excluded.cost,latency_ms=excluded.latency_ms`).run(newUlid(), attempt.userId,
        exists('provider', attempt.providerId), exists('model', attempt.modelRowId), exists('project', attempt.projectId),
        attempt.purpose, usage.totalInput, usage.totalOutput, consumedTokensOf(usage), cost,
        attempt.endedAt === null ? null : attempt.endedAt - attempt.startedAt, attempt.startedAt, attempt.attemptId);
  }

  events(userId: string, after = 0, limit = 200): V2EventEnvelope[] {
    const rows = this.db.prepare('SELECT envelope_json FROM usage_event WHERE user_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
      .all(userId, after, Math.min(1000, Math.max(1, limit))) as Array<{ envelope_json: string }>;
    return rows.map((row) => JSON.parse(row.envelope_json) as V2EventEnvelope);
  }

  snapshot(userId: string, filter: AttemptFilter = {}): { attempts: MeteredAttempt[]; cursor: number } {
    return this.db.transaction(() => {
      const cursor = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS cursor FROM usage_event WHERE user_id = ?')
        .get(userId) as { cursor: number };
      return { attempts: this.list(userId, filter), cursor: cursor.cursor };
    })();
  }

  aggregate(userId: string, filter: AttemptFilter = {}, group?: AttemptGroup): Array<{ key: string | null; totals: AttemptAggregate }> {
    const groups = new Map<string | null, MeteredAttempt[]>();
    for (const attempt of this.list(userId, filter)) {
      const date = new Date(attempt.startedAt);
      const key = group === 'date' ? `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
        : group ? attempt[group] : null;
      groups.set(key, [...(groups.get(key) ?? []), attempt]);
    }
    if (!group && groups.size === 0) groups.set(null, []);
    return [...groups].map(([key, attempts]) => ({ key, totals: aggregateAttempts(attempts) }));
  }

  /** 启动恢复只处理上次进程未收尾的记录，不自动重发。由栈 owner 调用一次。 */
  recover(userId: string): V2EventEnvelope[] {
    const events: V2EventEnvelope[] = [];
    for (const attempt of this.list(userId)) {
      if (attempt.endedAt !== null) continue;
      const event = this.save({ ...attempt, endedAt: Date.now(), status: 'unknown_pending_reconciliation',
        billingState: 'unknown_pending_reconciliation', revision: attempt.revision + 1 });
      if (event) events.push(event);
    }
    return events;
  }
}

function aggregateAttempts(attempts: MeteredAttempt[]): AttemptAggregate {
  const sum = (field: 'totalInput' | 'uncachedInput' | 'cacheReadInput' | 'totalOutput' | 'reasoningOutput'): number | null => {
    const values = attempts.flatMap((a) => a.normalized?.[field] == null ? [] : [a.normalized[field]!]);
    return values.length ? values.reduce((a,b) => a+b,0) : null;
  };
  const writes: Record<string, number> = {};
  let writesKnown = false;
  const cacheCovered = attempts.filter((a) => a.normalized?.quality === 'upstream_final' &&
    a.normalized.totalInput !== null && a.normalized.cacheReadInput !== null);
  const cacheUsage: NormalizedUsage = { totalInput: cacheCovered.reduce((s,a) => s+a.normalized!.totalInput!,0),
    cacheReadInput: cacheCovered.length ? cacheCovered.reduce((s,a) => s+a.normalized!.cacheReadInput!,0) : null,
    uncachedInput: null, cacheWriteInputByTtl: null, totalOutput: null, reasoningOutput: null, quality: 'upstream_final' };
  const money = new Map<string, { amount: MoneyAmount; complete: boolean; coverage: number; kind: 'external_estimate' }>();
  for (const attempt of attempts) {
    if (attempt.normalized?.cacheWriteInputByTtl !== null && attempt.normalized?.cacheWriteInputByTtl !== undefined) {
      writesKnown = true;
      for (const [ttl,tokens] of Object.entries(attempt.normalized.cacheWriteInputByTtl)) writes[ttl]=(writes[ttl]??0)+tokens;
    }
    if (!attempt.cost) continue;
    const cost = attempt.cost;
    const prior = money.get(cost.total.currency);
    money.set(cost.total.currency, { amount: prior ? addMoney(prior.amount,cost.total) : cost.total,
      complete: (prior?.complete ?? true) && cost.complete, coverage: (prior?.coverage ?? 0)+1, kind: 'external_estimate' });
  }
  const normalized: NormalizedUsage = { totalInput: sum('totalInput'), uncachedInput: sum('uncachedInput'),
    cacheReadInput: sum('cacheReadInput'), cacheWriteInputByTtl: writesKnown ? writes : null,
    totalOutput: sum('totalOutput'), reasoningOutput: sum('reasoningOutput'), quality: 'unknown' };
  const complete = attempts.filter((a) => a.normalized && consumedTokensOf(a.normalized) !== null);
  return { attempts: attempts.length, logicalRequests: new Set(attempts.map((a)=>a.logicalRequestId)).size,
    normalized, consumedTokens: complete.length ? complete.reduce((s,a)=>s+consumedTokensOf(a.normalized!)!,0) : null,
    coverage: { measured: attempts.filter((a)=>a.usageSource==='upstream_final').length,
      estimated: attempts.filter((a)=>a.usageSource==='stream_estimate').length,
      unknown: attempts.filter((a)=>a.usageSource==='unknown').length, completeTokens: complete.length, cache: cacheCovered.length },
    cacheHitRate: cacheHitRateOf(cacheUsage), costs: [...money.values()].map((cost)=>({ ...cost,
      complete: cost.complete && cost.coverage===attempts.length })) };
}
