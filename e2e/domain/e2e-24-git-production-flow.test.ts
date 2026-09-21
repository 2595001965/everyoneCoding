/**
 * E2E-24：Git 生产端口全流程（T12-04 验收第 1 条）。
 *
 * 初始化 → 修改 → diff → 提交 → 分支 → 冲突 → 冲突解决落盘 → 回滚 → stash，
 * **全部经 Electron git 域的生产路由**（`createGitDomain`，与真实产品同一装配），
 * 不使用任何终端命令。真实 git 子进程 + 真实临时仓库。
 *
 * 与 E2E-07 的分工：E2E-07 驱动 `@ec/git` 的 GitClient（领域内核），
 * 本用例驱动**生产端口**——路径安全、域路由、冲突解决经写入管线落盘、
 * 删除分支 / 强推前的安全快照，这些只有在装配层才看得到。
 *
 * ⚠️ 环境敏感：本机 git 子进程启动慢（见 docs/TEST-REPORT.md §5），
 * 超时已放宽；这不是代码问题。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DomainRouter, DomainRouterContext } from '@ec/shell-api';

import { openBusinessDb } from '../../apps/desktop-electron/src/main/domain/db';
import { createGitDomain } from '../../apps/desktop-electron/src/main/domain/domains/git-domain';
import {
  createCodeDomain,
  type CodeWritePort,
} from '../../apps/desktop-electron/src/main/domain/domains/code-domain';

let root: string;
let projectsDir: string;
let db: Database.Database;
let git: DomainRouter;
const PROJECT_ID = 'p-e2e24-git';

const ctx: DomainRouterContext = { requestId: 'e2e24', emit: () => undefined };

async function gitCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return (await git(method, { projectId: PROJECT_ID, ...params }, ctx)) as T;
}

/** 调用并断言 GitResult 成功（域内以 GitResult 表达失败，不走异常） */
async function gitOk<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ data: T; logs: Array<{ level: string; message: string }> }> {
  const result = (await git(method, { projectId: PROJECT_ID, ...params }, ctx)) as {
    ok: boolean;
    data: T | null;
    logs?: Array<{ level: string; message: string }>;
    error?: { code: string; message: string } | null;
  };
  expect(
    result.ok,
    `git.${method} 失败：${JSON.stringify(result.error ?? result)}`,
  ).toBe(true);
  return { data: result.data as T, logs: result.logs ?? [] };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-e2e24-'));
  projectsDir = join(root, 'projects');
  mkdirSync(join(projectsDir, PROJECT_ID, 'code'), { recursive: true });
  db = openBusinessDb({ dataDir: join(root, 'data') });

  // 冲突解决结果必须经写入管线落盘（D-04）：与生产装配一致，注入 code 域的写端口
  const code = createCodeDomain({
    db,
    projectsDir,
    emit: () => undefined,
    aiStack: null,
    userId: 'local-user',
  });
  const writeCode: CodeWritePort = code.writePort;
  git = createGitDomain({
    projectsDir,
    db,
    userId: 'local-user',
    credentials: null,
    aiStack: null,
    writeCode,
  });
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const BASE_APP = [
  'export function login(username: string): string {',
  '  return `hello ${username}`;',
  '}',
  '',
].join('\n');

describe('E2E-24 Git 生产端口全流程（无命令行）', () => {
  it('初始化 → 修改 → diff → 提交 → 分支 → 冲突 → 解决 → 回滚 → stash', async () => {
    /* ① 初始化（含 .gitignore 与提交身份兜底） */
    const opened = await gitCall<{ projectId: string; exists: boolean }>('openProject');
    expect(opened.exists).toBe(true);
    const init = await gitOk<{ gitignoreWritten: boolean }>('init', { stacks: ['node'] });
    expect(init.data.gitignoreWritten).toBe(true);
    const initLogs = init.logs.map((log) => log.message).join('\n');
    expect(initLogs).toContain('默认身份');

    const info = await gitCall<{ branch: string | null; clean: boolean }>('info');
    // 首次提交前 HEAD 指向未出生分支（status 可能拿不到分支名）；
    // init 生成的 .gitignore 是未跟踪文件，此时 clean 本来就是 false
    expect(typeof info.clean).toBe('boolean');

    /* ② 修改 → status / diff */
    mkdirSync(join(projectsDir, PROJECT_ID, 'code', 'src'), { recursive: true });
    writeFileSync(join(projectsDir, PROJECT_ID, 'code', 'src', 'login.ts'), BASE_APP, 'utf8');
    const status = await gitOk<{ clean: boolean; changes: Array<{ path: string }> }>('status');
    expect(status.data.clean).toBe(false);
    expect(status.data.changes.map((change) => change.path)).toContain('src/login.ts');

    /* ③ 暂存 + diff（staged）+ 提交
     * 注意：未跟踪文件不会出现在 `git diff` 里，所以先 stage 再看 diff——
     * 这与产品口径一致（变更清单来自 status，diff 面板看的是暂存/工作区差异）。 */
    const staged = await gitOk<number>('stage', {
      paths: ['.gitignore', 'src/login.ts'],
    });
    expect(staged.data).toBe(2);
    const diff = await gitOk<{ files: Array<{ path: string; additions: number }> }>('diff', {
      options: { scope: 'staged' },
    });
    expect(diff.data.files.map((file) => file.path)).toContain('src/login.ts');
    expect(diff.data.files[0]?.additions).toBeGreaterThan(0);

    const commitSha = await gitOk<string>('commit', { input: { subject: 'feat: 登录逻辑' } });
    expect(commitSha.data).toMatch(/^[0-9a-f]{40}$/);
    const committed = await gitCall<{ branch: string | null }>('info');
    expect(committed.branch).toBe('main');

    /* ④ 建分支 + 两侧分叉制造冲突 */
    await gitOk<string>('createBranch', { name: 'feat/alias', startPoint: 'main' });
    await gitOk<string>('switchBranch', { name: 'feat/alias' });
    writeFileSync(
      join(projectsDir, PROJECT_ID, 'code', 'src', 'login.ts'),
      'export function login(username: string): string {\n  return `alias ${username}`;\n}\n',
      'utf8',
    );
    await gitOk<number>('stage', { paths: ['src/login.ts'] });
    await gitOk<string>('commit', { input: { subject: 'feat: 别名问候' } });
    await gitOk<string>('switchBranch', { name: 'main' });
    writeFileSync(
      join(projectsDir, PROJECT_ID, 'code', 'src', 'login.ts'),
      'export function login(username: string): string {\n  return `main ${username}`;\n}\n',
      'utf8',
    );
    await gitOk<number>('stage', { paths: ['src/login.ts'] });
    await gitOk<string>('commit', { input: { subject: 'feat: 主问候' } });

    const mergeResult = (await git('merge', { projectId: PROJECT_ID, source: 'feat/alias' }, ctx)) as {
      ok: boolean;
      data: { status: string; conflictFiles: string[] } | null;
      error?: { message: string } | null;
    };
    expect(
      mergeResult.ok && mergeResult.data?.status === 'conflicted',
      `合并应当进入冲突：${JSON.stringify(mergeResult.error ?? mergeResult.data?.status)}`,
    ).toBe(true);
    expect(mergeResult.data?.conflictFiles).toContain('src/login.ts');

    const conflicts = await gitOk<Array<{ path: string; blocks: unknown[] }>>('conflicts');
    const conflicted = conflicts.data.find((file) => file.path === 'src/login.ts');
    expect(conflicted).toBeTruthy();
    expect(conflicted?.blocks.length).toBeGreaterThan(0);

    /* ⑤ 冲突解决（选「当前」一侧）→ 写入管线落盘 + git add */
    const resolved = await gitOk<{ path: string; resolvedBlocks: number; strategy: string }>(
      'applyResolution',
      { input: { path: 'src/login.ts', choices: { [String(conflicted?.blocks[0]?.index ?? 1)]: 'ours' } } },
    );
    expect(resolved.data.resolvedBlocks).toBe(1);
    expect(resolved.data.strategy).toBe('choices');
    // 落盘内容是「当前」一侧，冲突标记已消失
    const resolvedBody = readFileSync(
      join(projectsDir, PROJECT_ID, 'code', 'src', 'login.ts'),
      'utf8',
    );
    expect(resolvedBody).toContain('`main ${username}`');
    expect(resolvedBody).not.toContain('<<<<<<<');

    const afterStatus = await gitOk<{ clean: boolean; changes: Array<{ path: string }> }>('status');
    expect(afterStatus.data.clean).toBe(true);

    /* ⑥ 回滚：计划（含快照分支）→ 二次确认执行。
     * 用 soft 模式回退到合并前的"主问候"提交：HEAD 后移、改动保留在暂存区。
     * （revert 模式在此场景会撞上合并提交——revert merge 需要 -m 主线参数，
     * 属后续增强；soft 正是"回退到生成前、保留工作区"的产品语义。） */
    const head = await gitOk<Array<{ sha: string; subject: string }>>('log', {
      options: { limit: 4 },
    });
    const mergeCommit = head.data.find((item) => item.subject.startsWith('merge:'));
    expect(mergeCommit).toBeTruthy();
    const target = head.data.find((item) => item.subject === 'feat: 主问候');
    expect(target).toBeTruthy();
    const plan = await gitOk<{
      mode: string;
      targetSha: string;
      snapshotBranch: string;
      affectedCommits: unknown[];
      warnings: string[];
    }>('rollbackPlan', { input: { sha: target?.sha, mode: 'soft' } });
    expect(plan.data.mode).toBe('soft');
    expect(plan.data.targetSha).toBe(target?.sha);
    expect(plan.data.snapshotBranch).toContain('backup/');
    expect(plan.data.warnings.join('\n')).toContain('软回退');

    // 未带 confirmed 的执行必须被拒（破坏性操作的保护不依赖 UI 自觉）
    const unconfirmed = await git('rollbackExecute', { projectId: PROJECT_ID, plan: plan.data }, ctx);
    expect((unconfirmed as { ok: boolean }).ok).toBe(false);

    const rolled = await gitOk<{
      mode: string;
      snapshotBranch: string;
      newHead: string | null;
      commitSha: string | null;
    }>('rollbackExecute', { plan: plan.data, confirmed: true });
    expect(rolled.data.mode).toBe('soft');
    expect(rolled.data.snapshotBranch).toContain('backup/');
    // 快照分支指向回滚前的 HEAD（合并提交），这就是"可反悔"的凭据
    expect(rolled.data.newHead).toBe(target?.sha ?? null);

    const snapshots = await gitOk<Array<{ name: string; sha: string | null }>>('snapshots');
    expect(snapshots.data.map((item) => item.name)).toContain(rolled.data.snapshotBranch);
    expect(snapshots.data.find((item) => item.name === rolled.data.snapshotBranch)?.sha).toBe(
      mergeCommit?.sha ?? null,
    );

    /* ⑦ stash：暂存 / 查看 / 恢复 / 删除 */
    const stashed = readFileSync(join(projectsDir, PROJECT_ID, 'code', 'src', 'login.ts'), 'utf8');
    writeFileSync(
      join(projectsDir, PROJECT_ID, 'code', 'src', 'login.ts'),
      `${stashed}// 草稿：暂存一下\n`,
      'utf8',
    );
    await gitOk<boolean>('stashPush', { message: '实验性改动' });
    const stashList = await gitOk<Array<{ message: string }>>('stashList');
    expect(stashList.data.length).toBe(1);

    const restored = await gitOk<number>('stashApply', { index: 0, drop: true });
    // stashApply 返回被恢复的 stash 下标（而非变更文件数），0 即 stash@{0}
    expect(restored.data).toBe(0);
    expect(readFileSync(join(projectsDir, PROJECT_ID, 'code', 'src', 'login.ts'), 'utf8')).toContain(
      '// 草稿：暂存一下',
    );
    const afterDrop = await gitOk<Array<{ message: string }>>('stashList');
    expect(afterDrop.data.length).toBe(0);

    /* ⑧ 删除分支前自动建安全快照（T12-04 要点 4）。
     * soft 回滚后该分支不再被合并包含，删除需要 force——这正是"危险操作 + 快照兜底"的组合路径。 */
    const deleted = await gitOk<unknown>('deleteBranch', { name: 'feat/alias', force: true });
    expect(deleted.data).toBeDefined();
    const deleteLogs = deleted.logs.map((log) => log.message).join('\n');
    expect(deleteLogs).toContain('安全快照分支');
  }, 600_000);
});
