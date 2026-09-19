import { describe, expect, it } from 'vitest';
import type { UpdateInfo, UpdateProgress } from '@ec/shell-api';

import { DEFAULT_UPDATE_SETTINGS, type UpdateSettings } from '../update-policy';
import {
  INITIAL_UPDATE_RUNTIME,
  UpdateService,
  type UpdateFlowEvent,
  type UpdatePorts,
  type UpdateRuntimeState,
} from '../update-runner';

/**
 * 本地 mock 更新服务 + 内存假端口（无真实安装包也能跑通整条更新链路）。
 *
 * 实测口径：这里验证的是**决策与台账语义**，不是真实文件替换——真实替换由
 * Tauri NSIS / electron-updater 完成（本机无 Rust 工具链，包体与实机更新见
 * docs/PERF-REPORT.md §3 与 docs/RELEASE.md 的待验清单）。
 */
interface FakeEnv {
  ports: UpdatePorts;
  events: UpdateFlowEvent[];
  saved: UpdateRuntimeState[];
  restored: string[];
  backups: string[];
  /** 让 check 抛出（模拟更新服务不可达） */
  failCheck: boolean;
  /** 让 downloadAndInstall 抛出（模拟下载中断） */
  failDownload: boolean;
  /** 让 restoreBackup 抛出（模拟备份目录被占用） */
  failRestore: boolean;
  /** 目前"已安装"的版本 */
  installedVersion: string;
  advance(ms: number): void;
  setAvailable(info: UpdateInfo | null): void;
}

/**
 * 注意：返回值必须是**同一个对象**（不能 `{...env}` 再改字段）——
 * ports 里的闭包捕获的是这个对象，复制出去后改副本，闭包仍读旧值。
 */
function createFakeEnv(seed?: Partial<UpdateRuntimeState>): FakeEnv {
  let now = 1_700_000_000_000;
  let available: UpdateInfo | null = { version: '0.2.0', notes: '修了几个问题' };
  let persisted: UpdateRuntimeState | null = { ...INITIAL_UPDATE_RUNTIME, ...(seed ?? {}) };

  const env: FakeEnv = {
    events: [],
    saved: [],
    restored: [],
    backups: [],
    failCheck: false,
    failDownload: false,
    failRestore: false,
    installedVersion: '0.1.0',
    advance(ms) {
      now += ms;
    },
    setAvailable(info) {
      available = info;
    },
    ports: {
      updater: null,
      now: () => now,
      isOnline: () => true,
      async backupCurrentVersion(fromVersion) {
        const path = `D:/bak/${fromVersion}`;
        env.backups.push(path);
        return path;
      },
      async restoreBackup(path) {
        if (env.failRestore) throw new Error('备份目录被占用');
        env.restored.push(path);
        // 还原 = 回到备份时的版本
        env.installedVersion = path.split('/').at(-1) ?? env.installedVersion;
      },
      async loadRuntime() {
        return persisted;
      },
      async saveRuntime(state) {
        persisted = JSON.parse(JSON.stringify(state)) as UpdateRuntimeState;
        env.saved.push(persisted);
      },
      async currentVersion() {
        return env.installedVersion;
      },
    },
  };

  env.ports.updater = {
    async check() {
      if (env.failCheck) throw new Error('更新服务不可达');
      return available;
    },
    async downloadAndInstall() {
      if (env.failDownload) throw new Error('下载中断');
      env.installedVersion = available?.version ?? env.installedVersion;
    },
    onProgress(_listener: (progress: UpdateProgress) => void) {
      return () => undefined;
    },
  };

  return env;
}

function createService(
  env: FakeEnv,
  patch: Partial<UpdateSettings> = {},
  maxBootAttempts?: number,
) {
  return new UpdateService({
    ports: env.ports,
    settings: { ...DEFAULT_UPDATE_SETTINGS, ...patch },
    ...(maxBootAttempts === undefined ? {} : { maxBootAttempts }),
    onEvent: (event) => env.events.push(event),
  });
}

