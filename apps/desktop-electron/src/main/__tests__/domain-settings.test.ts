import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_COMMANDS } from '@ec/core';
import type { DomainControlServiceHost } from '@ec/shell-api';

import { createDomainRuntime } from '../domain/runtime';
import { createSettingsDomain, type SettingsDomain } from '../domain/settings';

/**
 * settings 域运行时测试（真实临时目录，不做假 IO）。
 *
 * 重点：
 * - `update` / `saveKeymap` / `saveBackupConfig` 必须真的落盘（重启后仍在）；
 * - 数据目录迁移必须**按条目数校验**，不一致时如实报失败并清掉复制产物；
 * - 未实现的方法必须抛带原因的 NOT_SUPPORTED（不做静默降级）。
 *
 * 调用一律经 `createDomainRuntime`：错误码映射与脱敏发生在那一层，
 * 直接调 router 会拿到未映射的原始异常，测出来的结论不代表真实链路。
 */

let root: string;
let domain: SettingsDomain;
let runtime: DomainControlServiceHost;

function makeDomain(): SettingsDomain {
  return createSettingsDomain({
    dataDir: join(root, 'data'),
    cacheDir: join(root, 'cache'),
    defaultWorkspaceRoot: join(root, 'workspace'),
  });
}

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
  domain = makeDomain();
  runtime = createDomainRuntime({ routers: { settings: domain.router } });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('设置读写与落盘', () => {
  it('getAll 返回带默认值的全局设置', async () => {
    const settings = await call<{ language: string; theme: string; keymap: Record<string, string> }>('getAll');
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
    const restored = (await reopened.router('getAll', {})) as { theme: string };
    expect(restored.theme).toBe('dark');
  });

  it('update 的非法值被 zod 拒绝且不写盘', async () => {
    await expect(call('update', { patch: { theme: 'neon' } })).rejects.toMatchObject({ code: 'UNKNOWN' });
    const file = join(root, 'data', 'settings.json');
    expect(existsSync(file)).toBe(false);
  });

  it('update 缺 patch 时报 INVALID_ARGUMENT', async () => {
    await expect(call('update', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('数据目录', () => {
  it('getDataDirs 返回四个真实值且 sqlitePath 落在 dataDir 下', async () => {
    const dirs = await call<{ workspaceRoot: string; projectsDir: string; sqlitePath: string; cacheDir: string }>(
      'getDataDirs',
    );
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
    const result = await call<{ ok: boolean; counts: { before: number; after: number }; backupDir?: string }>(
      'migrateDataDirs',
      { next: { workspaceRoot: join(root, 'moved'), projectsDir: target } },
    );

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

    const result = await call<{ ok: boolean; error?: string; rolledBack?: boolean }>('migrateDataDirs', {
      next: { workspaceRoot: join(root, 'moved'), projectsDir: target },
    });

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
    await call('migrateDataDirs', { next: { workspaceRoot: join(root, 'moved'), projectsDir: target } });

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
    const commands = await call<Array<{ id: string; title: string; defaultKey: string | null }>>('listCommands');
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

    await expect(call('importKeymap', { json: '{坏' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(call('importKeymap', { json: '[]' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
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
    writeFileSync(join(root, 'data', 'telemetry-buffer.json'), JSON.stringify([{ seq: 1, recordedAt: 1, name: 'x' }]));
    await call('setTelemetry', { enabled: false });
    const inspection = await call<{ telemetryRecords: number }>('inspectLocalTelemetry');
    expect(inspection.telemetryRecords).toBe(0);
  });

  it('clearLocalTelemetry 清空缓冲与缓存目录并回传全 0', async () => {
    writeFileSync(join(root, 'data', 'telemetry-buffer.json'), JSON.stringify([{ seq: 1, recordedAt: 1, name: 'x' }]));
    mkdirSync(join(root, 'cache', 'sub'), { recursive: true });
    writeFileSync(join(root, 'cache', 'sub', 'blob.bin'), 'x'.repeat(64));

    const inspected = await call<{ telemetryRecords: number; cacheBytes: number }>('inspectLocalTelemetry');
    expect(inspected.telemetryRecords).toBe(1);
    expect(inspected.cacheBytes).toBe(64);

    const cleared = await call<{ telemetryRecords: number; cacheBytes: number }>('clearLocalTelemetry');
    expect(cleared).toEqual({ telemetryRecords: 0, cacheBytes: 0 });
    expect(existsSync(join(root, 'cache'))).toBe(true);
  });

  it('setTelemetry 缺 enabled 时报 INVALID_ARGUMENT', async () => {
    await expect(call('setTelemetry', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('定时备份配置', () => {
  it('默认值可用；保存后落盘并可回读', async () => {
    const initial = await call<{ intervalHours: number; dir: string; lastRunAt: number | null }>('getBackupConfig');
    expect(initial.intervalHours).toBe(24);
    expect(initial.lastRunAt).toBeNull();

    await call('saveBackupConfig', { config: { intervalHours: 6, dir: join(root, 'bak') } });
    const saved = await call<{ intervalHours: number; dir: string }>('getBackupConfig');
    expect(saved.intervalHours).toBe(6);
    expect(saved.dir).toBe(join(root, 'bak'));

    const reopened = makeDomain();
    const restored = (await reopened.router('getBackupConfig', {})) as { intervalHours: number };
    expect(restored.intervalHours).toBe(6);
  });

  it('非法间隔被拒（0 / 负数 / 非数字）', async () => {
    for (const intervalHours of [0, -3, 'abc']) {
      await expect(call('saveBackupConfig', { config: { intervalHours, dir: 'D:/x' } })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    }
  });
});

describe('暂未实现的方法如实报错', () => {
  it('exportProject 抛 NOT_SUPPORTED 并说明原因与归口', async () => {
    const input = { projectId: 'p1', mode: 'full', encrypted: false };
    await expect(call('exportProject', { input })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
    await expect(call('exportProject', { input })).rejects.toThrowError(/ExportSourcePort/);
  });

  it('importPackage 抛 NOT_SUPPORTED 并说明原因与归口', async () => {
    await expect(call('importPackage', { input: { filePath: 'D:/x.ecpkg' } })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
    await expect(call('importPackage', { input: { filePath: 'D:/x.ecpkg' } })).rejects.toThrowError(
      /workspace 与 docs 域的写路径/,
    );
  });
});
