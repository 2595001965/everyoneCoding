/**
 * E2E-07：Git 全可视化 —— 初始化 → 修改 → 提交 → 建分支 → 推送，全程无命令行操作。
 *
 * 装配：真实 `GitClient`（真实 git 子进程）+ 真实临时仓库 + 本地裸仓库作远端，
 * 业务侧只调用进程内 API（UI 按钮的底层），**不使用任何终端**。
 *
 * ⚠️ 环境敏感：本机 git 子进程启动极慢（2026-09-12 实测 `git --version` ≈18s/次），
 * 因此本用例显式放宽超时（见下方 `180_000`）。这不是代码问题。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { GitClient, createDefaultBackendDeps, createNodeGitRunner } from '@ec/git';

const tempRoots: string[] = [];

afterAll(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeRepo(): Promise<{
  repo: string;
  runner: ReturnType<typeof createNodeGitRunner>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'ec-e2e07-'));
  tempRoots.push(root);
  const repo = join(root, 'workspace');
  await mkdir(repo, { recursive: true });
  return { repo, runner: createNodeGitRunner() };
}

describe('E2E-07 Git 全流程（无命令行）', () => {
  it('初始化 → 修改 → 提交 → 建分支 → 推送（本地裸仓库）全部经进程内 API 完成', async () => {
    const { repo, runner } = await makeRepo();

    // 远端：本地裸仓库（真实 git 对象库，推送真的发生）
    const bare = join(repo, '..', 'remote.git');
    await mkdir(bare, { recursive: true });
    const initBare = await runner.run(['git', 'init', '--bare', '--initial-branch=main', bare], {
      cwd: repo,
    });
    expect(initBare.exitCode).toBe(0);

    // 记录所有 argv：断言"业务侧只经封装调用"、且无终端交互所需的高危参数
    const argv: string[][] = [];
    const inner = createDefaultBackendDeps();
    const deps = {
      ...inner,
      runner: {
        async run(
          args: readonly string[],
          options: { cwd: string; env?: Record<string, string>; input?: string },
        ) {
          argv.push([...args]);
          return inner.runner.run(args, options);
        },
      },
    };

    const client = await GitClient.create({ repoPath: repo, deps, preferred: 'cli' });

    // ① 初始化仓库（UI「初始化仓库」按钮；含 .gitignore 模板）
    const init = await client.init({ stacks: ['node'] });
    expect(init.ok, `初始化失败：${JSON.stringify(init.error)}`).toBe(true);
    expect(init.data?.gitignoreWritten).toBe(true);

    // 提交身份必须在仓库存在之后写入（写进 .git/config）——顺序反了会导致提交被拒
    const identity = await client.setIdentity('小吴', 'wu@ec.local');
    expect(identity.ok, `写入提交身份失败：${JSON.stringify(identity.error)}`).toBe(true);

    // ② 修改文件 → 状态可见（UI「变更」视图）
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'app.ts'), 'export const version = 1;\n', 'utf8');
    const status = await client.status();
    expect(status.ok).toBe(true);
    expect(status.data?.clean).toBe(false);
    expect(status.data?.changes.map((change) => change.path)).toContain('src/app.ts');

    // ③ 暂存 + 提交（UI「提交」面板）
    await client.stage(['src/app.ts', '.gitignore']);
    const commit = await client.commit({ subject: 'feat: 初始化工程骨架' });
    expect(commit.ok, `提交失败：${JSON.stringify(commit.error)}`).toBe(true);
    expect(commit.data ?? '').toMatch(/^[0-9a-f]{40}$/);

    // ④ 建分支（UI「分支管理」）
    const created = await client.createBranch('feat/login', 'main');
    expect(created.ok, `建分支失败：${JSON.stringify(created.error)}`).toBe(true);
    const list = await client.branches();
    expect(list.data?.map((branch) => branch.name)).toEqual(
      expect.arrayContaining(['main', 'feat/login']),
    );

    // ⑤ 配置远程 + 推送（UI「远程」面板；本地裸仓库，真实推送）
    const added = await client.addRemote('origin', bare);
    expect(added.ok, `添加远程失败：${JSON.stringify(added.error)}`).toBe(true);
    const pushed = await client.push({ remote: 'origin', branch: 'main', setUpstream: true });
    expect(pushed.ok, `推送失败：${JSON.stringify(pushed.error)}`).toBe(true);

    // 推送真的落到了远端裸仓库
    const verify = await runner.run(['git', 'log', '--oneline', 'main'], { cwd: bare });
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toContain('初始化工程骨架');

    // 无终端判据：全程没有交互式提示（凭据不进 argv、不写死密码）
    const joined = argv.flat().join(' ');
    expect(joined).not.toMatch(/password|--askpass/i);
    expect(joined).not.toMatch(/Authorization:/);
  }, 600_000);
});