describe('更新编排：检查 → 提示 → 安装（T10-04 / FR-SET-05）', () => {
  it('首次启动静默检查并提示新版本', async () => {
    const env = createFakeEnv();
    await createService(env).bootstrap();
    expect(env.events.map((event) => event.type)).toEqual(['check-done', 'remind']);
    expect(env.saved.at(-1)?.lastCheckAt).not.toBeNull();
  });

  it('离线时静默跳过检查，不抛错（启动不被网络阻塞）', async () => {
    const env = createFakeEnv();
    env.ports.isOnline = () => false;
    await createService(env).bootstrap();
    expect(env.events).toEqual([{ type: 'check-skipped', reason: 'offline' }]);
  });

  it('已是最新版本时只上报 check-done，不提示', async () => {
    const env = createFakeEnv();
    env.setAvailable(null);
    await createService(env).bootstrap();
    expect(env.events.map((event) => event.type)).toEqual(['check-done']);
  });

  it('稍后提醒后同一次会话不再打扰，冷却过期后重新提示', async () => {
    const env = createFakeEnv();
    const service = createService(env);
    await service.bootstrap();
    await service.deferVersion('0.2.0');
    env.events.length = 0;

    // 让检查间隔到期（但仍在推迟窗口内）→ 应报 defer 而不是 remind
    service.setSettings({ ...DEFAULT_UPDATE_SETTINGS, checkIntervalMs: 1000 });
    env.advance(2000);
    await service.checkNow(false);
    expect(env.events.at(-1)).toMatchObject({ type: 'defer', version: '0.2.0' });

    // 推迟窗口（24h）过期 → 重新提示
    env.advance(24 * 60 * 60 * 1000);
    env.events.length = 0;
    await service.checkNow(false);
    expect(env.events.at(-1)).toMatchObject({ type: 'remind', version: '0.2.0' });
  });

  it('开启自动下载时直接进入安装流程', async () => {
    const env = createFakeEnv();
    const service = createService(env, { autoDownload: true });
    await service.bootstrap();
    const types = env.events.map((event) => event.type);
    expect(types).toContain('install-started');
    expect(types).toContain('install-applied');
    expect(types).not.toContain('remind');
  });
});

describe('更新安装与备份', () => {
  it('安装会先备份当前版本，再下载安装，最后登记待确认', async () => {
    const env = createFakeEnv();
    const service = createService(env);
    await service.bootstrap();
    env.events.length = 0;

    const applied = await service.install();
    expect(applied).toBe(true);
    expect(env.backups).toEqual(['D:/bak/0.1.0']);
    expect(env.events.at(-1)).toEqual({
      type: 'install-applied',
      version: '0.2.0',
      backupPath: 'D:/bak/0.1.0',
    });
    expect(service.currentRecord).toMatchObject({
      toVersion: '0.2.0',
      fromVersion: '0.1.0',
      stage: 'pending-healthy',
      backupPath: 'D:/bak/0.1.0',
    });
    expect(env.installedVersion).toBe('0.2.0');
  });

  it('备份失败 / 下载失败时如实上报，并把台账置为 rollback-failed（不再无限重启）', async () => {
    const env = createFakeEnv();
    env.failDownload = true;
    const service = createService(env);
    await service.bootstrap();
    env.events.length = 0;

    expect(await service.install()).toBe(false);
    expect(env.events.at(-1)).toMatchObject({ type: 'install-failed', version: '0.2.0' });
    expect(service.lastSettled?.stage).toBe('rollback-failed');
    expect(service.currentRecord).toBeNull();
  });

  it('外壳不支持更新时明确报错，不假装成功', async () => {
    const env = createFakeEnv();
    env.ports.updater = null;
    const service = createService(env);
    expect(await service.install()).toBe(false);
    expect(env.events.at(-1)).toMatchObject({
      type: 'install-failed',
      error: '当前外壳不支持自动更新',
    });
  });

  it('安装后下次启动放行 + markHealthy 落定，之后启动不再计数', async () => {
    const env = createFakeEnv();
    const first = createService(env);
    await first.bootstrap();
    await first.install();

    // 模拟重启：用落盘的 runtime 新建 service
    const second = createService(env);
    const decision = await second.bootstrap();
    expect(decision).toEqual({ decision: 'allow', attempts: 1 });
    await second.markHealthy();
    expect(env.events.some((event) => event.type === 'health-marked')).toBe(true);

    const third = createService(env);
    expect(await third.bootstrap()).toEqual({ decision: 'none' });
  });
});

