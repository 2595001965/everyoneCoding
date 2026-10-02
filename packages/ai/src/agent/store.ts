import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { newUlid as ulid } from '@ec/data';
import {
  budgetSpecSchema,
  type AgentSession,
  type AgentTask,
  type V2EventEnvelope,
} from '@ec/core';

export interface TaskRecord {
  task: AgentTask;
  executionState: 'pending' | 'started' | 'settled' | 'unknown';
  request: Record<string, unknown>;
  checkpoint: unknown;
  result: unknown;
  error: string | null;
}
interface TaskRow {
  task_id: string;
  session_id: string;
  payload_json: string;
  request_json: string;
  execution_state: TaskRecord['executionState'];
  checkpoint_json: string | null;
  result_json: string | null;
  error: string | null;
  request_hash: string;
}
export class StaleAgentOwnerError extends Error {
  constructor() {
    super('协调器租约已过期或由其他进程持有');
    this.name = 'StaleAgentOwnerError';
  }
}

/** All execution mutations run under BEGIN IMMEDIATE and an exact, unexpired fence. */
export class AgentStore {
  readonly owner = randomUUID();
  token: number | null = null;
  constructor(
    readonly db: Database.Database,
    readonly dataDomain = 'local-agent',
    readonly leaseMs = 5000,
  ) {}

  acquire(): boolean {
    return this.db
      .transaction(() => {
        const now = Date.now();
        const row = this.db
          .prepare('SELECT * FROM agent_coordinator_lease WHERE data_domain = ?')
          .get(this.dataDomain) as
          { owner: string; fencing_token: number; expiry_at: number } | undefined;
        if (row && row.expiry_at > now && row.owner !== this.owner) return false;
        // An expired owner must obtain a new token, even if its process resumed.
        const token =
          row && row.owner === this.owner && row.expiry_at > now
            ? row.fencing_token
            : (row?.fencing_token ?? 0) + 1;
        this.db
          .prepare(
            `INSERT INTO agent_coordinator_lease VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(data_domain) DO UPDATE SET owner=excluded.owner, fencing_token=excluded.fencing_token,
        acquired_at=excluded.acquired_at, expiry_at=excluded.expiry_at`,
          )
          .run(this.dataDomain, this.owner, token, now, now + this.leaseMs);
        this.token = token;
        return true;
      })
      .immediate();
  }
  assertOwner(): void {
    const row = this.db
      .prepare(
        'SELECT owner, fencing_token, expiry_at FROM agent_coordinator_lease WHERE data_domain=?',
      )
      .get(this.dataDomain) as
      { owner: string; fencing_token: number; expiry_at: number } | undefined;
    if (
      !row ||
      row.owner !== this.owner ||
      row.fencing_token !== this.token ||
      row.expiry_at <= Date.now()
    )
      throw new StaleAgentOwnerError();
  }
  write<T>(fn: () => T): T {
    return this.db
      .transaction(() => {
        this.assertOwner();
        return fn();
      })
      .immediate();
  }
  renew(): void {
    this.write(() =>
      this.db
        .prepare('UPDATE agent_coordinator_lease SET expiry_at=? WHERE data_domain=?')
        .run(Date.now() + this.leaseMs, this.dataDomain),
    );
  }
  release(): void {
    if (this.token === null) return;
    this.write(() =>
      this.db
        .prepare('UPDATE agent_coordinator_lease SET expiry_at=0 WHERE data_domain=?')
        .run(this.dataDomain),
    );
    this.token = null;
  }

