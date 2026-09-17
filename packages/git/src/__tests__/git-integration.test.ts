import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { BackendPreference } from '../backend';
import { createNodeGitRunner } from '../backend';
import { createDefaultBackendDeps } from '../backend';
import { ConflictService } from '../conflict-service';
import { GitClient } from '../git-client';
import { MergeService } from '../merge-service';
import { RecoveryService } from '../recovery-service';
import { RemoteService } from '../remote-service';
import { HistoryService } from '../history-service';
import { BranchService } from '../branch-service';
import { resolveConflictFile } from '../conflict-service';

/**
 * Git 集成测试（T6-01 验收）：**同一套用例对两个后端各跑一遍**。
 *
 * 真实临时仓库、真实 git 进程。本机没有 libgit2 绑定，
 * 因此 `preferred: 'git2'` 这一趟实际会走"探测失败 → 自动回退 CLI"的路径——
 * 这正是验收标准要求的「git2 不可用时自动回退 CLI 且行为一致」。
 * 两趟产生的行为摘要会在最后一个用例里逐字段比对，证明对上层完全透明。
 */

const TOKEN = 'ghp_INTEGRATION_SECRET_9f8e7d6c5b4a';
const summaries = new Map<BackendPreference, Record<string, unknown>>();
const tempRoots: string[] = [];

/**
 * 本用例的真实子进程超时（毫秒）。
 *
 * 默认 180s：正常机器上单趟（init → … → 冲突解决，含上百次真实 git 调用）只需数秒到数十秒，
 * 180s 足以暴露"真的卡住"。
 *
 * 本机（Windows + 实时杀毒扫描，实测 `git --version` ≈18s/次）单趟需要 **15 分钟以上**
 * （2026-09-14 实测：放到 900s 仍两趟都超时），双后端跑完需 40+ 分钟。
 * 此时有两条路：
 * - 把仓库目录与 `git.exe` / `node.exe` 加入杀毒实时扫描白名单（治本，速度可回到秒级）；
 * - 或用 `EC_GIT_IT_TIMEOUT_MS=3600000` 单独放行这一支（治标）。
 *
 * 覆盖率门禁（`ci/quality-gate.mts`）测的是确定性的单元覆盖率，因此它会在这种机器上如实报
 * "未取到覆盖率数据"，而不是给一个假的百分比；详见 `docs/TEST-REPORT.md §1.2`。
 */
const GIT_INTEGRATION_TIMEOUT_MS = Number(process.env['EC_GIT_IT_TIMEOUT_MS'] ?? 180_000);

afterAll(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** 递归扫描目录下所有文件的文本内容（凭据泄漏检查用） */
async function scanAllFiles(root: string): Promise<string[]> {
  const texts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // .git/objects 是压缩对象库，不会承载明文凭据，跳过以控制耗时
        if (entry.name === 'objects') continue;
        await walk(full);
        continue;
      }
      const info = await stat(full).catch(() => null);
      // 只读文本类文件，二进制与超大文件跳过
      if (info === null || info.size > 512 * 1024) continue;
      const buffer = await readFile(full).catch(() => null);
      if (buffer === null) continue;
      texts.push(buffer.toString('utf8'));
    }
  };
  await walk(root);
  return texts;
}

