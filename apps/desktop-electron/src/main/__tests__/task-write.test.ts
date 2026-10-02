// @vitest-environment node
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliGitBackend, createNodeGitRunner, type GitBackend } from '@ec/git';
import type { GenerationOutput } from '@ec/ai';
import { TaskWriteService, type TaskWriteServiceOptions } from '../domain/task-write-service';
import { taskFileSystem } from '../domain/task-file-system';

let directory: string;
let root: string;
let git: GitBackend;
let service: TaskWriteService;
const fixture = (files: Record<string, string>): void => {
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
};
const output = (path: string, before: string, after: string): GenerationOutput => ({
  files: [
    {
      path,
      language: 'typescript',
      action: 'patch',
      content: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}`,
    },
  ],
  anchors: [],
  summary: '测试任务',
  notes: '',
  decision: { referencedMemory: [], rationale: 'test', risks: [], uncovered: [] },
});
const options = (): TaskWriteServiceOptions => ({
  storageDir: join(directory, 'tasks'),
  codeRoot: () => root,
  git,
  owner: { assertOwner: () => undefined, fencingToken: () => 1, write: (action) => action() },
  validate: async (cwd, paths) => [
    {
      name: 'affected-source-check',
      ok: paths.every((path) => readFileSync(join(cwd, path), 'utf8').length > 0),
      detail: '真实磁盘受影响文件验证',
    },
  ],
});
async function plan(path: string, before: string, after: string, readSet: string[] = []) {
  return service.planOutput('p', output(path, before, after), 'preview', {
    baseline: 'current',
    readSet,
  });
}
const child = async (script: string, args: string[] = []): Promise<number | null> =>
  new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['-e', script, ...args], {
      windowsHide: true,
      stdio: 'pipe',
    });
    process.on('error', reject);
    process.on('exit', resolve);
  });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ec-d07-'));
  // CI 的 TEMP 是 8.3 短路径（RUNNER~1）而 git 返回规范长路径：入口即归一，全链路单一形态
  directory = realpathSync.native(directory);
  root = join(directory, 'source');
  mkdirSync(root);
  git = createCliGitBackend({ runner: createNodeGitRunner() });
  service = new TaskWriteService(options());
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('V2-D07 真实工作副本与合入', () => {
  it('非 Git 不 init/commit，工作副本与空数据目录隔离，确认后才改原目录', async () => {
    fixture({ 'a.ts': 'old\n', '.env': 'LOCAL_ENV_VALUE', 'app.sqlite': 'local-data' });
    const candidate = await plan('a.ts', 'old', 'new');
    const task = service.get(candidate.taskId!);
    expect(task.worktreeRoot).toBeNull();
    expect(existsSync(join(root, '.git'))).toBe(false);
    expect(existsSync(join(task.copyRoot, '.env'))).toBe(false);
    expect(existsSync(join(task.copyRoot, 'app.sqlite'))).toBe(false);
    expect(task.dataDir).not.toBe(root);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('old\n');
    expect((await service.merge(candidate)).ok).toBe(true);
    expect(service.get(task.taskId).tests).toHaveLength(1);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('new\n');
    expect((await service.merge(candidate)).ok).toBe(true); // 确认幂等
  });

  it('真实 Git dirty 基线显式选择，worktree 不改 staged/untracked/删除现场', async () => {
    fixture({ 'a.ts': 'old\n', 'gone.ts': 'gone\n' });
    await git.init(root);
    await git.writeConfig(root, 'user.name', 'D07');
    await git.writeConfig(root, 'user.email', 'd07@example.invalid');
    await git.add(root, ['.']);
    await git.commit(root, {
      subject: 'baseline',
      author: { name: 'D07', email: 'd07@example.invalid' },
    });
    fixture({ 'a.ts': 'user\n', 'untracked.ts': 'untracked\n' });
    rmSync(join(root, 'gone.ts'));
    await git.add(root, ['a.ts']);
    const staged = await git.diff(root, { staged: true });
    const status = await git.status(root);
    await expect(
      service.create({ projectId: 'p', objective: 'change', writeSet: ['a.ts'] }),
    ).rejects.toThrow('显式选择');
    const candidate = await plan('a.ts', 'user', 'task');
    const task = service.get(candidate.taskId!);
    expect(task.worktreeRoot).not.toBeNull();
    expect(await git.isRepo(task.copyRoot)).toBe(true);
    expect(readFileSync(join(task.copyRoot, 'a.ts'), 'utf8')).toBe('user\n');
    expect(readFileSync(join(task.copyRoot, 'untracked.ts'), 'utf8')).toBe('untracked\n');
    expect(existsSync(join(task.copyRoot, 'gone.ts'))).toBe(false);
    expect(await git.diff(root, { staged: true })).toBe(staged);
    expect(await git.status(root)).toEqual(status);
    expect((await service.merge(candidate)).ok).toBe(true);
    expect(await git.diff(root, { staged: true })).toBe(staged);
    expect(await git.headSha(root)).toBe(task.baseRevision.head);
  }, 30000);

  it('HEAD 不包含未提交变更，dirty 目标合入暂停，用户修改仍在', async () => {
    fixture({ 'a.ts': 'old\n' });
    await git.init(root);
    await git.writeConfig(root, 'user.name', 'D07');
    await git.writeConfig(root, 'user.email', 'd07@example.invalid');
    await git.add(root, ['.']);
    await git.commit(root, {
      subject: 'baseline',
      author: { name: 'D07', email: 'd07@example.invalid' },
    });
    fixture({ 'a.ts': 'user\n' });
    const task = await service.create({
      projectId: 'p',
      objective: 'head',
      baseline: 'head',
      writeSet: ['a.ts'],
      readSet: [],
    });
    expect(readFileSync(join(task.copyRoot, 'a.ts'), 'utf8')).toBe('old\n');
    const candidate = await service.plan(task.taskId, output('a.ts', 'old', 'new'));
    expect((await service.merge(candidate)).ok).toBe(false);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('user\n');
  }, 30000);

  it('同文件任务先合入者保留，后一任务暂停并保存两侧内容', async () => {
    fixture({ 'a.ts': 'old\n' });
    const first = await plan('a.ts', 'old', 'first');
    const second = await plan('a.ts', 'old', 'second');
    const results = await Promise.all([service.merge(first), service.merge(second)]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('first\n');
    expect(service.get(second.taskId!).conflicts[0]).toMatchObject({
      path: 'a.ts',
      ours: 'second\n',
      theirs: 'first\n',
    });
  });

  it('不同文件可串行合入；接口依赖变化要求重新验证调用方', async () => {
    fixture({ 'api.ts': 'v1\n', 'caller.ts': 'call-v1\n', 'other.ts': 'old\n' });
    const first = await plan('api.ts', 'v1', 'v2');
    const task = await service.create({
      projectId: 'p',
      objective: 'caller',
      writeSet: ['caller.ts'],
      readSet: [],
      contractPaths: ['api.ts'],
    });
    const caller = await service.plan(task.taskId, output('caller.ts', 'call-v1', 'call-new'));
    const other = await plan('other.ts', 'old', 'independent');
    expect((await service.merge(first)).ok).toBe(true);
    expect((await service.merge(other)).ok).toBe(true);
    expect((await service.merge(caller)).error).toContain('接口契约版本');
    expect(readFileSync(join(root, 'caller.ts'), 'utf8')).toBe('call-v1\n');
  });

  it('独立外部进程修改原目录，合入拒绝覆盖', async () => {
    fixture({ 'a.ts': 'old\n' });
    const candidate = await plan('a.ts', 'old', 'new');
    expect(
      await child("require('node:fs').writeFileSync(process.argv[1], 'external\\n')", [
        join(root, 'a.ts'),
      ]),
    ).toBe(0);
    expect((await service.merge(candidate)).ok).toBe(false);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('external\n');
  });

  it('事务准备后外部进程改文件时标记冲突并保留外部内容', async () => {
    fixture({ 'a.ts': 'old\n' });
    let taskId = '';
    let injectExternalWrite = false;
    service = new TaskWriteService({
      ...options(),
      owner: {
        assertOwner: () => undefined,
        fencingToken: () => 1,
        write: (action) => {
          const result = action();
          const recordPath = join(directory, 'tasks', taskId, 'task.json');
          if (
            injectExternalWrite &&
            taskId.length > 0 &&
            existsSync(recordPath) &&
            (JSON.parse(readFileSync(recordPath, 'utf8')) as { state: string }).state === 'applying'
          ) {
            execFileSync(process.execPath, [
              '-e',
              "require('node:fs').writeFileSync(process.argv[1], 'external-race\\n')",
              join(root, 'a.ts'),
            ]);
            injectExternalWrite = false;
          }
          return result;
        },
      },
    });
    const candidate = await plan('a.ts', 'old', 'new');
    taskId = candidate.taskId!;
    injectExternalWrite = true;

    const result = await service.merge(candidate);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toContain('a.ts');
    expect(service.get(taskId)).toMatchObject({
      state: 'conflicted',
      conflicts: [
        {
          path: 'a.ts',
          base: 'old\n',
          ours: 'new\n',
          theirs: 'external-race\n',
        },
      ],
    });
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('external-race\n');
  });

  it('被阻止的计划不能进入 queued，确认拒绝后原文件保持不变', async () => {
    fixture({ 'a.ts': 'old\n' });
    const task = await service.create({
      projectId: 'p',
      objective: 'blocked create',
      writeSet: ['a.ts'],
      readSet: [],
    });
    const candidate = await service.plan(task.taskId, {
      files: [{ path: 'a.ts', language: 'typescript', action: 'create', content: 'overwrite\n' }],
      anchors: [],
      summary: 'blocked create',
      notes: '',
      decision: { referencedMemory: [], rationale: 'test', risks: [], uncovered: [] },
    });
    expect(candidate.entries[0]?.blocked).toBe(true);

    await expect(service.merge(candidate)).rejects.toThrow('被拒绝的变更');
    expect(service.get(task.taskId).state).toBe('awaiting_confirmation');
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('old\n');
  });

  it('验证失败整体补偿，但外部进程的新成果不可回滚覆盖', async () => {
    fixture({ 'a.ts': 'old\n' });
    service = new TaskWriteService({
      ...options(),
      validate: async () => {
        await child("require('node:fs').writeFileSync(process.argv[1], 'external-after\\n')", [
          join(root, 'a.ts'),
        ]);
        return [{ name: 'test', ok: false, detail: '受影响测试失败' }];
      },
    });
    const candidate = await plan('a.ts', 'old', 'new');
    const result = await service.merge(candidate);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual(['a.ts']);
    expect(service.get(candidate.taskId!).conflicts).toMatchObject([
      {
        path: 'a.ts',
        base: 'old\n',
        ours: 'new\n',
        theirs: 'external-after\n',
      },
    ]);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('external-after\n');
  });

  it('依赖锁/DDL/共享数据库排他，取消释放自己的资源，不删除副本', async () => {
    fixture({ 'pnpm-lock.yaml': 'old\n' });
    const first = await service.create({
      projectId: 'p',
      objective: 'lock',
      writeSet: ['pnpm-lock.yaml'],
    });
    await expect(
      service.create({ projectId: 'p', objective: 'package', writeSet: ['package.json'] }),
    ).rejects.toThrow('排他资源');
    await service.cancel(first.taskId);
    expect(existsSync(first.copyRoot)).toBe(true);
    await service.create({ projectId: 'p', objective: 'package', writeSet: ['package.json'] });
    await service.create({ projectId: 'p', objective: 'db', writeSet: ['migrations/0001.sql'] });
    await expect(
      service.create({ projectId: 'p', objective: 'ddl', writeSet: ['schema.sql'] }),
    ).rejects.toThrow('排他资源');
    await service.create({
      projectId: 'p',
      objective: 'shared-db',
      writeSet: ['a.ts'],
      sharedResources: ['local-db'],
    });
    await expect(
      service.create({
        projectId: 'p',
        objective: 'shared-db',
        writeSet: ['b.ts'],
        sharedResources: ['local-db'],
      }),
    ).rejects.toThrow('排他资源');
  });

  it('篡改计划/越界/链接被拒，清理须确认且不能清理活动任务', async () => {
    fixture({ 'a.ts': 'old\n' });
    const candidate = await plan('a.ts', 'old', 'new');
    await expect(
      service.merge({
        ...candidate,
        entries: candidate.entries.map((entry) => ({ ...entry, after: 'injected' })),
      }),
    ).rejects.toThrow('篡改');
    await expect(service.cleanup(candidate.taskId!, true)).rejects.toThrow('活动');
    await service.cancel(candidate.taskId!);
    await expect(service.cleanup(candidate.taskId!, false)).rejects.toThrow('确认');
    await service.cleanup(candidate.taskId!, true);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('old\n');
    expect(service.get(candidate.taskId!).state).toBe('cleaned');
    await expect(
      service.create({ projectId: 'p', objective: 'escape', writeSet: ['../outside.ts'] }),
    ).rejects.toThrow();
  });

  it('单文件 CAS 拒绝旧前值，不覆盖后来内容', async () => {
    fixture({ 'a.ts': 'later\n' });
    expect(await taskFileSystem(root).compareAndSwap?.('a.ts', 'old\n', 'new\n')).toBe(false);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('later\n');
  });
});
