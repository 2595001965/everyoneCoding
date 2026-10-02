import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sourceDetectionSchema, type SourceDetection } from '@ec/core';
import { ZipWriter } from '@ec/package-kit';
import {
  createDomainEventSink,
  type DomainControlServiceHost,
  type DomainEvent,
  type DomainEventSink,
  type DomainRpcRequest,
} from '@ec/shell-api';

import { openBusinessDb } from '../domain/db';
import { createDomainRuntime } from '../domain/runtime';
import { createWorkspaceDomain } from '../domain/workspace';
import { codeRootPointerPath, resolveCodeRoot } from '../domain/code-root';
import { createZipImportPort } from '../domain/zip-import-port';

/**
 * V2-D01 文件接入端到端测试（真实 SQLite + 真实文件系统 + 真实 ZIP 字节）。
 *
 * 覆盖验收条款：
 * - 打开（link）/复制/克隆/ZIP 四路径（克隆在 domain-workspace-git.test.ts，此处补
 *   「Git 导入产物接入统一识别管线」一条）；
 * - 取消文件夹选择/复制中途取消不写文件、只清本次创建的临时内容（V2-SRC-10）；
 * - 未提交改动保护：link 导入 + 重扫全程对源目录零写入；
 * - 非 Git/中文/空格路径；
 * - ZIP 防穿越/盘符/UNC/ADS/大小写碰撞/解压炸弹；
 * - 未知栈不误报支持（previewSourceDetection 返回 unknown 且无运行计划）；
 * - 统一识别管线（Git 与文件夹/ZIP 同一落盘口径、revision 递增）。
 */

let root: string;
let dataDir: string;
let projectsDir: string;
let db: Database.Database;
let runtime: DomainControlServiceHost;
/** 事件钩子（测试可在首个 copy 进度事件时注入取消 RPC） */
let onDomainEvent: ((event: DomainEvent) => void) | null = null;

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await runtime.invoke({
    requestId: 'test',
    domain: 'workspace',
    method,
    params,
  });
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

/** 期望失败的调用：返回错误（断言 code 用） */
async function callExpectError(
  method: string,
  params: Record<string, unknown>,
): Promise<Error & { code?: string }> {
  try {
    await call(method, params);
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error(`期望 ${method} 失败，但成功了`);
}

/** 事件代理 sink：转发给真实 sink，并通知测试钩子 */
function makeHookedSink(): DomainEventSink {
  const real = createDomainEventSink();
  return {
    register: (id, send) => real.register(id, send),
    unregister: (id) => real.unregister(id),
    send: (event) => {
      real.send(event);
      onDomainEvent?.(event);
    },
    broadcast: (event) => real.broadcast(event),
    subscribe: (listener) => real.subscribe(listener),
  };
}

/** 造一个普通（非 Git）源码目录：React+Vite 特征，中文+空格路径 */
function makeSourceFolder(name: string): string {
  const source = join(root, name); // 名称自带中文与空格
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'demo-web',
      version: '1.0.0',
      scripts: { dev: 'vite' },
      dependencies: { react: '^19.0.0' },
      devDependencies: { vite: '^7.0.0' },
    }),
    'utf8',
  );
  writeFileSync(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
  writeFileSync(
    join(source, 'src', 'main.tsx'),
    'import { createRoot } from "react-dom/client";\n',
    'utf8',
  );
  writeFileSync(join(source, 'index.html'), '<!doctype html><html><body></body></html>\n', 'utf8');
  return source;
}

/** 造一个带未提交改动的 Git 仓库；返回 { path, statusBefore } */
function makeGitRepoWithUncommittedChanges(): { path: string; statusBefore: string } {
  const repo = join(root, 'dirty-repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# base\n', 'utf8');
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: repo,
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
  // 未提交改动：既有文件修改 + 新增未跟踪文件
  writeFileSync(join(repo, 'README.md'), '# base\n# local edit not committed\n', 'utf8');
  writeFileSync(join(repo, 'wip.txt'), 'work in progress\n', 'utf8');
  const statusBefore = execFileSync('git', ['status', '--porcelain'], {
    cwd: repo,
    encoding: 'utf8',
  });
  return { path: repo, statusBefore };
}

