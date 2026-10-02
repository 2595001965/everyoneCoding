// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Migrator } from '@ec/data';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgentStore } from '../store';

const USER = 'd06-user';
// 仓库根从本文件推导（src/agent/__tests__ → 上 5 级）：包配置与根配置的 cwd 不同，不能用相对路径
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'data', 'migrations');
const PROJECT = 'd06-project';
const DOMAIN = 'd06-process-test';
let bundleDir = '';
let worker = '';
const children = new Set<ChildProcess>();
const directories: string[] = [];
const databases = new Set<Database.Database>();
const buildWorker = createRequire(resolve(REPO_ROOT, 'apps/desktop-electron/package.json'))(
  'esbuild',
).build as (options: {
  entryPoints: string[];
  outfile: string;
  bundle: true;
  platform: 'node';
  format: 'cjs';
  external: string[];
  banner: { js: string };
}) => Promise<unknown>;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'ec-d06-worker-'));
  worker = join(bundleDir, 'coordinator-worker.cjs');
  await buildWorker({
    entryPoints: [
      resolve(REPO_ROOT, 'packages/ai/src/agent/__tests__/fixtures/coordinator-worker.ts'),
    ],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
    banner: {
      js: `require=require('node:module').createRequire(${JSON.stringify(resolve('packages/ai/package.json'))});`,
    },
  });
});