describe('更新失败回滚', () => {
  it('启动连续失败达上限 → 还原备份并记录 rolled-back', async () => {
    const env = createFakeEnv({
      lastCheckAt: 1_700_000_000_000,
      ledger: {
        current: {
          toVersion: '0.2.0',
          fromVersion: '0.1.0',
          backupPath: 'D:/bak/0.1.0',
          startedAt: 1,
          updatedAt: 1,
          stage: 'pending-healthy',
          bootAttempts: 0,
          lastError: null,
        },
        history: [],
      },
    });
    env.installedVersion = '0.2.0';
    const service = createService(env);

    // 第一次启动：放行（业务没跑到 markHealthy 就崩了）
    expect(await service.bootstrap()).toEqual({ decision: 'allow', attempts: 1 });

    // 第二次启动：判定回滚
    const decision = await service.bootstrap();
    expect(decision).toMatchObject({ decision: 'rollback', restoreFrom: 'D:/bak/0.1.0' });
    expect(env.restored).toEqual(['D:/bak/0.1.0']);
    expect(env.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['rollback-needed', 'rollback-done']),
    );
    expect(service.lastSettled?.stage).toBe('rolled-back');
    expect(env.installedVersion).toBe('0.1.0');
  });

  it('回滚本身失败 → rollback-failed（UI 需提示人工重装）', async () => {
    const env = createFakeEnv({
      ledger: {
        current: {
          toVersion: '0.2.0',
          fromVersion: '0.1.0',
          backupPath: 'D:/bak/0.1.0',
          startedAt: 1,
          updatedAt: 1,
          stage: 'pending-healthy',
          bootAttempts: 1,
          lastError: null,
        },
        history: [],
      },
    });
    env.failRestore = true;
    const service = createService(env);
    await service.bootstrap();
    expect(env.events.at(-1)).toMatchObject({ type: 'rollback-failed', error: '备份目录被占用' });
    expect(service.lastSettled?.stage).toBe('rollback-failed');
  });

  it('没有备份时返回 no-backup 并上报"无法自动回滚"，不假装成功', async () => {
    const env = createFakeEnv({
      ledger: {
        current: {
          toVersion: '0.2.0',
          fromVersion: '0.1.0',
          backupPath: null,
          startedAt: 1,
          updatedAt: 1,
          stage: 'pending-healthy',
          bootAttempts: 1,
          lastError: null,
        },
        history: [],
      },
    });
    const service = createService(env);
    const decision = await service.bootstrap();
    expect(decision).toMatchObject({ decision: 'no-backup', toVersion: '0.2.0' });
    expect(env.events).toEqual([{ type: 'rollback-unavailable', toVersion: '0.2.0' }]);
    expect(env.restored).toEqual([]);
  });

  it('回滚期间不自动检查更新（先恢复到可用状态）', async () => {
    const env = createFakeEnv({
      ledger: {
        current: {
          toVersion: '0.2.0',
          fromVersion: '0.1.0',
          backupPath: 'D:/bak/0.1.0',
          startedAt: 1,
          updatedAt: 1,
          stage: 'pending-healthy',
          bootAttempts: 1,
          lastError: null,
        },
        history: [],
      },
    });
    await createService(env).bootstrap();
    expect(env.events.some((event) => event.type === 'check-done')).toBe(false);
    expect(env.saved.at(-1)?.lastCheckAt).toBeNull();
  });

  it('落盘的坏数据不影响启动（台账降级为空）', async () => {
    const env = createFakeEnv();
    env.ports.loadRuntime = async () => '坏数据' as unknown as UpdateRuntimeState;
    const decision = await createService(env).bootstrap();
    expect(decision).toEqual({ decision: 'none' });
    expect(env.events.map((event) => event.type)).toEqual(['check-done', 'remind']);
  });
});
