import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isWorkspaceImportProgressEvent,
  type DomainControlServiceHost,
  type DomainEvent,
} from '@ec/shell-api';

import { openBusinessDb } from '../domain/db';
import { createDomainRuntime } from '../domain/runtime';
import { createWorkspaceDomain } from '../domain/workspace';
import { codeRootPointerPath } from '../domain/code-root';

/**
 * `importFromGit` 端到端测试（**真实 git CLI + 真实本地仓库**，不需要网络）。
 *
 * 用本地仓库当 remote 是本仓库既有做法（git 集成测试同思路）：
 * `git clone <本地路径>` 走完整克隆路径，但零网络依赖，测试可离线稳定跑。
 *
 * 覆盖：URL 校验、目标目录可用性、克隆成功后的落库与推断、代码根登记、
 * 以及克隆失败时的**补偿清理**（不留指向空目录的僵尸项目）。
 */

let root: string;
let dataDir: string;
let projectsDir: string;
let db: Database.Database;
let runtime: DomainControlServiceHost;

/** 造一个可被克隆的本地仓库（react-native 特征，便于断言推断结果） */
function makeOriginRepo(): string {
  const origin = join(root, 'origin-repo');
  mkdirSync(join(origin, 'src'), { recursive: true });
  writeFileSync(
    join(origin, 'package.json'),
    JSON.stringify(
      {
        name: 'demo-mobile',
        version: '1.0.0',
        dependencies: { react: '^19.0.0', 'react-native': '^0.80.0' },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(origin, 'src', 'App.tsx'),
    'export default function App() { return null; }\n',
    'utf8',
  );
  writeFileSync(join(origin, 'node_modules-should-be-skipped.txt'), 'x', 'utf8');
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: origin,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'ec-test',
        GIT_AUTHOR_EMAIL: 'ec-test@example.com',
        GIT_COMMITTER_NAME: 'ec-test',
        GIT_COMMITTER_EMAIL: 'ec-test@example.com',
      },
    });
  };
  git('init', '-b', 'main');
  git('add', '-A');
  git('commit', '-m', 'init');
  return origin;
}

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await runtime.invoke({ requestId: 'test', domain: 'workspace', method, params });
  if (!response.ok) {
    const error = new Error(response.error?.message ?? '域调用失败') as Error & {
      code?: string | undefined;
    };
    const code = response.error?.code;
    if (code !== undefined) error.code = code;
    throw error;
  }
  return response.result as T;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-git-import-'));
  dataDir = join(root, 'data');
  projectsDir = join(root, 'workspace', 'projects');
  db = openBusinessDb({ dataDir });
  runtime = createDomainRuntime({
    routers: { workspace: createWorkspaceDomain({ db, dataDir, projectsDir }).router },
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('从 Git 导入（真实本地仓库）', () => {
  it('克隆成功：落项目、按清单推断目标端与技术栈、登记代码根、写项目记忆', async () => {
    const origin = makeOriginRepo();
    const targetDir = join(root, 'cloned', 'demo-mobile');

    const project = await call<{
      id: string;
      name: string;
      sourceKind: string;
      sourceRef: string | null;
      gitRemote: string | null;
      targetPlatforms: string[];
      techStackFingerprint: Record<string, string> | null;
    }>('importFromGit', { input: { url: origin, targetDir } });

    // 项目来源与远程地址
    expect(project.sourceKind).toBe('git_import');
    expect(project.sourceRef).toBe(origin);
    expect(project.gitRemote).toBe(origin);
    // 未指定名字时从 URL 末段推导
    expect(project.name).toBe('origin-repo');

    // 推断：react-native → android/ios + 对应技术栈
    expect(project.targetPlatforms).toContain('android');
    expect(project.targetPlatforms).toContain('ios');
    expect(project.techStackFingerprint?.['android']).toBe('react-native');
    expect(project.techStackFingerprint?.['ios']).toBe('react-native');

    // 仓库真的落在用户指定目录（含提交历史）
    expect(existsSync(join(targetDir, 'package.json'))).toBe(true);
    expect(existsSync(join(targetDir, '.git'))).toBe(true);

    // 代码根被登记（导出/复制据此取文件）
    expect(readFileSync(codeRootPointerPath(join(projectsDir, project.id)), 'utf8')).toBe(
      targetDir,
    );
    // 工程目录结构仍然完整
    for (const subdir of ['design', 'docs', 'pipeline', 'code', 'meta']) {
      expect(existsSync(join(projectsDir, project.id, subdir))).toBe(true);
    }

    // 推断出的项目记忆草稿落库
    const memories = db
      .prepare(`SELECT scope, title, source_type FROM memory_item WHERE project_id = ?`)
      .all(project.id) as Array<{ scope: string; title: string; source_type: string }>;
    expect(memories.length).toBeGreaterThan(0);
    expect(memories.every((item) => item.source_type === 'git')).toBe(true);
  });

  it('指定项目名时以指定值为准', async () => {
    const origin = makeOriginRepo();
    const project = await call<{ name: string }>('importFromGit', {
      input: { url: origin, projectName: '我的移动端', targetDir: join(root, 'cloned2') },
    });
    expect(project.name).toBe('我的移动端');
  });

  it('非法 Git 地址被拒（含本地路径与 http(s)/git@ 之外的形式）', async () => {
    await expect(
      call('importFromGit', { input: { url: 'not a url', targetDir: join(root, 'x') } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      call('importFromGit', { input: { url: 'not a url', targetDir: join(root, 'x') } }),
    ).rejects.toThrowError(/不是可识别的 Git 地址/);
  });

  it('目标目录为空字符串时被拒（不能悄悄挑一个位置）', async () => {
    await expect(
      call('importFromGit', { input: { url: makeOriginRepo(), targetDir: '   ' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('目标目录已存在且非空时被拒，且不动里面任何内容', async () => {
    const origin = makeOriginRepo();
    const occupied = join(root, 'occupied');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, '用户的文件.txt'), '别动我', 'utf8');

    await expect(
      call('importFromGit', { input: { url: origin, targetDir: occupied } }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    // 用户原有内容必须原样保留
    expect(readFileSync(join(occupied, '用户的文件.txt'), 'utf8')).toBe('别动我');
    // 也不该留下项目行
    expect(db.prepare(`SELECT COUNT(*) AS n FROM project`).get()).toEqual({ n: 0 });
  });

  it('克隆失败时补偿清理：不留项目行，也不留工程目录', async () => {
    const missing = join(root, 'this-repo-does-not-exist');
    const targetDir = join(root, 'cloned-fail');

    await expect(
      call('importFromGit', { input: { url: missing, targetDir } }),
    ).rejects.toThrowError(/克隆失败/);

    // 项目行与工程目录都要被清掉（不能留一个指向空目录的僵尸项目）
    expect(db.prepare(`SELECT COUNT(*) AS n FROM project`).get()).toEqual({ n: 0 });
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM memory_item`).get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('导入后的项目可被复制（代码根登记生效，文件跟着走）', async () => {
    const origin = makeOriginRepo();
    const imported = await call<{ id: string }>('importFromGit', {
      input: { url: origin, targetDir: join(root, 'cloned-dup') },
    });

    const duplicated = await call<{ project: { id: string }; copied: Record<string, number> }>(
      'duplicateProject',
      {
        id: imported.id,
        options: {
          includeDesign: false,
          includeMemory: false,
          includeDocs: false,
          includeCode: true,
        },
      },
    );

    // 扫描的是登记的用户目录，而不是空的 <projectDir>/code
    expect(duplicated.copied.codeFiles).toBeGreaterThan(0);
    expect(existsSync(join(projectsDir, duplicated.project.id, 'code', 'package.json'))).toBe(true);
  });

  it('克隆与扫描期间经域事件通道上报三阶段进度', async () => {
    const origin = makeOriginRepo();
    const targetDir = join(root, 'cloned-progress');
    const requestId = 'workspace-progress-1';
    const events: DomainEvent[] = [];

    // 等价于 IPC 层在 invoke 期间把渲染进程发送器注册进来
    runtime.events.register(requestId, (event) => events.push(event));
    try {
      const response = await runtime.invoke({
        requestId,
        domain: 'workspace',
        method: 'importFromGit',
        params: { input: { url: origin, targetDir } },
      });
      expect(response.ok).toBe(true);
    } finally {
      runtime.events.unregister(requestId);
    }

    // 每条事件都带 requestId 与域，渲染层据此关联到本次调用
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((event) => event.requestId === requestId)).toBe(true);
    expect(events.every((event) => event.domain === 'workspace')).toBe(true);
    // 载荷全部能被渲染层守卫接受（形状/边界一致）
    expect(events.every((event) => isWorkspaceImportProgressEvent(event.payload))).toBe(true);

    const stages = events.map((event) => (event.payload as { stage: string }).stage);
    expect(stages[0]).toBe('clone');
    expect(stages).toContain('inspect');
    expect(stages).toContain('finalize');
    // 阶段单调推进：clone → inspect → finalize
    expect(stages.indexOf('clone')).toBeLessThan(stages.indexOf('inspect'));
    expect(stages.indexOf('inspect')).toBeLessThan(stages.indexOf('finalize'));

    // 首条事件把比例归零，界面不会先闪一个未知进度
    expect((events[0]?.payload as { ratio: number | null }).ratio).toBe(0);
    // 不可知比例的阶段用 null，而不是假装 100%
    const inspectEvent = events.find(
      (event) => (event.payload as { stage: string }).stage === 'inspect',
    );
    expect((inspectEvent?.payload as { ratio: number | null }).ratio).toBeNull();
  });

  it('导入在克隆前就被拒时不推任何进度事件（不报假进度）', async () => {
    const origin = makeOriginRepo();
    const occupied = join(root, 'occupied-progress');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'keep.txt'), 'x', 'utf8');

    const requestId = 'workspace-progress-fail';
    const events: DomainEvent[] = [];
    runtime.events.register(requestId, (event) => events.push(event));
    try {
      const response = await runtime.invoke({
        requestId,
        domain: 'workspace',
        method: 'importFromGit',
        params: { input: { url: origin, targetDir: occupied } },
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('ALREADY_EXISTS');
    } finally {
      runtime.events.unregister(requestId);
    }

    // 目录可用性检查失败发生在克隆之前，不该有"正在克隆"这类假进度
    expect(events).toEqual([]);
  });
});