async function runFullSuite(preferred: BackendPreference): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), `ec-git-${preferred}-`));
  tempRoots.push(root);
  const repo = join(root, 'workspace');
  await mkdir(repo, { recursive: true });

  // 记录所有 argv 与 env，用于断言"凭据不进 argv"
  const inner = createNodeGitRunner();
  const argv: string[][] = [];
  const envs: Record<string, string>[] = [];
  const deps = {
    ...createDefaultBackendDeps(),
    runner: {
      async run(args: readonly string[], options: { cwd: string; env?: Record<string, string>; input?: string }) {
        argv.push([...args]);
        if (options.env !== undefined) envs.push(options.env);
        return inner.run(args, options);
      },
    },
  };

  const client = await GitClient.create({ repoPath: repo, deps, preferred });
  expect(client.selectionNotes.length).toBeGreaterThan(0);

  /* 1. 初始化 + .gitignore -------------------------------------------------- */
  const init = await client.init({ stacks: ['node', 'python'] });
  expect(init.ok).toBe(true);
  expect(init.data?.gitignoreWritten).toBe(true);
  expect(init.data?.gitignoreContent).toContain('node_modules/');
  expect(init.data?.gitignoreContent).toContain('__pycache__/');
  expect(await client.isRepo()).toMatchObject({ ok: true, data: true });
  await client.setIdentity('小吴', 'wu@ec.local');

  /* 2. 状态 → 暂存 → 提交 → 历史 -------------------------------------------- */
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'main.ts'), 'export const version = 1;\n', 'utf8');
  await writeFile(join(repo, '中文文件名.txt'), '第一行\n第二行\n', 'utf8');

  const beforeStage = await client.status();
  expect(beforeStage.data?.clean).toBe(false);
  expect(beforeStage.data?.changes.map((change) => change.path).sort()).toEqual(
    ['src/main.ts', '中文文件名.txt', '.gitignore'].sort(),
  );
  expect(beforeStage.data?.changes.every((change) => change.status === 'untracked')).toBe(true);

  const staged = await client.stage(['src/main.ts', '.gitignore']);
  expect(staged.ok).toBe(true);
  expect(staged.data).toBe(2);

  const firstCommit = await client.commit({ subject: 'feat: 初始化工程骨架', body: '来自 EveryoneCoding 生成节点 node-1' });
  expect(firstCommit.ok).toBe(true);
  const firstSha = firstCommit.data ?? '';
  expect(firstSha).toMatch(/^[0-9a-f]{40}$/);

  const history = await client.log({ limit: 10 });
  expect(history.data).toHaveLength(1);
  expect(history.data?.[0]?.subject).toBe('feat: 初始化工程骨架');
  expect(history.data?.[0]?.authorName).toBe('小吴');

  await client.stage(['中文文件名.txt']);
  await client.commit({ subject: 'feat: 新增中文名文件' });

  /* 3. 重命名识别（中文路径 + 含空格路径） ---------------------------------- */
  const renameRun = await inner.run(['git', 'mv', '中文文件名.txt', '改 名后.txt'], { cwd: repo });
  expect(renameRun.exitCode).toBe(0);
  await client.commit({ subject: 'refactor: 重命名中文文件' });
  const renamedStatus = await client.status();
  expect(renamedStatus.data?.clean).toBe(true);

  /* 4. diff：普通文件 + >1MB 跳过 ------------------------------------------- */
  await writeFile(join(repo, 'src', 'main.ts'), 'export const version = 2;\nexport const extra = true;\n', 'utf8');
  const diff = await client.diff();
  expect(diff.ok).toBe(true);
  expect(diff.data?.files.map((file) => file.path)).toEqual(['src/main.ts']);
  expect(diff.data?.files[0]?.hunks.length).toBeGreaterThanOrEqual(1);
  expect(diff.data?.additions).toBeGreaterThanOrEqual(1);

  const bigPath = join(repo, 'big.txt');
  await writeFile(bigPath, 'x'.repeat(1024 * 1024 + 4096), 'utf8');
  await client.stage(['big.txt']);
  await client.commit({ subject: 'chore: 加入大文件基线' });
  await writeFile(bigPath, `${'x'.repeat(1024 * 1024 + 4096)}\n新的一行\n`, 'utf8');
  const bigDiff = await client.diff({ path: 'big.txt' });
  expect(bigDiff.data?.files[0]?.skipped).toBe(true);
  expect(bigDiff.data?.files[0]?.skipReason).toContain('已跳过内容差异');
  expect(bigDiff.data?.skippedFiles).toBe(1);

  /* 5. 分支 / 提交图 / 合并（自动备份分支） --------------------------------- */
  const branches = new BranchService(client);
  await branches.create('feat/test', 'main');
  await client.switchBranch('feat/test');
  await writeFile(join(repo, 'src', 'feat.ts'), 'export const feat = 1;\n', 'utf8');
  await client.stage(['src/feat.ts']);
  await client.commit({ subject: 'feat: 新增功能文件' });
  await client.switchBranch('main');

  const graph = await branches.graph({ limit: 50 });
  expect(graph.ok).toBe(true);
  expect(graph.data?.nodes.length).toBeGreaterThanOrEqual(4);
  expect(graph.data?.merges.length).toBe(0);

  const merges = new MergeService(client);
  const merged = await merges.execute('feat/test');
  expect(merged.ok).toBe(true);
  expect(merged.data?.status).toBe('fast-forward');
  expect(merged.data?.backupBranch).toMatch(/^backup\/\d{8}-\d{6}$/);
  const backups = await merges.listBackups();
  expect(backups.data?.map((branch) => branch.name)).toContain(merged.data?.backupBranch);

  /* 6. Stash 三类操作 ------------------------------------------------------- */
  await writeFile(join(repo, 'src', 'feat.ts'), 'export const feat = 2;\n', 'utf8');
  await client.stashPush('半成品：功能文件改到一半');
  const stashList = await client.stashList();
  expect(stashList.data).toHaveLength(1);
  expect(stashList.data?.[0]?.message).toContain('半成品');
  expect(stashList.data?.[0]?.files).toBeGreaterThanOrEqual(1);
  expect(await client.stashApply(0)).toMatchObject({ ok: true });
  expect(await client.stashDrop(0)).toMatchObject({ ok: true });
  expect((await client.stashList()).data).toHaveLength(0);

  /* 7. 回滚：先拒未确认，再软回退，并留下安全快照 -------------------------- */
  await client.reset('HEAD', 'hard');
  const beforeExtra = (await client.headSha()).data ?? '';
  await writeFile(join(repo, 'src', 'temp1.ts'), 'export const t1 = 1;\n', 'utf8');
  await client.stage(['src/temp1.ts']);
  await client.commit({ subject: 'feat: 生成节点 A' });
  await writeFile(join(repo, 'src', 'temp2.ts'), 'export const t2 = 1;\n', 'utf8');
  await client.stage(['src/temp2.ts']);
  await client.commit({ subject: 'feat: 生成节点 B' });

  const recovery = new RecoveryService(client, { clock: () => new Date(2026, 8, 12, 7, 30, 0).getTime() });
  const plan = await recovery.plan({ sha: beforeExtra, mode: 'soft', nodeLabel: '生成节点 B' });
  expect(plan.data?.affectedCommits).toHaveLength(2);
  expect(plan.data?.affectedFiles).toContain('src/temp1.ts');
  expect(plan.data?.snapshotBranch).toBe('backup/20260912-073000');
  expect(plan.data?.warnings.join()).toContain('软回退会保留工作区改动');

  const refused = await recovery.execute(plan.data!, { confirmed: false });
  expect(refused.ok).toBe(false);
  expect(refused.error?.code).toBe('INVALID_ARGUMENT');

  const executed = await recovery.execute(plan.data!, { confirmed: true });
  expect(executed.ok).toBe(true);
  expect(executed.data?.newHead).toBe(beforeExtra);
  expect(executed.data?.snapshotBranch).toBe('backup/20260912-073000');
  const snapshots = await recovery.listSnapshots();
  expect(snapshots.data?.map((branch) => branch.name)).toContain('backup/20260912-073000');
  await client.reset(beforeExtra, 'hard');

  /* 8. 远程 + 推送（凭据不落盘、不进 argv） --------------------------------- */
  const bare = join(root, 'remote.git');
  const bareInit = await inner.run(['git', 'init', '--bare', '-q', bare], { cwd: root });
  expect(bareInit.exitCode).toBe(0);

  const remoteService = new RemoteService(client);
  await remoteService.add('origin', bare);
  const connectivity = await remoteService.test('origin');
  expect(connectivity.ok).toBe(true);
  expect(connectivity.data?.ok).toBe(true);

  const progress: string[] = [];
  const push = await remoteService.push(
    { remote: 'origin', branch: 'main' },
    (event) => progress.push(`${event.phase}:${event.message}`),
  );
  expect(push.ok).toBe(true);
  expect(progress[0]).toContain('connecting');
  expect(progress.at(-1)).toContain('done');

  /* 9. 冲突：构造两侧改同一行 → 三栏解析 → 逐块选择 → 合并提交 -------------- */
  await client.switchBranch('main');
  await writeFile(join(repo, '冲突.txt'), '第一行\n基线内容\n第三行\n', 'utf8');
  await client.stage(['冲突.txt']);
  await client.commit({ subject: 'feat: 加入冲突基线文件' });

  await branches.create('feat/conflict', 'main');
  await client.switchBranch('feat/conflict');
  await writeFile(join(repo, '冲突.txt'), '第一行\n传入侧内容\n第三行\n', 'utf8');
  await client.stage(['冲突.txt']);
  await client.commit({ subject: 'feat: 传入侧修改' });

  await client.switchBranch('main');
  await writeFile(join(repo, '冲突.txt'), '第一行\n当前侧内容\n第三行\n', 'utf8');
  await client.stage(['冲突.txt']);
  await client.commit({ subject: 'feat: 当前侧修改' });

  const conflicted = await merges.execute('feat/conflict', { backup: false });
  expect(conflicted.ok).toBe(true);
  expect(conflicted.data?.status).toBe('conflicted');
  expect(conflicted.data?.conflictFiles).toContain('冲突.txt');

  const conflictService = new ConflictService(client, {
    readFile: (path) => readFile(join(repo, path), 'utf8').then((text) => text).catch(() => null),
  });
  const scanned = await conflictService.scan();
  expect(scanned.data).toHaveLength(1);
  expect(scanned.data?.[0]?.blocks.length).toBeGreaterThanOrEqual(1);
  const oursBlock = scanned.data?.[0]?.blocks[0];
  expect(oursBlock?.ours.join()).toContain('当前侧内容');
  expect(oursBlock?.theirs.join()).toContain('传入侧内容');

  const resolved = resolveConflictFile(scanned.data![0]!, { 1: 'theirs' });
  expect(resolved.unresolved).toBe(0);
  expect(resolved.content).toContain('传入侧内容');
  expect(resolved.content).not.toContain('<<<<<<<');

  // 解决后生成合并提交（模拟 AI 写入管线落盘后提交）
  await writeFile(join(repo, '冲突.txt'), resolved.content, 'utf8');
  await client.stage(['冲突.txt']);
  const mergeCommit = await client.commit({ subject: 'fix: 解决合并冲突并生成合并提交' });
  expect(mergeCommit.ok).toBe(true);
  const finalLog = await client.log({ limit: 1 });
  expect(finalLog.data?.[0]?.parents.length).toBe(2);

  /* 10. 历史服务 ------------------------------------------------------------ */
  const historyService = new HistoryService(client);
  const page = await historyService.query({ keyword: '冲突' }, { pageSize: 5 });
  expect(page.data?.commits.length).toBeGreaterThanOrEqual(1);
  expect(page.data?.filtered).toBe(true);
  const detail = await historyService.detail(firstSha);
  expect(detail.data?.commit.sha).toBe(firstSha);
  expect(detail.data?.files.length).toBeGreaterThanOrEqual(1);

  /* 11. 凭据检查：临时目录与日志中都没有明文令牌 --------------------------- */
  const argvJoined = argv.flat().join(' ');
  expect(argvJoined).not.toContain(TOKEN);
  const envJoined = envs.map((env) => Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')).join('\n');
  expect(envJoined).not.toContain(TOKEN);

  const drainable = client as unknown as { drainLogs: () => { level: string; message: string; raw?: string }[] };
  const logText = drainable
    .drainLogs()
    .map((entry) => `${entry.level} ${entry.message} ${entry.raw ?? ''}`)
    .join('\n');
  expect(logText).not.toContain(TOKEN);
  expect(logText).toContain('推送');

  const files = await scanAllFiles(root);
  const leaked = files.filter((text) => text.includes(TOKEN));
  expect(leaked).toHaveLength(0);

  return {
    backendId: client.backendId,
    requestedBackend: client.requestedBackend,
    usedFallbackNote: client.selectionNotes.some((note) => note.includes('回退')),
    changeCount: (await client.status()).data?.changes.length ?? -1,
    commitCount: (await client.log({ limit: 100 })).data?.length ?? -1,
    branchNames:
      (await client.branches()).data?.map((branch) => branch.name.replace(/^backup\/\d{8}-\d{6}$/, 'backup/<时间戳>')).sort() ?? [],
    finalTree: (await readdir(repo)).sort(),
    logMessageCount: (await client.log({ limit: 3 })).data?.length ?? -1,
  };
}