/** 用 ZipWriter 造 ZIP（字节级真实；entry 名不做安全过滤，可造恶意包） */
function makeZip(zipPath: string, entries: Array<{ path: string; content: string }>): void {
  mkdirSync(dirname(zipPath), { recursive: true });
  const writer = ZipWriter.create(zipPath);
  for (const entry of entries) {
    writer.addText(entry.path, entry.content);
  }
  writer.close();
}

/** 大量小文件目录（复制中途取消用） */
function makeWideFolder(fileCount: number): string {
  const source = join(root, 'wide-source');
  mkdirSync(source, { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    writeFileSync(
      join(source, `f-${String(index).padStart(5, '0')}.txt`),
      `content-${index}\n`,
      'utf8',
    );
  }
  return source;
}

/** 读落盘的识别结果 */
function readDetection(projectId: string): SourceDetection | null {
  const file = join(projectsDir, projectId, 'meta', 'source-detection.json');
  if (!existsSync(file)) return null;
  return sourceDetectionSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) as SourceDetection;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-ws-source-'));
  dataDir = join(root, 'data');
  projectsDir = join(root, 'workspace', 'projects');
  db = openBusinessDb({ dataDir });
  onDomainEvent = null;
  const hooked = makeHookedSink();
  runtime = createDomainRuntime({
    routers: { workspace: createWorkspaceDomain({ db, dataDir, projectsDir }).router },
    events: hooked,
  });
});

afterEach(() => {
  onDomainEvent = null;
  db.close();
  // Windows 句柄回收容错（与既有 workspace 测试同口径）：重试后放弃，不影响断言
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < 3) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60 * (attempt + 1));
      }
    }
  }
  console.warn(`[test] 临时目录未能清理（不影响断言）：${root}`);
});

