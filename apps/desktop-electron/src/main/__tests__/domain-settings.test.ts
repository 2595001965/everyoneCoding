import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_COMMANDS } from '@ec/core';
import type { DomainControlServiceHost } from '@ec/shell-api';
import type Database from 'better-sqlite3';

import { openBusinessDb } from '../domain/db';
import { createDomainRuntime, type DomainRouterContext } from '../domain/runtime';
import { createSettingsDomain, type SettingsDomain } from '../domain/settings';

/**
 * settings 域运行时测试（真实临时目录，不做假 IO）。
 *
 * 重点：
 * - `update` / `saveKeymap` / `saveBackupConfig` 必须真的落盘（重启后仍在）；
 * - 数据目录迁移必须**按条目数校验**，不一致时如实报失败并清掉复制产物；
 * - 归档导出/导入走真实 `.ecpkg`，并做**导出→导入→再导出**的往返一致性验证；
 * - 加密导出缺口令时必须拒绝，不得静默产出未加密文件。
 *
 * 调用一律经 `createDomainRuntime`：错误码映射与脱敏发生在那一层，
 * 直接调 router 会拿到未映射的原始异常，测出来的结论不代表真实链路。
 */

let root: string;
let dataDir: string;
let projectsDir: string;
let db: Database.Database;
let domain: SettingsDomain;
let runtime: DomainControlServiceHost;

function makeDomain(): SettingsDomain {
  return createSettingsDomain({
    dataDir: join(root, 'data'),
    cacheDir: join(root, 'cache'),
    defaultWorkspaceRoot: join(root, 'workspace'),
    projectsDir: join(root, 'workspace', 'projects'),
    db,
  });
}

/**
 * 直连 router 时用的最小上下文（绕过 runtime 单独问一次域实现时使用）。
 * 此时没有事件接收方，`emit` 用空实现。
 */