  /** Clients only append immutable submissions/commands; they cannot publish execution state. */
  submit(
    userId: string,
    projectId: string,
    sessionId: string,
    key: string,
    request: Record<string, unknown>,
  ): TaskRecord {
    const json = JSON.stringify(request);
    const hash = createHash('sha256').update(json).digest('hex');
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            'SELECT * FROM agent_task WHERE user_id=? AND session_id=? AND idempotency_key=?',
          )
          .get(userId, sessionId, key) as TaskRow | undefined;
        if (existing) {
          if (existing.request_hash !== hash) throw new Error('同一幂等键的任务内容不一致');
          return decodeTask(existing);
        }
        const session = this.session(userId, projectId, sessionId);
        if (session === null) {
          const now = Date.now();
          const value: AgentSession = {
            sessionId,
            projectId,
            title: null,
            route: null,
            contextState: {
              computedAt: null,
              estimatedNextInputTokens: null,
              routeWindowTokens: null,
              reservedOutputTokens: null,
            },
            budget: request['sessionBudget']
              ? budgetSpecSchema.parse(request['sessionBudget'])
              : null,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            revision: 1,
          };
          this.db
            .prepare('INSERT INTO agent_session VALUES (?,?,?,?)')
            .run(sessionId, userId, projectId, JSON.stringify(value));
        }
        const task: AgentTask = {
          taskId: ulid(),
          sessionId,
          projectId,
          objective: String(request['user'] ?? request['instruction'] ?? '代码生成'),
          status: 'queued',
          worktreeId: null,
          baseRevision: null,
          readSet: [],
          writeSet: [],
          budget: request['taskBudget'] ? budgetSpecSchema.parse(request['taskBudget']) : null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revision: 1,
        };
        this.db
          .prepare(
            `INSERT INTO agent_task (task_id,session_id,user_id,project_id,idempotency_key,request_hash,
        request_json,payload_json,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            task.taskId,
            sessionId,
            userId,
            projectId,
            key,
            hash,
            json,
            JSON.stringify(task),
            task.status,
            task.createdAt,
          );
        return this.get(userId, projectId, task.taskId);
      })
      .immediate();
  }
  session(userId: string, projectId: string, id: string): AgentSession | null {
    const row = this.db
      .prepare('SELECT user_id,project_id,payload_json FROM agent_session WHERE session_id=?')
      .get(id) as { user_id: string; project_id: string; payload_json: string } | undefined;
    if (!row) return null;
    if (row.user_id !== userId || row.project_id !== projectId)
      throw new Error('会话不属于当前用户/项目');
    return JSON.parse(row.payload_json) as AgentSession;
  }
  get(userId: string, projectId: string, id: string): TaskRecord {
    const row = this.db
      .prepare('SELECT * FROM agent_task WHERE task_id=? AND user_id=? AND project_id=?')
      .get(id, userId, projectId) as TaskRow | undefined;
    if (!row) throw new Error('任务不存在或无权访问');
    return decodeTask(row);
  }
  list(userId: string, projectId: string, sessionId?: string): TaskRecord[] {
    const rows =
      sessionId === undefined
        ? this.db
            .prepare(
              'SELECT * FROM agent_task WHERE user_id=? AND project_id=? ORDER BY created_at, rowid',
            )
            .all(userId, projectId)
        : this.db
            .prepare(
              'SELECT * FROM agent_task WHERE user_id=? AND project_id=? AND session_id=? ORDER BY created_at, rowid',
            )
            .all(userId, projectId, sessionId);
    return (rows as TaskRow[]).map(decodeTask);
  }
  command(
    userId: string,
    projectId: string,
    taskId: string,
    kind: string,
    payload: unknown = {},
  ): string {
    this.get(userId, projectId, taskId);
    const id = ulid();
    this.db
      .prepare('INSERT INTO agent_command VALUES (?,?,?,?,?,0)')
      .run(id, userId, taskId, kind, JSON.stringify(payload));
    return id;
  }
  update(record: TaskRecord, status = record.task.status): void {
    this.write(() => {
      record.task = {
        ...record.task,
        status,
        revision: record.task.revision + 1,
        updatedAt: Date.now(),
      };
      this.db
        .prepare(
          `UPDATE agent_task SET payload_json=?,status=?,execution_state=?,checkpoint_json=?,result_json=?,error=?,owner_token=? WHERE task_id=?`,
        )
        .run(
          JSON.stringify(record.task),
          status,
          record.executionState,
          JSON.stringify(record.checkpoint),
          JSON.stringify(record.result),
          record.error,
          this.token,
          record.task.taskId,
        );
    });
  }
  event(
    userId: string,
    record: TaskRecord,
    type: string,
    payload: unknown,
    key: string,
  ): V2EventEnvelope {
    return this.write(() => {
      const old = this.db
        .prepare('SELECT payload_json FROM agent_event WHERE dedup_key=?')
        .get(key) as { payload_json: string } | undefined;
      if (old) return JSON.parse(old.payload_json) as V2EventEnvelope;
      const event: V2EventEnvelope = {
        eventId: ulid(),
        type,
        sequence: 0,
        sequenceSource: this.dataDomain,
        dedupKey: key,
        occurredAt: Date.now(),
        requestId: null,
        attemptId: null,
        sessionId: record.task.sessionId,
        taskId: record.task.taskId,
        payload,
      };
      const insert = this.db
        .prepare(
          'INSERT INTO agent_event(event_id,user_id,session_id,task_id,dedup_key,payload_json) VALUES (?,?,?,?,?,?)',
        )
        .run(event.eventId, userId, record.task.sessionId, record.task.taskId, key, '{}');
      event.sequence = Number(insert.lastInsertRowid);
      this.db
        .prepare('UPDATE agent_event SET payload_json=? WHERE sequence=?')
        .run(JSON.stringify(event), event.sequence);
      return event;
    });
  }
  snapshot(userId: string, projectId: string, sessionId: string, after = 0) {
    return this.db.transaction(() => {
      const session = this.session(userId, projectId, sessionId);
      const events = (
        this.db
          .prepare(
            'SELECT payload_json FROM agent_event WHERE user_id=? AND session_id=? AND sequence>? ORDER BY sequence LIMIT 500',
          )
          .all(userId, sessionId, after) as { payload_json: string }[]
      ).map((row) => JSON.parse(row.payload_json) as V2EventEnvelope);
      return {
        session,
        tasks: this.list(userId, projectId, sessionId),
        events,
        cursor: events.at(-1)?.sequence ?? after,
      };
    })();
  }
}
function decodeTask(row: TaskRow): TaskRecord {
  return {
    task: JSON.parse(row.payload_json) as AgentTask,
    request: JSON.parse(row.request_json) as Record<string, unknown>,
    executionState: row.execution_state,
    checkpoint: row.checkpoint_json === null ? null : (JSON.parse(row.checkpoint_json) as unknown),
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
    error: row.error,
  };
}
