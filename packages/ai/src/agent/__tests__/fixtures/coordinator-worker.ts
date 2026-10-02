import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Migrator } from '@ec/data';
import {
  AgentCoordinator,
  AgentGatewayControl,
  AgentStore,
  BudgetGuard,
  RequestQueue,
  UsageRepo,
  type Model,
  type Provider,
} from '@ec/ai';

const USER = 'd06-user';
const PROJECT = 'd06-project';
const DOMAIN = 'd06-process-test';

async function main(): Promise<void> {
  const [mode, directory, ...args] = process.argv.slice(2);
  if (!directory || !mode) throw new Error('missing worker arguments');
  const db = new Database(join(directory, 'agent.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  Migrator.fromDirectory(db, resolve('packages/data/migrations')).up();
  const store = new AgentStore(db, DOMAIN, 1200);

  if (mode === 'submit') {
    const [outputPath, sessionId, idempotencyKey, requestJson] = args;
    if (!outputPath || !sessionId || !idempotencyKey || !requestJson)
      throw new Error('missing submit arguments');
    const record = store.submit(
      USER,
      PROJECT,
      sessionId,
      idempotencyKey,
      JSON.parse(requestJson) as Record<string, unknown>,
    );
    writeFileSync(outputPath, record.task.taskId);
    db.close();
    return;
  }
  if (mode !== 'coordinator') throw new Error(`unknown worker mode: ${mode}`);

  const [dailyText = 'none', qpsText = '0'] = args;
  const dailyUsd = dailyText === 'none' ? null : Number(dailyText);
  const queue = new RequestQueue();
  queue.configure('d06-provider', { qps: Number(qpsText), concurrency: 3 });
  const gateway = new AgentGatewayControl(
    store,
    new BudgetGuard(new UsageRepo(db), USER, { dailyUsd, monthlyUsd: null }),
    () => {},
    queue,
  );
  const provider = { id: 'd06-provider', keyRef: 'd06-credential' } as Provider;
  const model = {
    capability: { inputPricePerMTok: 600, outputPricePerMTok: 600, maxOutput: 1 },
  } as Model;
  const coordinator = new AgentCoordinator(store, USER, async (record, execution) => {
    const taskId = record.task.taskId;
    const permit = await gateway.acquire(
      {
        userId: USER,
        purpose: 'code',
        projectId: PROJECT,
        ...(record.task.sessionId ? { sessionId: record.task.sessionId } : {}),
        taskId,
        logicalRequestId: taskId,
        messages: [{ role: 'user', content: String(record.request['user'] ?? 'work') }],
        maxTokens: 1,
        signal: execution.signal,
      },
      provider,
      model,
    );
    try {
      permit.assertOwner();
      execution.assertOwner();
      execution.checkpoint({ stage: 'dispatched', taskId });
      execution.event('agent.test.dispatched', { taskId });
      appendFileSync(join(directory, 'upstream-calls.log'), `${taskId}\n`);
      writeFileSync(join(directory, `call-${taskId}`), String(process.pid));
      writeFileSync(join(directory, `started-${taskId}`), String(Date.now()));
      const outcome = await waitForReleaseOrAbort(directory, taskId, permit.signal);
      const current = store.get(USER, PROJECT, taskId);
      if (outcome === 'aborted') {
        return {
          result: { outcome, taskId },
          status:
            current.task.status === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'cancelled',
        };
      }
      execution.event('agent.test.finished', { taskId });
      return { result: { outcome, taskId }, status: 'completed' };
    } finally {
      permit.finish(true);
    }
  });
  coordinator.start();

  const ownerPath = join(directory, `owner-${process.pid}.json`);
  const reportOwner = setInterval(() => {
    if (store.token !== null) {
      writeFileSync(
        ownerPath,
        JSON.stringify({ pid: process.pid, owner: store.owner, token: store.token }),
      );
    }
  }, 20);
  reportOwner.unref?.();

  const stopPath = join(directory, `stop-${process.pid}`);
  try {
    while (!existsSync(stopPath)) await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    clearInterval(reportOwner);
    await coordinator.dispose();
    gateway.dispose();
    db.close();
  }
}

async function waitForReleaseOrAbort(
  directory: string,
  taskId: string,
  signal: AbortSignal,
): Promise<'released' | 'aborted'> {
  const releasePath = join(directory, `release-${taskId}`);
  while (!existsSync(releasePath)) {
    if (signal.aborted) return 'aborted';
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return signal.aborted ? 'aborted' : 'released';
}

void main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
