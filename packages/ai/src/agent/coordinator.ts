import type { TaskStatus } from '@ec/core';
import type { AgentStore, TaskRecord } from './store';

export interface AgentExecution {
  signal: AbortSignal;
  checkpoint(value: unknown): void;
  event(type: string, payload: unknown): void;
  assertOwner(): void;
}
export type AgentExecutor = (
  record: TaskRecord,
  execution: AgentExecution,
) => Promise<{ result: unknown; status: TaskStatus }>;

/** One execution owner; every other process is a durable submitter/observer. */
export class AgentCoordinator {
  private readonly running = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeToken: number | null = null;
  private stopped = false;
  constructor(
    readonly store: AgentStore,
    private readonly userId: string,
    private readonly execute: AgentExecutor,
    private readonly concurrency = 3,
  ) {}
  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), Math.min(100, this.store.leaseMs / 3));
    this.timer.unref?.();
  }
  private tick(): void {
    if (this.stopped) return;
    try {
      if (this.store.token !== null) {
        // Never reacquire while an old stream is still alive in this process.
        this.store.renew();
      } else if (!this.store.acquire()) return;
      if (this.activeToken !== this.store.token) {
        this.recover();
        this.activeToken = this.store.token;
      }
      this.processCommands();
      const rows = this.store.db
        .prepare(
          `SELECT task_id,project_id FROM agent_task WHERE user_id=? AND status='queued' AND execution_state='pending' ORDER BY created_at,rowid`,
        )
        .all(this.userId) as { task_id: string; project_id: string }[];
      for (const row of rows) {
        if (this.running.size >= this.concurrency) break;
        const record = this.store.get(this.userId, row.project_id, row.task_id);
        const busy = this.store.db
          .prepare(
            `SELECT 1 FROM agent_task WHERE session_id=? AND (status='running' OR execution_state='unknown') LIMIT 1`,
          )
          .get(record.task.sessionId);
        if (busy) continue;
        record.executionState = 'started';
        this.store.write(() => {
          this.store.update(record, 'running');
          this.store.event(
            this.userId,
            record,
            'agent.task.started',
            { status: 'running' },
            `${record.task.taskId}:started:${record.task.revision}`,
          );
        });
        const controller = new AbortController();
        const promise = this.run(record, controller);
        this.running.set(record.task.taskId, { controller, promise });
      }
    } catch {
      for (const item of this.running.values()) item.controller.abort();
      // Forget the old fence only after all callbacks have stopped.
      if (this.running.size === 0) {
        this.store.token = null;
        this.activeToken = null;
      }
    }
  }
  private recover(): void {
    this.store.write(() => {
      const rows = this.store.db
        .prepare(
          `SELECT task_id,project_id FROM agent_task WHERE user_id=? AND execution_state='started'`,
        )
        .all(this.userId) as { task_id: string; project_id: string }[];
      for (const row of rows) {
        const record = this.store.get(this.userId, row.project_id, row.task_id);
        record.executionState = 'unknown';
        record.error = '协调器退出时上游执行结果未知，需查询上游与用量记录后对账；不会自动重发';
        this.store.update(record, 'conflicted');
        this.store.event(
          this.userId,
          record,
          'agent.task.reconciliation',
          { status: 'conflicted', reason: record.error },
          `${row.task_id}:unknown`,
        );
      }
      this.store.db
        .prepare(
          `UPDATE agent_gateway_permit SET state='unknown' WHERE state='active' AND owner_token != ?`,
        )
        .run(this.store.token);
    });
  }
  private processCommands(): void {
    const commands = this.store.db
      .prepare(`SELECT * FROM agent_command WHERE processed=0 AND user_id=? ORDER BY rowid`)
      .all(this.userId) as {
      command_id: string;
      task_id: string;
      kind: string;
      payload_json: string;
    }[];
    for (const command of commands) {
      this.store.write(() => {
        const row = this.store.db
          .prepare('SELECT project_id FROM agent_task WHERE task_id=?')
          .get(command.task_id) as { project_id: string };
        const record = this.store.get(this.userId, row.project_id, command.task_id);
        if (command.kind === 'cancel') {
          if (record.task.status === 'queued') {
            // 从未派发：没有执行器会回来收尾，这里直接落终态
            record.executionState = 'settled';
            this.store.update(record, 'cancelled');
          } else if (record.task.status === 'running') {
            // 只中断并标记状态；执行器完成时经 run() 落 settled 并带回部分结果，
            // 不能在这里抢先把 settled 写下去——wait() 会抢跑拿到 null result。
            this.running.get(command.task_id)?.controller.abort();
            this.store.update(record, 'cancelled');
          } else if (
            record.task.status === 'awaiting_confirmation' &&
            record.executionState === 'paused'
          ) {
            this.running.get(command.task_id)?.controller.abort();
            record.executionState = 'settled';
            this.store.update(record, 'cancelled');
          }
        } else if (command.kind === 'pause') {
          if (record.task.status === 'queued' || record.task.status === 'running') {
            this.running.get(command.task_id)?.controller.abort();
            record.executionState = this.running.has(command.task_id) ? 'paused' : 'pending';
            this.store.update(record, 'awaiting_confirmation');
          }
        } else if (command.kind === 'resume') {
          // Started tasks resume only from a durable checkpoint; the executor
          // validates that the checkpoint can safely continue its work.
          if (
            record.task.status === 'awaiting_confirmation' &&
            (record.executionState === 'pending' ||
              (record.executionState === 'paused' && record.checkpoint !== null))
          ) {
            record.executionState = 'pending';
            this.store.update(record, 'queued');
          }
        } else if (command.kind === 'reconcile' && record.executionState === 'unknown') {
          const payload = JSON.parse(command.payload_json) as {
            evidence?: string;
            result?: unknown;
          };
          if (typeof payload.evidence === 'string' && payload.evidence.trim()) {
            record.executionState = 'settled';
            record.result = payload.result ?? null;
            record.error = null;
            this.store.update(record, 'failed');
            // Permit release requires evidence; reconciliation never replays a request.
            this.store.db
              .prepare(
                `UPDATE agent_gateway_permit SET state='settled' WHERE task_id=? AND state='unknown'`,
              )
              .run(command.task_id);
          }
        }
        this.store.event(
          this.userId,
          record,
          'agent.task.updated',
          { status: record.task.status },
          `${command.command_id}:processed`,
        );
        this.store.db
          .prepare('UPDATE agent_command SET processed=1 WHERE command_id=?')
          .run(command.command_id);
      });
    }
  }
  private async run(record: TaskRecord, controller: AbortController): Promise<void> {
    let sequence = 0;
    const runRevision = record.task.revision;
    try {
      const output = await this.execute(record, {
        signal: controller.signal,
        assertOwner: () => this.store.assertOwner(),
        checkpoint: (value) => {
          record.checkpoint = value;
          this.store.write(() => {
            this.store.db
              .prepare('UPDATE agent_task SET checkpoint_json=? WHERE task_id=?')
              .run(JSON.stringify(value), record.task.taskId);
          });
        },
        event: (type, payload) => {
          this.store.event(
            this.userId,
            record,
            type,
            payload,
            `${record.task.taskId}:run:${runRevision}:output:${sequence++}`,
          );
        },
      });
      this.store.write(() => {
        const current = this.store.get(this.userId, record.task.projectId, record.task.taskId);
        record.task = current.task;
        record.result = output.result;
        const paused =
          current.task.status === 'awaiting_confirmation' && current.executionState === 'paused';
        record.executionState = paused ? 'paused' : 'settled';
        const status = ['cancelled', 'awaiting_confirmation'].includes(current.task.status)
          ? current.task.status
          : output.status;
        this.store.update(record, status);
        this.store.event(
          this.userId,
          record,
          'agent.task.completed',
          { status },
          `${record.task.taskId}:final:${record.task.revision}`,
        );
      });
    } catch (error) {
      try {
        this.store.write(() => {
          const current = this.store.get(this.userId, record.task.projectId, record.task.taskId);
          record.task = current.task;
          record.error = error instanceof Error ? error.message : String(error);
          const paused =
            current.task.status === 'awaiting_confirmation' && current.executionState === 'paused';
          const unresolvedPermit = this.store.db
            .prepare(
              "SELECT 1 FROM agent_gateway_permit WHERE task_id=? AND state IN ('active','unknown') LIMIT 1",
            )
            .get(record.task.taskId);
          const unknown = !paused && unresolvedPermit !== undefined;
          record.executionState = paused ? 'paused' : unknown ? 'unknown' : 'settled';
          const status = paused
            ? 'awaiting_confirmation'
            : unknown
              ? 'conflicted'
              : current.task.status === 'cancelled'
                ? 'cancelled'
                : 'failed';
          this.store.update(record, status);
          this.store.event(
            this.userId,
            record,
            unknown ? 'agent.task.reconciliation' : 'agent.task.updated',
            { status, reason: record.error },
            `${record.task.taskId}:${unknown ? 'unknown' : paused ? 'paused' : 'failed'}:${record.task.revision}`,
          );
        });
      } catch {
        /* A successor owns recovery; stale callbacks cannot write. */
      }
    } finally {
      this.running.delete(record.task.taskId);
    }
  }
  async wait(userId: string, projectId: string, taskId: string): Promise<TaskRecord> {
    for (;;) {
      const record = this.store.get(userId, projectId, taskId);
      if (
        record.executionState === 'settled' ||
        record.executionState === 'paused' ||
        record.executionState === 'unknown' ||
        (record.executionState === 'pending' && record.task.status !== 'queued')
      )
        return record;
      if (this.stopped) throw new Error('视图运行时已退出，任务可重新订阅');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    // Runtime shutdown loses the transport; unmounting a view never calls dispose.
    for (const item of this.running.values()) item.controller.abort();
    await Promise.allSettled([...this.running.values()].map((item) => item.promise));
    try {
      this.store.release();
    } catch {
      /* already fenced */
    }
  }
}
