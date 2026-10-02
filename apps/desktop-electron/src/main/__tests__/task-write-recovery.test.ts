// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { AgentStore } from '@ec/ai';
import { createCliGitBackend, createNodeGitRunner } from '@ec/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskWriteService } from '../domain/task-write-service';

let bundleDir: string;
let worker: string;
const processes = new Set<ChildProcess>();
const directories: string[] = [];
beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'ec-d07-worker-'));
  worker = join(bundleDir, 'worker.cjs');
  await build({
    entryPoints: [
      resolve('apps/desktop-electron/src/main/__tests__/fixtures/task-write-worker.ts'),
    ],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
    banner: {
      js: `require=require('node:module').createRequire(${JSON.stringify(resolve('apps/desktop-electron/package.json'))});`,
    },
  });
});
afterAll(async () => {
  for (const child of processes) {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  for (const directory of [...directories, bundleDir])
    rmSync(directory, { recursive: true, force: true });
});
const waitFor = async (file: string, child?: ChildProcess): Promise<void> => {
  const start = Date.now();
  while (!existsSync(file)) {
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error(`worker exited ${child.exitCode}`);
    if (Date.now() - start > 10000) throw new Error(`worker timed out: ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const fixture = (mode: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'ec-d07-recovery-'));
  directories.push(directory);
  mkdirSync(join(directory, 'source'));
  for (const file of ['a.ts', 'b.ts']) writeFileSync(join(directory, 'source', file), 'old\n');
  const child = spawn(process.execPath, [worker, directory, mode], {
    windowsHide: true,
    stdio: 'pipe',
  });
  processes.add(child);
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('exit', () => processes.delete(child));
  return { directory, child, stderr: () => stderr };
};
const takeover = async (directory: string) => {
  const db = new Database(join(directory, 'owner.sqlite'));
  db.pragma('journal_mode=WAL');
  const store = new AgentStore(db, 'd07-test', 5000);
  const start = Date.now();
  while (!store.acquire()) {
    if (Date.now() - start > 3000) throw new Error('lease did not expire');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const service = new TaskWriteService({
    storageDir: join(directory, 'tasks'),
    codeRoot: () => join(directory, 'source'),
    git: createCliGitBackend({ runner: createNodeGitRunner() }),
    owner: {
      assertOwner: () => store.assertOwner(),
      fencingToken: () => store.token!,
      write: (action) => store.write(action),
    },
    validate: async () => {
      throw new Error('恢复不得重跑验证或确认');
    },
  });
  return { db, store, service };
};

describe('V2-D07 真实进程崩溃恢复与 D06 fencing', () => {
  it('强杀写入进程，接管按 journal 补偿，保留后续外部改动，重复恢复幂等', async () => {
    const { directory, child, stderr } = fixture('crash');
    try {
      await waitFor(join(directory, 'applied'), child);
    } catch (error) {
      throw new Error(`${String(error)} ${stderr()}`);
    }
    expect(readFileSync(join(directory, 'source/a.ts'), 'utf8')).toBe('task\n');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    writeFileSync(join(directory, 'source/a.ts'), 'external-after-crash\n');
    const owner = await takeover(directory);
    try {
      expect(owner.store.token).toBe(2);
      const recovered = await owner.service.recover();
      expect(recovered[0]?.state).toBe('conflicted');
      expect(recovered[0]?.result?.conflicts).toEqual(['a.ts']);
      expect(readFileSync(join(directory, 'source/a.ts'), 'utf8')).toBe('external-after-crash\n');
      expect(readFileSync(join(directory, 'source/b.ts'), 'utf8')).toBe('old\n');
      expect(await owner.service.recover()).toEqual([]);
      expect(readFileSync(join(directory, 'source/a.ts'), 'utf8')).toBe('external-after-crash\n');
    } finally {
      owner.store.release();
      owner.db.close();
    }
  }, 20000);

  it('租约过期的旧进程恢复后不能写；原文件与新 owner 的 token 保留', async () => {
    const { directory, child, stderr } = fixture('stale');
    try {
      await waitFor(join(directory, 'ready'), child);
    } catch (error) {
      throw new Error(`${String(error)} ${stderr()}`);
    }
    const owner = await takeover(directory);
    try {
      writeFileSync(join(directory, 'resume'), 'resume');
      await waitFor(join(directory, 'outcome'), child);
      expect(readFileSync(join(directory, 'outcome'), 'utf8')).toBe('fenced');
      expect(readFileSync(join(directory, 'source/a.ts'), 'utf8')).toBe('old\n');
      owner.store.assertOwner();
      expect(owner.store.token).toBe(2);
    } finally {
      owner.store.release();
      owner.db.close();
    }
  }, 20000);
});