describe('打开文件夹（link / copy）', () => {
  it('link 模式：中文空格路径、非 Git 目录直接关联，代码根指向原目录', async () => {
    const source = makeSourceFolder('我的 应用'); // 中文 + 空格
    const project = await call<{ id: string }>('importFromFolder', {
      input: { path: source },
    });

    const row = (await call<{ id: string; sourceKind: string }>('getProject', {
      id: project.id,
    })) as unknown as { id: string; sourceKind: string; sourceRef: string | null };
    expect(row.sourceKind).toBe('existing_folder');
    expect(row.sourceRef).toBe(source);

    // 代码根指针登记原目录（不复制）
    expect(readFileSync(codeRootPointerPath(join(projectsDir, project.id)), 'utf8')).toBe(source);
    expect(resolveCodeRoot(join(projectsDir, project.id))).toBe(source);

    // 统一识别管线落盘且 schema 合法（react-vite → supported）
    const detection = readDetection(project.id);
    expect(detection).not.toBeNull();
    expect(detection?.revision).toBe(1);
    const sub = detection?.subProjects[0];
    expect(sub?.framework).toBe('react-vite');
    expect(sub?.supportLevel).toBe('supported');
    expect(sub?.packageManager).toBe('pnpm');
    expect(sub?.suggestedRunPlan?.cwd).toBe(source);
  });

  it('link 模式不复制文件：工程目录内没有源码副本', async () => {
    const source = makeSourceFolder('只关联 不复制');
    const project = await call<{ id: string }>('importFromFolder', { input: { path: source } });
    // code 目录由 ensureProjectDirs 预建（Layout 约定），link 模式下必须保持为空
    const codeDir = join(projectsDir, project.id, 'code');
    expect(readdirSync(codeDir).length).toBe(0);
  });

  it('copy 模式：文件复制进工程 code 目录，源目录保持不动', async () => {
    const source = makeSourceFolder('复制 来源');
    const before = statSync(join(source, 'package.json')).mtimeMs;
    const project = await call<{ id: string }>('importFromFolder', {
      input: { path: source, mode: 'copy' },
    });

    const row = (await call<{ sourceKind: string }>('getProject', {
      id: project.id,
    })) as unknown as {
      sourceKind: string;
    };
    expect(row.sourceKind).toBe('copied_folder');

    const codeDir = resolveCodeRoot(join(projectsDir, project.id));
    expect(existsSync(join(codeDir, 'src', 'main.tsx'))).toBe(true);
    expect(readFileSync(join(codeDir, 'package.json'), 'utf8')).toContain('demo-web');
    // 源目录 mtime 未被触碰（只读复制）
    expect(statSync(join(source, 'package.json')).mtimeMs).toBe(before);
  });

  it('link 模式拒绝工作区内的目录（防 purge 自嵌套）', async () => {
    // 注意：不能用 mkdirSync 的返回值（recursive 时返回首个父目录且带 \\?\ 前缀）
    const inside = join(projectsDir, 'inside');
    mkdirSync(inside, { recursive: true });
    const error = await callExpectError('importFromFolder', { input: { path: inside } });
    expect(error.code).toBe('INVALID_ARGUMENT');
  });

  it('目录不存在报 NOT_FOUND；路径是文件报 INVALID_ARGUMENT', async () => {
    const missing = await callExpectError('importFromFolder', {
      input: { path: join(root, '不存在') },
    });
    expect(missing.code).toBe('NOT_FOUND');

    const filePath = join(root, 'a-file.txt');
    writeFileSync(filePath, 'x', 'utf8');
    const notDir = await callExpectError('importFromFolder', { input: { path: filePath } });
    expect(notDir.code).toBe('INVALID_ARGUMENT');
  });

  it('未提交改动保护：Git 仓库 link 导入 + 重扫后 git status 与工作区内容不变', async () => {
    const { path: repo, statusBefore } = makeGitRepoWithUncommittedChanges();
    const readmeBefore = readFileSync(join(repo, 'README.md'), 'utf8');

    const project = await call<{ id: string }>('importFromFolder', { input: { path: repo } });
    // 重扫（V2-SRC-09）：识别是只读派生，不改源码
    await call('detectSource', { projectId: project.id });

    const statusAfter = execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(statusAfter).toBe(statusBefore);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe(readmeBefore);
    expect(existsSync(join(repo, 'wip.txt'))).toBe(true);
    // 重扫 revision 递增到 2
    expect(readDetection(project.id)?.revision).toBe(2);
  });

  it('previewSourceDetection 只读预扫描：不建项目、不写文件', async () => {
    const source = makeSourceFolder('预览 源');
    const preview = await call<{ codeRoot: string; detection: { requiresConfirmation: boolean } }>(
      'previewSourceDetection',
      { path: source },
    );
    expect(preview.codeRoot).toBe(source);
    expect(preview.detection.requiresConfirmation).toBe(true);
    expect((await call<Array<unknown>>('listProjects', {})).length).toBe(0);
  });

  it('未知栈不误报支持：无清单目录识别为 unknown 且无运行计划', async () => {
    const source = join(root, 'mystery');
    mkdirSync(join(source, 'data'), { recursive: true });
    writeFileSync(join(source, 'data', 'blob.bin'), 'zzz', 'utf8');
    const preview = await call<{
      detection: {
        subProjects: Array<{ supportLevel: string; suggestedRunPlan: unknown }>;
        notes: string[];
      };
    }>('previewSourceDetection', { path: source });
    expect(preview.detection.subProjects[0]?.supportLevel).toBe('unknown');
    expect(preview.detection.subProjects[0]?.suggestedRunPlan).toBeNull();
    expect(preview.detection.notes.join('')).toContain('不会自动给出运行命令');
  });
});

