// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { newUlid } from '@ec/data';
import { AgentStore, type GenerationOutput } from '@ec/ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openBusinessDb } from '../domain/db';
import { createCodeDomain } from '../domain/domains/code-domain';
import type { AiStackHandle } from '../domain/domain-factories';

let root: string;
let projectsDir: string;
let projectId: string;
let db: Database.Database;
let code: ReturnType<typeof createCodeDomain>;
let releaseModel: (() => void) | null;
let enteredModel: (() => void) | null;
let entered: Promise<void>;
let callCount: number;

const output: GenerationOutput = {
  files: [
    {
      path: 'src/app.ts',
      language: 'typescript',
      action: 'create',
      content: 'export const ready = true;\n',
    },
  ],
  anchors: [],
  summary: 'Create the starter module',
  notes: '',
  decision: { referencedMemory: [], rationale: 'Minimal starter', risks: [], uncovered: [] },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-d06-code-domain-'));
  projectsDir = join(root, 'projects');
  projectId = newUlid();
  mkdirSync(join(projectsDir, projectId, 'code'), { recursive: true });
  db = openBusinessDb({ dataDir: join(root, 'data') });
  db.prepare(
    "INSERT INTO project(id,user_id,name,status,created_at,updated_at) VALUES(?,'local-user','D06','active',?,?)",
  ).run(projectId, Date.now(), Date.now());
  callCount = 0;
  releaseModel = null;
  enteredModel = null;
  entered = new Promise((resolve) => {
    enteredModel = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const agentStore = new AgentStore(db, 'd06-code-domain', 1500);
  const aiStack = {
    agentStore,
    gateway: {
      chat: () =>
        (async function* () {
          callCount += 1;
          enteredModel?.();
          await waiting;
          yield { type: 'delta', text: JSON.stringify(output), model: 'fixture-model' };
          yield { type: 'done', finishReason: 'stop', partial: false };
        })(),
    },
  } as unknown as AiStackHandle;
  code = createCodeDomain({ db, projectsDir, userId: 'local-user', aiStack, emit: () => {} });
});

afterEach(async () => {
  await code.dispose();
  db.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('V2-D06 code-domain durable tasks', () => {
  it('persists one session/task for duplicate observers and resumes events from their cursor', async () => {
    const sessionId = newUlid();
    const request = {
      system: 'Generate code',
      user: 'Create the starter module',
      target: 'backend-code',
    };
    const ctx = { requestId: 'first-request', domain: 'code' as const, emit: () => {} };
    const first = await code.router(
      'startTask',
      {
        projectId,
        sessionId,
        idempotencyKey: 'same-request',
        request,
      },
      ctx,
    );
    await entered;
    const duplicate = await code.router(
      'startTask',
      {
        projectId,
        sessionId,
        idempotencyKey: 'same-request',
        request,
      },
      { ...ctx, requestId: 'retry-from-another-window' },
    );
    expect((duplicate as { task: { taskId: string } }).task.taskId).toBe(
      (first as { task: { taskId: string } }).task.taskId,
    );
    expect(callCount).toBe(1);

    releaseModel?.();
    const taskId = (first as { task: { taskId: string } }).task.taskId;
    const startedAt = Date.now();
    const final = await (async () => {
      while (Date.now() - startedAt < 5000) {
        const tasks = (await code.router('listTasks', { projectId }, ctx)) as Array<{
          task: { taskId: string; status: string };
          executionState: string;
        }>;
        const current = tasks.find((task) => task.task.taskId === taskId);
        if (current?.executionState === 'settled') return current;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('code task did not settle');
    })();
    expect(final.task.status).toBe('awaiting_confirmation');
    expect(callCount).toBe(1);

    const snapshot = (await code.router(
      'taskSnapshot',
      { projectId, sessionId, after: 0 },
      ctx,
    )) as {
      session: { sessionId: string };
      tasks: Array<{ task: { taskId: string } }>;
      events: Array<{ sequence: number; type: string }>;
      cursor: number;
    };
    expect(snapshot.session.sessionId).toBe(sessionId);
    expect(snapshot.tasks.map((task) => task.task.taskId)).toEqual([taskId]);
    expect(snapshot.events.map((event) => event.type)).toContain('agent.output.plan');
    const resumed = (await code.router(
      'taskSnapshot',
      { projectId, sessionId, after: snapshot.cursor },
      ctx,
    )) as { events: unknown[] };
    expect(resumed.events).toEqual([]);
  });
});
