import { newUlid } from '@ec/data';
import type { AgentSession, AgentTask } from '@ec/core';
import type { Model } from '../domain/model';
import type { Provider } from '../domain/provider';
import type { GatewayChatRequest } from '../gateway/client';
import type { BudgetGuard } from '../gateway/budget';
import { RequestQueue } from '../gateway/queue';
import type { QueueRelease } from '../gateway/queue';
import type { AgentStore } from './store';

export interface GatewayPermit {
  signal: AbortSignal;
  assertOwner(): void;
  finish(known: boolean): void;
}
export interface GatewayExecutionControl {
  acquire(request: GatewayChatRequest, provider: Provider, model: Model): Promise<GatewayPermit>;
  /** Diagnostic/draft calls still need the same fenced single-writer lease. */
  withOwner<T>(operation: () => Promise<T>): Promise<T>;
}

/** Reuses RequestQueue and BudgetGuard under the same cross-process execution lease. */
export class AgentGatewayControl implements GatewayExecutionControl {
  private readonly queue: RequestQueue;
  private readonly active = new Set<AbortController>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    readonly store: AgentStore,
    private readonly budget: BudgetGuard,
    private readonly refreshConfig: () => void = () => {},
    queue: RequestQueue = new RequestQueue(),
  ) {
    this.queue = queue;
    this.timer = setInterval(
      () => {
        if (store.token === null) return;
        try {
          store.renew();
        } catch {
          for (const controller of this.active) controller.abort();
        }
      },
      Math.min(1000, store.leaseMs / 3),
    );
    this.timer.unref?.();
  }
  async acquire(
    request: GatewayChatRequest,
    provider: Provider,
    model: Model,
  ): Promise<GatewayPermit> {
    if (this.store.token === null && !this.store.acquire())
      throw new Error('另一个协调器正在执行；请通过持久化任务提交');
    this.store.assertOwner();
    this.refreshConfig();
    const scopes = [
      'agent:global',
      // Share the exact provider limiter used by ordinary AiGateway requests.
      provider.id,
      `agent:provider:${provider.id}`,
      `agent:credential:${provider.keyRef ?? provider.id}`,
      ...(request.projectId ? [`agent:project:${request.projectId}`] : []),
      ...(request.sessionId ? [`agent:session:${request.sessionId}`] : []),
    ];
    const configuredProviderLimits = this.queue.limitsOf(provider.id);
    const limits = new Map<string, number>([
      ['agent:global', 3],
      [provider.id, configuredProviderLimits.concurrency || 3],
      [`agent:provider:${provider.id}`, configuredProviderLimits.concurrency || 3],
      [`agent:credential:${provider.keyRef ?? provider.id}`, 3],
      ...(request.projectId ? [[`agent:project:${request.projectId}`, 3] as const] : []),
      ...(request.sessionId ? [[`agent:session:${request.sessionId}`, 1] as const] : []),
    ]);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) controller.abort();
    this.active.add(controller);
    const releases: QueueRelease[] = [];
    try {
      // Keep Agent-wide scopes on the gateway queue; the provider scope inherits
      // the same persisted QPS/concurrency settings as AiGateway's provider queue.
      for (const scope of [...scopes].reverse()) {
        const concurrency = limits.get(scope) ?? 3;
        this.queue.configure(scope, {
          qps:
            scope === provider.id || scope === `agent:provider:${provider.id}`
              ? configuredProviderLimits.qps
              : 0,
          concurrency,
        });
        releases.push(await this.queue.acquire(scope, Symbol('agent-permit'), controller.signal));
      }
      if (configuredProviderLimits.qps > 0) {
        await this.waitForDurableQps(
          `agent:provider:${provider.id}`,
          configuredProviderLimits.qps,
          controller.signal,
        );
      }
      const id = newUlid();
      this.store.write(() => {
        this.store.db
          .prepare(
            `UPDATE agent_gateway_permit SET state='unknown' WHERE state='active' AND owner_token != ?`,
          )
          .run(this.store.token);
        const unknown = this.store.db
          .prepare(
            `SELECT p.scopes_json FROM agent_gateway_permit p
             LEFT JOIN agent_task t ON t.task_id=p.task_id
             WHERE p.state='unknown' AND
               (p.task_id IS NULL OR t.execution_state IN ('started','unknown'))`,
          )
          .all() as { scopes_json: string }[];
        for (const scope of scopes) {
          const heldSlots = unknown.filter((row) =>
            (JSON.parse(row.scopes_json) as string[]).includes(scope),
          ).length;
          const limit = limits.get(scope) ?? 3;
          if (heldSlots >= limit) throw new Error('上游执行结果待对账，当前执行槽位尚未释放');
        }
        const config = this.budget.getConfig();
        const sessionRow = request.sessionId
          ? (this.store.db
              .prepare('SELECT payload_json FROM agent_session WHERE session_id=? AND user_id=?')
              .get(request.sessionId, request.userId) as { payload_json: string } | undefined)
          : undefined;
        const taskRow = request.taskId
          ? (this.store.db
              .prepare('SELECT payload_json FROM agent_task WHERE task_id=? AND user_id=?')
              .get(request.taskId, request.userId) as { payload_json: string } | undefined)
          : undefined;
        const session = sessionRow ? (JSON.parse(sessionRow.payload_json) as AgentSession) : null;
        const task = taskRow ? (JSON.parse(taskRow.payload_json) as AgentTask) : null;
        const limited =
          config.dailyUsd !== null ||
          config.monthlyUsd !== null ||
          session?.budget != null ||
          task?.budget != null;
        const inputPrice = model.capability.inputPricePerMTok;
        const outputPrice = model.capability.outputPricePerMTok;
        if (limited && (inputPrice === null || outputPrice === null))
          throw new Error('价格未知，无法预留共享预算');
        // Conservative allowance, not measured token usage; no estimate is written to usage.
        const inputBound = new TextEncoder().encode(JSON.stringify(request.messages)).length;
        const outputBound = request.maxTokens ?? model.capability.maxOutput;
        if (limited && outputBound === null) throw new Error('输出上限未知，无法预留共享预算');
        const reserve =
          (inputBound * (inputPrice ?? 0) + (outputBound ?? 0) * (outputPrice ?? 0)) / 1_000_000;
        const held = (
          this.store.db
            .prepare(
              `SELECT COALESCE(SUM(reserved_usd),0) AS total FROM agent_gateway_permit WHERE user_id=? AND state!='settled'`,
            )
            .get(request.userId) as { total: number }
        ).total;
        const decision = this.budget.check(Date.now(), held + reserve);
        if (!decision.ok) throw new Error(decision.message);
        for (const [kind, entity] of [
          ['session', session],
          ['task', task],
        ] as const) {
          if (!entity?.budget) continue;
          if (entity.budget.limit.currency !== 'USD' || entity.budget.limit.micros < 0)
            throw new Error('本地网关预算需使用非负 USD 金额');
          const id = kind === 'session' ? request.sessionId : request.taskId;
          const spent = (
            this.store.db
              .prepare(
                `SELECT COALESCE(SUM(r.cost),0) AS total FROM usage_record r JOIN usage_attempt a ON a.attempt_id=r.attempt_id WHERE a.user_id=? AND a.${kind}_id=?`,
              )
              .get(request.userId, id) as { total: number }
          ).total;
          const reserved =
            kind === 'session'
              ? (
                  this.store.db
                    .prepare(
                      `SELECT COALESCE(SUM(p.reserved_usd),0) AS total FROM agent_gateway_permit p JOIN agent_task t ON p.task_id=t.task_id WHERE p.state!='settled' AND t.session_id=?`,
                    )
                    .get(id) as { total: number }
                ).total
              : (
                  this.store.db
                    .prepare(
                      `SELECT COALESCE(SUM(reserved_usd),0) AS total FROM agent_gateway_permit WHERE state!='settled' AND task_id=?`,
                    )
                    .get(id) as { total: number }
                ).total;
          if (spent + reserved + reserve >= entity.budget.limit.micros / 1_000_000)
            throw new Error(`${kind} 共享预算不足`);
        }
        this.store.db
          .prepare('INSERT INTO agent_gateway_permit VALUES (?,?,?,?,?,?,?,?)')
          .run(
            id,
            request.userId,
            request.taskId ?? null,
            JSON.stringify(scopes),
            reserve,
            Date.now(),
            this.store.token,
            'active',
          );
      });
      let finished = false;
      return {
        signal: controller.signal,
        assertOwner: () => this.store.assertOwner(),
        finish: (known) => {
          if (finished) return;
          finished = true;
          try {
            this.store.write(() => {
              const pending = request.logicalRequestId
                ? this.store.db
                    .prepare(
                      `SELECT 1 FROM usage_attempt WHERE user_id=? AND logical_request_id=? AND (status IN ('streaming','pending','unknown_pending_reconciliation') OR ended_at IS NULL) LIMIT 1`,
                    )
                    .get(request.userId, request.logicalRequestId)
                : undefined;
              this.store.db
                .prepare('UPDATE agent_gateway_permit SET state=? WHERE permit_id=?')
                .run(known && !pending ? 'settled' : 'unknown', id);
            });
          } finally {
            releases.reverse().forEach((release) => release());
            request.signal?.removeEventListener('abort', abort);
            this.active.delete(controller);
          }
        },
      };
    } catch (error) {
      releases.reverse().forEach((release) => release());
      request.signal?.removeEventListener('abort', abort);
      this.active.delete(controller);
      throw error;
    }
  }

  async withOwner<T>(operation: () => Promise<T>): Promise<T> {
    if (this.store.token === null && !this.store.acquire())
      throw new Error('另一个协调器正在执行；请通过持久化任务提交');
    this.store.assertOwner();
    this.refreshConfig();
    return operation();
  }
  dispose(): void {
    clearInterval(this.timer);
    for (const controller of this.active) controller.abort();
    this.queue.clear();
  }

  private async waitForDurableQps(scope: string, qps: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const waitMs = this.store.write(() => {
        const now = Date.now();
        const rows = this.store.db
          .prepare(
            'SELECT started_at, scopes_json FROM agent_gateway_permit WHERE started_at>=? ORDER BY started_at',
          )
          .all(now - 1000) as { started_at: number; scopes_json: string }[];
        const starts = rows
          .filter((row) => (JSON.parse(row.scopes_json) as string[]).includes(scope))
          .map((row) => row.started_at);
        return starts.length >= qps ? Math.max(1, (starts[0] ?? now) + 1000 - now) : 0;
      });
      if (waitMs === 0) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, waitMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    throw abortError();
  }
}

function abortError(): Error {
  const error = new Error('请求已中断');
  error.name = 'AbortError';
  return error;
}