describe('ZIP 导入', () => {
  it('happy path：安全解压到新目录（含中文文件名）、识别落盘、代码根指向解压目录', async () => {
    const zipPath = join(root, '归档 包.zip');
    makeZip(zipPath, [
      {
        path: 'package.json',
        content: JSON.stringify({
          scripts: { dev: 'vite' },
          dependencies: { react: '^19', vite: '^7' },
        }),
      },
      { path: 'src/入口.tsx', content: 'export {};\n' },
      { path: 'index.html', content: '<html></html>' },
    ]);
    const targetDir = join(root, 'unpacked');
    const project = await call<{ id: string }>('importFromZip', {
      input: { zipPath, targetDir },
    });

    expect(existsSync(join(targetDir, 'src', '入口.tsx'))).toBe(true);
    expect(readFileSync(codeRootPointerPath(join(projectsDir, project.id)), 'utf8')).toBe(
      targetDir,
    );
    const row = (await call<{ sourceKind: string }>('getProject', {
      id: project.id,
    })) as unknown as {
      sourceKind: string;
    };
    expect(row.sourceKind).toBe('zip_extract');
    expect(readDetection(project.id)?.subProjects[0]?.framework).toBe('react-vite');
  });

  it('防穿越：../ 条目被拒（PATH_ESCAPE），不越界写文件、项目无残留', async () => {
    const zipPath = join(root, 'evil-traversal.zip');
    const outsideMarker = join(root, 'evil.txt');
    makeZip(zipPath, [
      { path: 'index.html', content: '<html></html>' },
      { path: '../evil.txt', content: 'escaped' },
    ]);
    const targetDir = join(root, 'unpacked-traversal');
    const error = await callExpectError('importFromZip', { input: { zipPath, targetDir } });
    expect(error.code).toBe('PATH_ESCAPE');
    expect(existsSync(outsideMarker)).toBe(false);
    expect(existsSync(targetDir)).toBe(false);
    expect((await call<Array<unknown>>('listProjects', {})).length).toBe(0);
  });

  it('防盘符/UNC/ADS/绝对路径：全部 PATH_ESCAPE 且项目无残留', async () => {
    for (const [label, entry] of [
      ['盘符', 'C:/evil.txt'],
      ['UNC', '//server/share/evil.txt'],
      ['ADS', 'a.txt:stream'],
      ['绝对路径', '/etc/evil.txt'],
    ] as const) {
      const zipPath = join(root, `evil-${label}.zip`);
      makeZip(zipPath, [{ path: entry, content: 'x' }]);
      const targetDir = join(root, `unpacked-${label}`);
      const error = await callExpectError('importFromZip', { input: { zipPath, targetDir } });
      expect(error.code, label).toBe('PATH_ESCAPE');
      expect((await call<Array<unknown>>('listProjects', {})).length, label).toBe(0);
    }
  });

  it('防大小写碰撞：Readme.md 与 readme.md 拒绝解压（Windows 静默覆盖风险）', async () => {
    const zipPath = join(root, 'evil-case.zip');
    makeZip(zipPath, [
      { path: 'Readme.md', content: 'A' },
      { path: 'readme.md', content: 'B' },
    ]);
    const error = await callExpectError('importFromZip', {
      input: { zipPath, targetDir: join(root, 'unpacked-case') },
    });
    expect(error.code).toBe('INVALID_ARGUMENT');
  });

  it('防解压炸弹：高压缩比条目被拒（RATIO_LIMIT）', async () => {
    const zipPath = join(root, 'evil-bomb.zip');
    makeZip(zipPath, [{ path: 'bomb.bin', content: 'a'.repeat(10_000_000) }]);
    const error = await callExpectError('importFromZip', {
      input: { zipPath, targetDir: join(root, 'unpacked-bomb') },
    });
    expect(error.code).toBe('INVALID_ARGUMENT');
  });

  it('目标目录已存在且非空时拒绝（不覆盖已有内容）', async () => {
    const zipPath = join(root, 'normal.zip');
    makeZip(zipPath, [{ path: 'index.html', content: '<html></html>' }]);
    const targetDir = join(root, 'occupied');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'existing.txt'), 'keep me', 'utf8');

    const error = await callExpectError('importFromZip', { input: { zipPath, targetDir } });
    expect(error.code).toBe('ALREADY_EXISTS');
    expect(readFileSync(join(targetDir, 'existing.txt'), 'utf8')).toBe('keep me');
    expect((await call<Array<unknown>>('listProjects', {})).length).toBe(0);
  });

  it('损坏 ZIP 在建项目前就失败（IO_ERROR，不做无谓补偿）', async () => {
    const zipPath = join(root, 'broken.zip');
    writeFileSync(zipPath, 'this is not a zip file'.repeat(10), 'utf8');
    const error = await callExpectError('importFromZip', {
      input: { zipPath, targetDir: join(root, 'unpacked-broken') },
    });
    expect(error.code).toBe('IO_ERROR');
    expect((await call<Array<unknown>>('listProjects', {})).length).toBe(0);
  });
});