const DIRECT_CTX: DomainRouterContext = { requestId: 'test-direct', emit: () => undefined };

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await runtime.invoke({ requestId: 'test', domain: 'settings', method, params });
  if (!response.ok) {
    const error = new Error(response.error?.message ?? '域调用失败') as Error & { code?: string };
    // exactOptionalPropertyTypes 下不可显式赋值 undefined，故仅在确有 code 时写入
    const code = response.error?.code;
    if (code !== undefined) error.code = code;
    throw error;
  }
  return response.result as T;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-settings-'));
  dataDir = join(root, 'data');
  projectsDir = join(root, 'workspace', 'projects');
  db = openBusinessDb({ dataDir });
  domain = makeDomain();
  runtime = createDomainRuntime({ routers: { settings: domain.router } });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('设置读写与落盘', () => {
  it('getAll 返回带默认值的全局设置', async () => {
    const settings = await call<{
      language: string;
      theme: string;
      keymap: Record<string, string>;
    }>('getAll');
    expect(settings.language).toBe('zh-CN');
    expect(settings.theme).toBe('light');
    expect(settings.keymap).toEqual({});
  });

  it('update 即时生效并写入 settings.json', async () => {
    const next = await call<{ theme: string }>('update', { patch: { theme: 'dark' } });
    expect(next.theme).toBe('dark');

    const file = join(root, 'data', 'settings.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).global.theme).toBe('dark');

    // 新实例从磁盘恢复，证明是持久化而非内存态
    const reopened = makeDomain();
    const restored = (await reopened.router('getAll', {}, DIRECT_CTX)) as { theme: string };
    expect(restored.theme).toBe('dark');
  });

  it('update 的非法值被 zod 拒绝且不写盘', async () => {
    await expect(call('update', { patch: { theme: 'neon' } })).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
    const file = join(root, 'data', 'settings.json');
    expect(existsSync(file)).toBe(false);
  });

  it('update 缺 patch 时报 INVALID_ARGUMENT', async () => {
    await expect(call('update', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('数据目录', () => {
  it('getDataDirs 返回四个真实值且 sqlitePath 落在 dataDir 下', async () => {
    const dirs = await call<{
      workspaceRoot: string;
      projectsDir: string;
      sqlitePath: string;
      cacheDir: string;
    }>('getDataDirs');
    expect(dirs.workspaceRoot).toBe(join(root, 'workspace'));
    expect(dirs.projectsDir).toBe(join(root, 'workspace', 'projects'));
    expect(dirs.sqlitePath).toBe(join(root, 'data', 'everyonecoding.sqlite'));
    expect(dirs.cacheDir).toBe(join(root, 'cache'));
  });

  it('迁移：工程目录被复制、条目数一致、旧目录改名备份', async () => {
    const source = join(root, 'workspace', 'projects');
    mkdirSync(join(source, 'p1'), { recursive: true });
    writeFileSync(join(source, 'p1', 'a.txt'), 'a');
    writeFileSync(join(source, 'p1', 'b.txt'), 'b');

    const target = join(root, 'moved', 'projects');
    const result = await call<{
      ok: boolean;
      counts: { before: number; after: number };
      backupDir?: string;
    }>('migrateDataDirs', { next: { workspaceRoot: join(root, 'moved'), projectsDir: target } });

    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ before: 2, after: 2 });
    expect(readFileSync(join(target, 'p1', 'a.txt'), 'utf8')).toBe('a');
    // 旧目录不再原地存在，而是改名为备份目录
    expect(existsSync(source)).toBe(false);
    expect(result.backupDir).toBeTruthy();
    expect(existsSync(result.backupDir as string)).toBe(true);

    // 新目录写进设置，后续 getDataDirs 跟随
    const dirs = await call<{ projectsDir: string }>('getDataDirs');
    expect(dirs.projectsDir).toBe(target);
  });

  it('迁移校验失败时清掉复制产物、旧目录保留、如实报 rolledBack', async () => {
    const source = join(root, 'workspace', 'projects');
    mkdirSync(join(source, 'p1'), { recursive: true });
    writeFileSync(join(source, 'p1', 'a.txt'), 'a');

    // 目标目录预置一个多余文件 → 迁移后条目数变多 → 校验必须失败
    const target = join(root, 'moved', 'projects');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'extra.txt'), 'x');

    const result = await call<{ ok: boolean; error?: string; rolledBack?: boolean }>(
      'migrateDataDirs',
      {
        next: { workspaceRoot: join(root, 'moved'), projectsDir: target },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('条目数与迁移前不一致');
    expect(result.rolledBack).toBe(true);
    // 源目录必须还在（不能被误删）
    expect(readFileSync(join(source, 'p1', 'a.txt'), 'utf8')).toBe('a');
  });

  it('无迁移记录时 rollbackMigration 抛 NOT_FOUND', async () => {
    await expect(call('rollbackMigration')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('迁移后 rollbackMigration 把目录搬回并回滚工作区设置', async () => {
    const source = join(root, 'workspace', 'projects');
    mkdirSync(join(source, 'p1'), { recursive: true });
    writeFileSync(join(source, 'p1', 'a.txt'), 'a');

    const target = join(root, 'moved', 'projects');
    await call('migrateDataDirs', {
      next: { workspaceRoot: join(root, 'moved'), projectsDir: target },
    });

    const result = await call<{ ok: boolean; rolledBack?: boolean }>('rollbackMigration');
    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(readFileSync(join(source, 'p1', 'a.txt'), 'utf8')).toBe('a');

    const dirs = await call<{ workspaceRoot: string }>('getDataDirs');
    expect(dirs.workspaceRoot).toBe(join(root, 'workspace'));
  });
});

describe('命令目录与快捷键', () => {
  it('listCommands 与 @ec/core 的命令目录一致（含唯一的真实默认键位）', async () => {
    const commands =
      await call<Array<{ id: string; title: string; defaultKey: string | null }>>('listCommands');
    expect(commands).toHaveLength(APP_COMMANDS.length);
    expect(commands.map((item) => item.id)).toEqual(APP_COMMANDS.map((item) => item.id));
    expect(commands.filter((item) => item.defaultKey !== null)).toEqual([
      { id: 'app.commandPalette', title: '快速跳转', defaultKey: 'Ctrl+K' },
    ]);
  });

  it('saveKeymap 落盘；exportKeymap 回读一致', async () => {
    const result = await call<{ ok: boolean; conflicts: unknown[] }>('saveKeymap', {
      keymap: { 'nav.docs': 'Ctrl+Shift+D' },
    });
    expect(result).toEqual({ ok: true, conflicts: [] });

    const json = await call<string>('exportKeymap');
    expect(JSON.parse(json)).toEqual({ 'nav.docs': 'Ctrl+Shift+D' });
  });

  it('importKeymap 解析后落盘；坏 JSON 与非对象都报 INVALID_ARGUMENT', async () => {
    const parsed = await call<Record<string, string>>('importKeymap', {
      json: JSON.stringify({ 'nav.settings': 'Ctrl+,' }),
    });
    expect(parsed).toEqual({ 'nav.settings': 'Ctrl+,' });
    expect(JSON.parse(await call<string>('exportKeymap'))).toEqual({ 'nav.settings': 'Ctrl+,' });

    await expect(call('importKeymap', { json: '{坏' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(call('importKeymap', { json: '[]' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('saveKeymap 过滤掉非字符串值，避免脏数据落盘', async () => {
    await call('saveKeymap', { keymap: { 'nav.docs': 'Ctrl+D', 'nav.git': 42 } });
    expect(JSON.parse(await call<string>('exportKeymap'))).toEqual({ 'nav.docs': 'Ctrl+D' });
  });
});

describe('隐私与本地遥测', () => {
  it('默认关闭；开启写入设置，关闭时清空本地缓冲', async () => {
    const before = await call<{ privacy: { telemetryEnabled: boolean } }>('getAll');
    expect(before.privacy.telemetryEnabled).toBe(false);

    await call('setTelemetry', { enabled: true });
    const after = await call<{ privacy: { telemetryEnabled: boolean } }>('getAll');
    expect(after.privacy.telemetryEnabled).toBe(true);

    // 造一条缓冲，验证关闭时确实被清掉
    writeFileSync(
      join(root, 'data', 'telemetry-buffer.json'),
      JSON.stringify([{ seq: 1, recordedAt: 1, name: 'x' }]),
    );
    await call('setTelemetry', { enabled: false });
    const inspection = await call<{ telemetryRecords: number }>('inspectLocalTelemetry');
    expect(inspection.telemetryRecords).toBe(0);
  });

  it('clearLocalTelemetry 清空缓冲与缓存目录并回传全 0', async () => {
    writeFileSync(
      join(root, 'data', 'telemetry-buffer.json'),
      JSON.stringify([{ seq: 1, recordedAt: 1, name: 'x' }]),
    );
    mkdirSync(join(root, 'cache', 'sub'), { recursive: true });
    writeFileSync(join(root, 'cache', 'sub', 'blob.bin'), 'x'.repeat(64));

    const inspected = await call<{ telemetryRecords: number; cacheBytes: number }>(
      'inspectLocalTelemetry',
    );
    expect(inspected.telemetryRecords).toBe(1);
    expect(inspected.cacheBytes).toBe(64);

    const cleared = await call<{ telemetryRecords: number; cacheBytes: number }>(
      'clearLocalTelemetry',
    );
    expect(cleared).toEqual({ telemetryRecords: 0, cacheBytes: 0 });
    expect(existsSync(join(root, 'cache'))).toBe(true);
  });

  it('setTelemetry 缺 enabled 时报 INVALID_ARGUMENT', async () => {
    await expect(call('setTelemetry', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('定时备份配置', () => {
  it('默认值可用；保存后落盘并可回读', async () => {
    const initial = await call<{ intervalHours: number; dir: string; lastRunAt: number | null }>(
      'getBackupConfig',
    );
    expect(initial.intervalHours).toBe(24);
    expect(initial.lastRunAt).toBeNull();

    await call('saveBackupConfig', { config: { intervalHours: 6, dir: join(root, 'bak') } });
    const saved = await call<{ intervalHours: number; dir: string }>('getBackupConfig');
    expect(saved.intervalHours).toBe(6);
    expect(saved.dir).toBe(join(root, 'bak'));

    const reopened = makeDomain();
    const restored = (await reopened.router('getBackupConfig', {}, DIRECT_CTX)) as {
      intervalHours: number;
    };
    expect(restored.intervalHours).toBe(6);
  });

  it('非法间隔被拒（0 / 负数 / 非数字）', async () => {
    for (const intervalHours of [0, -3, 'abc']) {
      await expect(
        call('saveBackupConfig', { config: { intervalHours, dir: 'D:/x' } }),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    }
  });
});

describe('归档导出与导入（真实 .ecpkg）', () => {
  const projectId = 'p-export';

  /** 造一个内容齐全的项目：代码文件 + 记忆 + 文档 */
  function seedProject(): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO project (id, user_id, workspace_id, name, description, tech_stack_json, status,
         created_at, updated_at, target_platforms, tech_stack_fingerprint, git_remote, pinned,
         last_opened_at, deleted_at, source_kind, source_ref)
       VALUES (?, 'local-user', NULL, '演示项目', '导出用', NULL, 'active', ?, ?, '[]', NULL, NULL, 0, NULL, NULL, 'blank', NULL)`,
    ).run(projectId, now, now);

    mkdirSync(join(projectsDir, projectId, 'code', 'src'), { recursive: true });
    writeFileSync(
      join(projectsDir, projectId, 'code', 'src', 'index.ts'),
      'export const a = 1;',
      'utf8',
    );

    db.prepare(
      `INSERT INTO memory_item (id, user_id, scope, project_id, title, content, tags, source_type,
         confidence, importance, status, pinned, version, created_at, updated_at)
       VALUES ('m-1', 'local-user', 'project', ?, '技术选型', '用 React', '["前端"]', 'manual', 1.0, 3, 'active', 0, 1, ?, ?)`,
    ).run(projectId, now, now);

    db.prepare(
      `INSERT INTO document (id, project_id, kind, title, content_ref, version, created_at, updated_at,
         format, content_text, sections_json, source_ref, deleted_at, ignored_version)
       VALUES ('d-1', ?, 'requirement', '登录需求', NULL, 1, ?, ?, 'markdown', '# 登录需求', NULL, NULL, NULL, NULL)`,
    ).run(projectId, now, now);
  }

  it('完整归档：产出 .ecpkg、文件存在且有体积', async () => {
    seedProject();
    const result = await call<{ ok: boolean; filePath: string; bytes: number; mode: string }>(
      'exportProject',
      {
        input: { projectId, mode: 'full', encrypted: false },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('full');
    expect(existsSync(result.filePath)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('项目不存在时如实报 NOT_FOUND', async () => {
    await expect(
      call('exportProject', { input: { projectId: 'missing', mode: 'full', encrypted: false } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('勾选加密却没给口令时拒绝导出（绝不静默产出未加密文件）', async () => {
    seedProject();
    await expect(
      call('exportProject', { input: { projectId, mode: 'full', encrypted: true } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      call('exportProject', { input: { projectId, mode: 'full', encrypted: true } }),
    ).rejects.toThrowError(/不会退化成未加密导出/);
  });

  it('导出 → 导入到**空库**：项目 / 记忆 / 文档 / 代码全部回来', async () => {
    seedProject();
    const exported = await call<{ filePath: string }>('exportProject', {
      input: { projectId, mode: 'full', encrypted: false },
    });

    // 另起一套全新的 dataDir + projectsDir，模拟"换台机器恢复"
    const freshRoot = mkdtempSync(join(tmpdir(), 'ec-settings-restore-'));
    const freshDb = openBusinessDb({ dataDir: join(freshRoot, 'data') });
    try {
      const freshDomain = createSettingsDomain({
        dataDir: join(freshRoot, 'data'),
        cacheDir: join(freshRoot, 'cache'),
        defaultWorkspaceRoot: join(freshRoot, 'workspace'),
        projectsDir: join(freshRoot, 'workspace', 'projects'),
        db: freshDb,
      });
      const freshRuntime = createDomainRuntime({ routers: { settings: freshDomain.router } });
      const response = await freshRuntime.invoke({
        requestId: 'restore',
        domain: 'settings',
        method: 'importPackage',
        params: { input: { filePath: exported.filePath } },
      });
      expect(response.ok, JSON.stringify(response.error)).toBe(true);
      const result = response.result as {
        ok: boolean;
        counts: { memory: number; docs: number; codeFiles: number };
        conflicted: number;
      };
      expect(result.ok).toBe(true);
      expect(result.counts).toEqual({ memory: 1, docs: 1, codeFiles: 1 });
      expect(result.conflicted).toBe(0);

      // 项目、记忆、文档都真的落库了
      expect(freshDb.prepare(`SELECT name FROM project WHERE id = ?`).get(projectId)).toEqual({
        name: '演示项目',
      });
      expect(
        freshDb
          .prepare(`SELECT COUNT(*) AS n FROM memory_item WHERE project_id = ?`)
          .get(projectId),
      ).toEqual({ n: 1 });
      expect(
        freshDb.prepare(`SELECT COUNT(*) AS n FROM document WHERE project_id = ?`).get(projectId),
      ).toEqual({ n: 1 });
      // 代码文件回到工程目录
      expect(
        readFileSync(
          join(freshRoot, 'workspace', 'projects', projectId, 'code', 'src', 'index.ts'),
          'utf8',
        ),
      ).toBe('export const a = 1;');
      // 文档正文也灌回来了，导入后即可检索
      expect(freshDb.prepare(`SELECT content_text FROM document WHERE id = 'd-1'`).get()).toEqual({
        content_text: '# 登录需求',
      });
    } finally {
      freshDb.close();
      rmSync(freshRoot, { recursive: true, force: true });
    }
  });

  it('导入到已有同 id 对象的库：按「不覆盖」处理并回传冲突数', async () => {
    seedProject();
    const exported = await call<{ filePath: string }>('exportProject', {
      input: { projectId, mode: 'full', encrypted: false },
    });
    // 本地已有同 id 记忆与文档 → 必须被计为冲突且保留本地内容
    db.prepare(`UPDATE memory_item SET content = '本地内容' WHERE id = 'm-1'`).run();

    const result = await call<{ counts: { memory: number }; conflicted: number }>('importPackage', {
      input: { filePath: exported.filePath },
    });
    expect(result.counts.memory).toBe(1);
    expect(result.conflicted).toBeGreaterThan(0);
    expect(db.prepare(`SELECT content FROM memory_item WHERE id = 'm-1'`).get()).toEqual({
      content: '本地内容',
    });
  });

  it('归档文件不存在时报 NOT_FOUND', async () => {
    await expect(
      call('importPackage', { input: { filePath: join(root, 'nope.ecpkg') } }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('加密归档：带口令可导出；导入时给错口令如实报错', async () => {
    seedProject();
    const exported = await call<{ filePath: string }>('exportProject', {
      input: { projectId, mode: 'full', encrypted: true, password: 's3cret-pass' },
    });
    expect(existsSync(exported.filePath)).toBe(true);

    await expect(
      call('importPackage', { input: { filePath: exported.filePath, password: '错误口令' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('仅代码包：不含记忆与文档，但代码文件在', async () => {
    seedProject();
    const exported = await call<{ filePath: string; mode: string }>('exportProject', {
      input: { projectId, mode: 'code-only', encrypted: false },
    });
    expect(exported.mode).toBe('code-only');

    const freshRoot = mkdtempSync(join(tmpdir(), 'ec-settings-codeonly-'));
    const freshDb = openBusinessDb({ dataDir: join(freshRoot, 'data') });
    try {
      const freshDomain = createSettingsDomain({
        dataDir: join(freshRoot, 'data'),
        cacheDir: join(freshRoot, 'cache'),
        defaultWorkspaceRoot: join(freshRoot, 'workspace'),
        projectsDir: join(freshRoot, 'workspace', 'projects'),
        db: freshDb,
      });
      const freshRuntime = createDomainRuntime({ routers: { settings: freshDomain.router } });
      const response = await freshRuntime.invoke({
        requestId: 'restore-code-only',
        domain: 'settings',
        method: 'importPackage',
        params: { input: { filePath: exported.filePath } },
      });
      expect(response.ok, JSON.stringify(response.error)).toBe(true);
      const result = response.result as {
        counts: { memory: number; docs: number; codeFiles: number };
      };
      expect(result.counts).toEqual({ memory: 0, docs: 0, codeFiles: 1 });
    } finally {
      freshDb.close();
      rmSync(freshRoot, { recursive: true, force: true });
    }
  });
});