describe('Git 集成（真实临时仓库 · 双后端同一套用例）', () => {
  it('系统 Git CLI：init → status → add → commit → branch → merge → stash → 回滚 → 推送 → 冲突解决', async () => {
    const summary = await runFullSuite('cli');
    expect(summary.backendId).toBe('cli');
    expect(summary.commitCount).toBeGreaterThanOrEqual(8);
    summaries.set('cli', summary);
  }, GIT_INTEGRATION_TIMEOUT_MS);

  it('libgit2 优先：绑定不可用时自动回退 CLI，全流程同样跑通', async () => {
    const summary = await runFullSuite('git2');
    expect(summary.requestedBackend).toBe('git2');
    // 本机没有 libgit2 绑定 → 实际生效的是 CLI，且必须留下回退说明
    expect(summary.backendId).toBe('cli');
    expect(summary.usedFallbackNote).toBe(true);
    expect(summary.commitCount).toBeGreaterThanOrEqual(8);
    summaries.set('git2', summary);
  }, GIT_INTEGRATION_TIMEOUT_MS);

  it('两套后端行为一致（对上层透明）', () => {
    const cli = summaries.get('cli');
    const git2 = summaries.get('git2');
    expect(cli).toBeDefined();
    expect(git2).toBeDefined();
    expect(git2?.commitCount).toBe(cli?.commitCount);
    expect(git2?.branchNames).toEqual(cli?.branchNames);
    expect(git2?.changeCount).toBe(cli?.changeCount);
    expect(git2?.finalTree).toEqual(cli?.finalTree);
  });
});