describe('取消（V2-SRC-10：只清本次创建的临时内容）', () => {
  it('预取消：已登记取消令牌的导入立即 CANCELLED，无项目残留', async () => {
    const source = makeSourceFolder('预取消');
    const importToken = 'token-pre-cancel';
    await call('cancelSourceImport', { importToken });
    const error = await callExpectError('importFromFolder', {
      input: { path: source, importToken },
    });
    expect(error.code).toBe('CANCELLED');
    expect((await call<Array<unknown>>('listProjects', {})).length).toBe(0);
    expect(existsSync(source)).toBe(true); // 源目录毫发无损
  });

  it('复制中途取消：CANCELLED、工程目录与 code 副本被清理、源目录完整', async () => {
    const source = makeWideFolder(2000);
    const importToken = 'token-mid-copy';

    // 在首个 copy 进度事件时注入取消 RPC（复制循环每 64 文件让出事件循环，
    // 取消请求会在下一个 yield 点落地并被轮询发现——与生产 IPC 并发同构）
    let cancelDispatched = false;
    onDomainEvent = (event) => {
      const payload = event.payload as { stage?: string; ratio?: number | null };
      if (!cancelDispatched && payload?.stage === 'copy' && typeof payload.ratio === 'number') {
        cancelDispatched = true;
        const request: DomainRpcRequest = {
          requestId: 'cancel-mid-copy',
          domain: 'workspace',
          method: 'cancelSourceImport',
          params: { importToken },
        };
        void runtime.invoke(request);
      }
    };

    const error = await callExpectError('importFromFolder', {
      input: { path: source, mode: 'copy', importToken },
    });
    expect(error.code).toBe('CANCELLED');
    expect(cancelDispatched).toBe(true);

    // 只清本次创建的：项目行与工程目录（含 code 副本）消失，源目录完整保留
    expect((await call<Array<unknown>>('listProjects', {})).length).toBe(0);
    expect(existsSync(source)).toBe(true);
    expect(readdirSync(source).length).toBe(2000);
    expect(existsSync(join(projectsDir, 'code'))).toBe(false);
  });

  it('ZIP 提取中途取消（端口级）：isCancelled 在条目间生效并中止', async () => {
    const zipPath = join(root, 'wide.zip');
    makeZip(
      zipPath,
      Array.from({ length: 500 }, (_, index) => ({
        path: `f-${String(index).padStart(4, '0')}.txt`,
        content: `content-${index}`,
      })),
    );
    const targetDir = join(root, 'unpacked-wide');
    mkdirSync(targetDir, { recursive: true });

    let cancelled = false;
    const port = createZipImportPort();
    const error = await port
      .extract(zipPath, targetDir, {
        isCancelled: () => cancelled,
        onProgress: (done) => {
          if (done >= 5) cancelled = true;
        },
      })
      .then(() => null)
      .catch((caught: Error & { code?: string }) => caught);

    expect(error?.code).toBe('CANCELLED');
    // 中止语义：不再继续写（已写条目由调用方清理，此处只断言未解压完）
    expect(readdirSync(targetDir).length).toBeLessThan(500);
  });
});

describe('统一识别管线与 Git 不退化', () => {
  it('getSourceDetection：旧项目（无识别文件）返回 null，不编造结果', async () => {
    const created = await call<{ id: string }>('createProject', { input: { name: '旧项目' } });
    expect(await call('getSourceDetection', { projectId: created.id })).toBeNull();
  });

  it('detectSource 对不存在的项目报 NOT_FOUND', async () => {
    const error = await callExpectError('detectSource', { projectId: 'missing' });
    expect(error.code).toBe('NOT_FOUND');
  });

  it('Git 导入产物接入同一识别管线：detection 与代码根指针同时落盘（Git 原能力不退化）', async () => {
    const origin = join(root, 'origin-git');
    mkdirSync(join(origin, 'src'), { recursive: true });
    writeFileSync(
      join(origin, 'package.json'),
      JSON.stringify({
        name: 'demo',
        dependencies: { react: '^19', vite: '^7' },
        scripts: { dev: 'vite' },
      }),
      'utf8',
    );
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

    const targetDir = join(root, 'cloned');
    const project = await call<{ id: string }>('importFromGit', {
      input: { url: origin, targetDir },
    });

    // 既有能力不退化：项目落库、代码根指针指向克隆目录
    expect(existsSync(join(targetDir, 'package.json'))).toBe(true);
    expect(readFileSync(codeRootPointerPath(join(projectsDir, project.id)), 'utf8')).toBe(
      targetDir,
    );
    // 新管线：Git 导入也产出统一识别结果（react-vite → supported）
    const detection = readDetection(project.id);
    expect(detection?.subProjects[0]?.framework).toBe('react-vite');
    expect(detection?.subProjects[0]?.supportLevel).toBe('supported');
    //getSourceDetection 域方法读到同一份
    expect(
      (await call<SourceDetection>('getSourceDetection', { projectId: project.id })).projectId,
    ).toBe(project.id);
  });
});