afterEach(async () => {
  for (const child of [...children]) await stopWorker(child, '', true);
  for (const db of databases) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  databases.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

afterAll(() => {
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

function scenario(): { directory: string; db: Database.Database; store: AgentStore } {
  const directory = mkdtempSync(join(tmpdir(), 'ec-d06-scenario-'));
  directories.push(directory);
  const db = new Database(join(directory, 'agent.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  Migrator.fromDirectory(db, MIGRATIONS_DIR).up();
  databases.add(db);
  return { directory, db, store: new AgentStore(db, DOMAIN, 1200) };
}

function submit(store: AgentStore, sessionId: string, key: string, user = 'work') {
  return store.submit(USER, PROJECT, sessionId, key, { system: 'system', user });
}

function startCoordinator(
  directory: string,
  dailyUsd: number | null = null,
  qps = 0,
): ChildProcess {
  const child = spawn(
    process.execPath,
    [worker, 'coordinator', directory, dailyUsd === null ? 'none' : String(dailyUsd), String(qps)],
    {
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, EC_MIGRATIONS_DIR: MIGRATIONS_DIR },
    },
  );
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function startSubmitter(
  directory: string,
  outputPath: string,
  sessionId: string,
  key: string,
  request: Record<string, unknown>,
): ChildProcess {
  const child = spawn(
    process.execPath,
    [worker, 'submit', directory, outputPath, sessionId, key, JSON.stringify(request)],
    {
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, EC_MIGRATIONS_DIR: MIGRATIONS_DIR },
    },
  );
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 12_000,
  watched: ChildProcess[] = [],
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    const exited = watched.find((child) => child.exitCode !== null || child.signalCode !== null);
    if (exited)
      throw new Error(
        `${message}; worker ${exited.pid} exited (${exited.exitCode ?? exited.signalCode})`,
      );
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stopWorker(child: ChildProcess, directory: string, force = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  if (!force && directory && child.pid !== undefined) {
    writeFileSync(join(directory, `stop-${child.pid}`), 'stop');
  } else {
    child.kill('SIGKILL');
  }
  try {
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      `worker ${child.pid} to exit`,
      5000,
    );
  } catch {
    child.kill('SIGKILL');
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      `worker ${child.pid} to be killed`,
      5000,
    );
  }
  children.delete(child);
}

function callIds(directory: string): string[] {
  const path = join(directory, 'upstream-calls.log');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
}

function ownerReports(directory: string): Array<{ pid: number; owner: string; token: number }> {
  return readdirSync(directory)
    .filter((name) => /^owner-\d+\.json$/.test(name))
    .map(
      (name) =>
        JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
          pid: number;
          owner: string;
          token: number;
        },
    );
}

describe('V2-D06 real cross-process coordination', () => {
  it('allows one owner, deduplicates a second-process submission, and never replays after owner death', async () => {
    const { directory, db, store } = scenario();
    const initial = submit(store, 'session-crash', 'same-logical-task', 'crash-recovery');
    const first = startCoordinator(directory);
    const second = startCoordinator(directory);
    await waitFor(
      () => existsSync(join(directory, `call-${initial.task.taskId}`)),
      'the owner to dispatch the task',
      12000,
      [first, second],
    );
    await new Promise((resolve) => setTimeout(resolve, 180));

    const reports = ownerReports(directory);
    expect(reports).toHaveLength(1);
    const lease = db
      .prepare('SELECT owner,fencing_token FROM agent_coordinator_lease WHERE data_domain=?')
      .get(DOMAIN) as { owner: string; fencing_token: number };
    expect(reports[0]?.owner).toBe(lease.owner);
    expect(lease.fencing_token).toBe(1);

    const observedPath = join(directory, 'observed-task.txt');
    const observer = startSubmitter(directory, observedPath, 'session-crash', 'same-logical-task', {
      system: 'system',
      user: 'crash-recovery',
    });
    await waitFor(
      () => existsSync(observedPath),
      'a second process to observe the same idempotent task',
      8000,
      [observer],
    );
    expect(readFileSync(observedPath, 'utf8')).toBe(initial.task.taskId);
    await waitFor(
      () => observer.exitCode !== null || observer.signalCode !== null,
      'the observer process to exit',
      8000,
      [observer],
    );
    await stopWorker(observer, '', true);
    expect(callIds(directory)).toEqual([initial.task.taskId]);

    const ownerPid = reports[0]!.pid;
    const ownerProcess = [first, second].find((child) => child.pid === ownerPid);
    const successor = ownerProcess === first ? second : first;
    expect(ownerProcess).toBeDefined();
    await stopWorker(ownerProcess!, '', true);
    await waitFor(
      () => {
        const current = store.get(USER, PROJECT, initial.task.taskId);
        const currentLease = db
          .prepare('SELECT fencing_token FROM agent_coordinator_lease WHERE data_domain=?')
          .get(DOMAIN) as { fencing_token: number };
        return current.executionState === 'unknown' && currentLease.fencing_token === 2;
      },
      'the successor to recover the interrupted task without replay',
      10000,
      [successor],
    );
    const snapshot = store.snapshot(USER, PROJECT, 'session-crash', 0);
    const firstCursor = snapshot.events.find(
      (event) => event.type === 'agent.test.dispatched',
    )?.sequence;
    expect(firstCursor).toBeDefined();
    expect(
      store.snapshot(USER, PROJECT, 'session-crash', firstCursor).events.map((event) => event.type),
    ).toContain('agent.task.reconciliation');
    expect(callIds(directory)).toEqual([initial.task.taskId]);
    await stopWorker(successor, directory);
  }, 25000);

  it('reserves one shared daily budget across processes before dispatching a second task', async () => {
    const { directory, store } = scenario();
    const firstTask = submit(store, 'session-budget-a', 'budget-a', 'a');
    const ownerA = startCoordinator(directory, 0.03);
    const ownerB = startCoordinator(directory, 0.03);
    await waitFor(
      () => existsSync(join(directory, `call-${firstTask.task.taskId}`)),
      'the first budgeted task to acquire a permit',
      12000,
      [ownerA, ownerB],
    );

    const secondTask = submit(store, 'session-budget-b', 'budget-b', 'b');
    await waitFor(
      () => store.get(USER, PROJECT, secondTask.task.taskId).executionState === 'settled',
      'the second task to be rejected by the shared reservation',
      12000,
      [ownerA, ownerB],
    );
    expect(store.get(USER, PROJECT, secondTask.task.taskId).task.status).toBe('failed');
    expect(callIds(directory)).toEqual([firstTask.task.taskId]);

    writeFileSync(join(directory, `release-${firstTask.task.taskId}`), 'release');
    await waitFor(
      () => store.get(USER, PROJECT, firstTask.task.taskId).task.status === 'completed',
      'the first task to settle',
      8000,
      [ownerA, ownerB],
    );
    await stopWorker(ownerA, directory);
    await stopWorker(ownerB, directory);
  }, 25000);

  it('applies the configured provider QPS limit through the shared gateway queue', async () => {
    const { directory, store } = scenario();
    const firstTask = submit(store, 'session-qps-a', 'qps-a', 'first');
    const secondTask = submit(store, 'session-qps-b', 'qps-b', 'second');
    const ownerA = startCoordinator(directory, null, 1);
    const ownerB = startCoordinator(directory, null, 1);
    await waitFor(
      () => existsSync(join(directory, `call-${firstTask.task.taskId}`)),
      'the first QPS-limited call to start',
      12000,
      [ownerA, ownerB],
    );
    await waitFor(
      () => existsSync(join(directory, `call-${secondTask.task.taskId}`)),
      'the next call to wait for the provider QPS window',
      5000,
      [ownerA, ownerB],
    );
    const firstAt = Number(
      readFileSync(join(directory, `started-${firstTask.task.taskId}`), 'utf8'),
    );
    const secondAt = Number(
      readFileSync(join(directory, `started-${secondTask.task.taskId}`), 'utf8'),
    );
    expect(secondAt - firstAt).toBeGreaterThanOrEqual(850);

    writeFileSync(join(directory, `release-${firstTask.task.taskId}`), 'release');
    writeFileSync(join(directory, `release-${secondTask.task.taskId}`), 'release');
    await waitFor(
      () => store.get(USER, PROJECT, firstTask.task.taskId).task.status === 'completed',
      'the first QPS-limited task to finish',
      8000,
      [ownerA, ownerB],
    );
    await waitFor(
      () => store.get(USER, PROJECT, secondTask.task.taskId).task.status === 'completed',
      'the second QPS-limited task to finish',
      8000,
      [ownerA, ownerB],
    );
    await stopWorker(ownerA, directory);
    await stopWorker(ownerB, directory);
  }, 25000);

  it('cancels one running task without aborting another session in the same process', async () => {
    const { directory, store } = scenario();
    const firstTask = submit(store, 'session-cancel-a', 'cancel-a', 'first');
    const secondTask = submit(store, 'session-cancel-b', 'cancel-b', 'second');
    const ownerA = startCoordinator(directory);
    const ownerB = startCoordinator(directory);
    await waitFor(
      () =>
        existsSync(join(directory, `call-${firstTask.task.taskId}`)) &&
        existsSync(join(directory, `call-${secondTask.task.taskId}`)),
      'both independent sessions to run concurrently',
      12000,
      [ownerA, ownerB],
    );

    store.command(USER, PROJECT, firstTask.task.taskId, 'cancel');
    await waitFor(
      () => store.get(USER, PROJECT, firstTask.task.taskId).task.status === 'cancelled',
      'only the requested task to cancel',
      8000,
      [ownerA, ownerB],
    );
    expect(store.get(USER, PROJECT, secondTask.task.taskId).task.status).toBe('running');
    expect(callIds(directory)).toHaveLength(2);

    writeFileSync(join(directory, `release-${secondTask.task.taskId}`), 'release');
    await waitFor(
      () => store.get(USER, PROJECT, secondTask.task.taskId).task.status === 'completed',
      'the other task to finish normally',
      8000,
      [ownerA, ownerB],
    );
    expect(callIds(directory)).toEqual([firstTask.task.taskId, secondTask.task.taskId]);
    await stopWorker(ownerA, directory);
    await stopWorker(ownerB, directory);
  }, 25000);

  it('pauses one task at its durable checkpoint, leaves another running, then resumes explicitly', async () => {
    const { directory, store } = scenario();
    const firstTask = submit(store, 'session-pause-a', 'pause-a', 'first');
    const secondTask = submit(store, 'session-pause-b', 'pause-b', 'second');
    const ownerA = startCoordinator(directory);
    const ownerB = startCoordinator(directory);
    await waitFor(
      () =>
        existsSync(join(directory, `call-${firstTask.task.taskId}`)) &&
        existsSync(join(directory, `call-${secondTask.task.taskId}`)),
      'both independent sessions to start',
      12000,
      [ownerA, ownerB],
    );

    store.command(USER, PROJECT, firstTask.task.taskId, 'pause');
    await waitFor(
      () => {
        const current = store.get(USER, PROJECT, firstTask.task.taskId);
        return (
          current.task.status === 'awaiting_confirmation' && current.executionState === 'paused'
        );
      },
      'the selected task to pause at its stored checkpoint',
      8000,
      [ownerA, ownerB],
    );
    expect(store.get(USER, PROJECT, firstTask.task.taskId).checkpoint).toMatchObject({
      stage: 'dispatched',
    });
    expect(store.get(USER, PROJECT, secondTask.task.taskId).task.status).toBe('running');
    expect(callIds(directory)).toHaveLength(2);

    store.command(USER, PROJECT, firstTask.task.taskId, 'resume');
    await waitFor(
      () => callIds(directory).filter((id) => id === firstTask.task.taskId).length === 2,
      'an explicit resume to continue from the checkpoint',
      8000,
      [ownerA, ownerB],
    );
    writeFileSync(join(directory, `release-${firstTask.task.taskId}`), 'release');
    await waitFor(
      () => store.get(USER, PROJECT, firstTask.task.taskId).task.status === 'completed',
      'the resumed task to finish',
      8000,
      [ownerA, ownerB],
    );
    writeFileSync(join(directory, `release-${secondTask.task.taskId}`), 'release');
    await waitFor(
      () => store.get(USER, PROJECT, secondTask.task.taskId).task.status === 'completed',
      'the other task to finish',
      8000,
      [ownerA, ownerB],
    );
    expect(callIds(directory).filter((id) => id === firstTask.task.taskId)).toHaveLength(2);
    await stopWorker(ownerA, directory);
    await stopWorker(ownerB, directory);
  }, 25000);
});
