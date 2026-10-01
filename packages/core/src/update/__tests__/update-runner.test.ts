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
 * 实测口径：这里验证的是**决策与台账语义**，不是真实文件替换——真实下载 / 校验 / 替换由
 * electron-updater（`apps/desktop-electron/src/main/updater/__tests__`，真实 HTTP 更新源）与
 * 两种安装包的本地静态源演练（`e2e/update/`）覆盖。
 */
interface FakeEnv {
  ports: UpdatePorts;
  events: UpdateFlowEvent[];
  saved: UpdateRuntimeState[];
  restored: string[];
  backups: string[];
  /** 让 check 抛出（模拟更新服务不可达） */
  failCheck: boolean;
  /** 让 download 抛出指定消息（模拟网络中断 / 验签失败 / 半包） */
  failDownload: string | null;
  /** 让 installAndRestart 抛出（模拟安装器启动失败） */
  failInstall: boolean;
  /** installAndRestart 被调用那一刻已落盘的台账阶段（验证"先落盘再交给安装器"） */
  stageAtInstall: string | null;
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
    failDownload: null,
    failInstall: false,
    stageAtInstall: null,
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
      if (env.failCheck) throw new Error('UPDATE_NETWORK: connect ECONNREFUSED 127.0.0.1:9');
      return available;
    },
    async download() {
      if (env.failDownload !== null) throw new Error(env.failDownload);
      return available;
    },
    async installAndRestart() {
      env.stageAtInstall = persisted?.ledger.current?.stage ?? null;
      if (env.failInstall) throw new Error('UPDATE_INSTALL: spawn EACCES');
      // 真实外壳在这里结束进程，新版本由安装器拉起
      env.installedVersion = available?.version ?? env.installedVersion;
    },
    async downloadAndInstall() {
      throw new Error('编排层不应再调用 downloadAndInstall');
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

function pendingLedger(stage: 'pending-healthy' | 'rolling-back', bootAttempts: number) {
  return {
    current: {
      toVersion: '0.2.0',
      fromVersion: '0.1.0',
      backupPath: 'D:/bak/0.1.0' as string | null,
      startedAt: 1,
      updatedAt: 1,
      stage,
      bootAttempts,
      lastError: null,
    },
    history: [],
  };
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

  it('手动检查时离线：提示离线而不是报错', async () => {
    const env = createFakeEnv();
    env.ports.isOnline = () => false;
    const info = await createService(env).checkNow(true);
    expect(info).toBeNull();
    expect(env.events).toEqual([{ type: 'check-skipped', reason: 'offline' }]);
  });

  it('检查时网络失败：归类为 network 上报，不抛错、不阻塞启动', async () => {
    const env = createFakeEnv();
    env.failCheck = true;
    const decision = await createService(env).bootstrap();
    expect(decision).toEqual({ decision: 'none' });
    expect(env.events).toEqual([
      expect.objectContaining({ type: 'check-failed', kind: 'network' }),
    ]);
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

  it('开启自动下载时只下载校验，不擅自重启（等用户点"重启并更新"）', async () => {
    const env = createFakeEnv();
    const service = createService(env, { autoDownload: true });
    await service.bootstrap();
    const types = env.events.map((event) => event.type);
    expect(types).toContain('install-started');
    expect(types).toContain('download-ready');
    expect(types).not.toContain('install-applied');
    expect(types).not.toContain('remind');
    expect(service.readyVersion).toBe('0.2.0');
    expect(env.installedVersion).toBe('0.1.0');

    expect(await service.applyAndRestart()).toBe(true);
    expect(env.installedVersion).toBe('0.2.0');
  });
});

describe('更新下载、安装与留档', () => {
  it('安装：下载校验 → 定位留档 → 落盘待确认 → 才交给安装器重启', async () => {
    const env = createFakeEnv();
    const service = createService(env);
    await service.bootstrap();
    env.events.length = 0;

    const applied = await service.install();
    expect(applied).toBe(true);
    expect(env.backups).toEqual(['D:/bak/0.1.0']);
    expect(env.events.map((event) => event.type)).toEqual([
      'install-started',
      'download-ready',
      'install-applied',
    ]);
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
    // 安装器接管（进程退出）之前，"待确认"已经落盘
    expect(env.stageAtInstall).toBe('pending-healthy');
  });

  it.each([
    ['验签失败', 'UPDATE_SIGNATURE: minisign signature verification failed', 'signature'],
    ['半包（sha512 不符）', 'sha512 checksum mismatch, expected abc, got def', 'integrity'],
    [
      '下载中断',
      "Error invoking remote method 'ec:updater:download': Error: UPDATE_NETWORK: socket hang up",
      'network',
    ],
  ] as const)('下载阶段%s：归类上报，台账不动、当前版本不受影响', async (_name, message, kind) => {
    const env = createFakeEnv();
    env.failDownload = message;
    const service = createService(env);
    await service.bootstrap();
    env.events.length = 0;

    expect(await service.install()).toBe(false);
    expect(env.events.at(-1)).toMatchObject({ type: 'install-failed', version: '0.2.0', kind });
    expect(service.currentRecord).toBeNull();
    expect(service.lastSettled).toBeNull();
    expect(service.readyVersion).toBeNull();
    expect(env.installedVersion).toBe('0.1.0');
    expect(env.backups).toEqual([]);
  });

  it('离线时点"立即更新"：提示离线，不发起下载', async () => {
    const env = createFakeEnv();
    env.ports.isOnline = () => false;
    const service = createService(env);
    expect(await service.install()).toBe(false);
    expect(env.events.at(-1)).toMatchObject({ type: 'install-failed', kind: 'offline' });
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

  it('安装器启动失败：台账改记 install-failed，当前版本照常可用', async () => {
    const env = createFakeEnv();
    env.failInstall = true;
    const service = createService(env);
    await service.bootstrap();
    expect(await service.install()).toBe(false);
    expect(env.events.at(-1)).toMatchObject({ type: 'install-failed', kind: 'install' });
    expect(service.currentRecord).toBeNull();
    expect(service.lastSettled?.stage).toBe('install-failed');
  });

  it('找不到留档不阻止更新，但台账如实记 backupPath=null', async () => {
    const env = createFakeEnv();
    env.ports.backupCurrentVersion = async () => {
      throw new Error('留档目录不可读');
    };
    const service = createService(env);
    expect(await service.install()).toBe(true);
    expect(service.currentRecord).toMatchObject({ stage: 'pending-healthy', backupPath: null });
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

  it('重启后仍是旧版本（安装器被取消）：核对为 install-not-applied，不计入崩溃次数', async () => {
    const env = createFakeEnv();
    const first = createService(env);
    await first.bootstrap();
    await first.install();
    env.installedVersion = '0.1.0';

    const second = createService(env);
    expect(await second.bootstrap()).toEqual({ decision: 'none' });
    expect(env.events).toContainEqual(
      expect.objectContaining({ type: 'install-not-applied', version: '0.2.0' }),
    );
    expect(second.lastSettled?.stage).toBe('install-failed');
  });
});

describe('更新失败回滚', () => {
  it('启动连续失败达上限 → 先落盘"回滚中"再还原，下次启动按实际版本确认 rolled-back', async () => {
    const env = createFakeEnv({
      lastCheckAt: 1_700_000_000_000,
      ledger: pendingLedger('pending-healthy', 0),
    });
    env.installedVersion = '0.2.0';
    const service = createService(env);

    // 第一次启动：放行（业务没跑到 markHealthy 就崩了）
    expect(await service.bootstrap()).toEqual({ decision: 'allow', attempts: 1 });

    // 第二次启动：判定回滚
    const decision = await service.bootstrap();
    expect(decision).toMatchObject({ decision: 'rollback', restoreFrom: 'D:/bak/0.1.0' });
    expect(env.restored).toEqual(['D:/bak/0.1.0']);
    expect(env.events.map((event) => event.type)).toContain('rollback-needed');
    expect(service.currentRecord?.stage).toBe('rolling-back');
    expect(env.saved.at(-1)?.ledger.current?.stage).toBe('rolling-back');

    // 安装器结束旧进程并拉起 0.1.0：由这次启动确认回滚落定
    const afterRollback = createService(env);
    expect(await afterRollback.bootstrap()).toEqual({ decision: 'none' });
    expect(env.events).toContainEqual({ type: 'rollback-done', toVersion: '0.1.0' });
    expect(afterRollback.lastSettled).toMatchObject({ stage: 'rolled-back', fromVersion: '0.1.0' });
    expect(afterRollback.currentRecord).toBeNull();
  });

  it('回滚安装包跑完但版本没退回去 → 下次启动如实记 rollback-failed', async () => {
    const env = createFakeEnv({ ledger: pendingLedger('rolling-back', 2) });
    env.installedVersion = '0.2.0';
    const service = createService(env);
    await service.bootstrap();
    expect(service.lastSettled?.stage).toBe('rollback-failed');
    expect(env.events).toContainEqual(
      expect.objectContaining({ type: 'rollback-failed', toVersion: '0.1.0' }),
    );
  });

  it('回滚本身失败 → rollback-failed（UI 需提示人工重装）', async () => {
    const env = createFakeEnv({ ledger: pendingLedger('pending-healthy', 1) });
    env.installedVersion = '0.2.0';
    env.failRestore = true;
    const service = createService(env);
    await service.bootstrap();
    expect(env.events.at(-1)).toMatchObject({ type: 'rollback-failed', error: '备份目录被占用' });
    expect(service.lastSettled?.stage).toBe('rollback-failed');
  });

  it('没有备份时返回 no-backup 并上报"无法自动回滚"，不假装成功', async () => {
    const ledger = pendingLedger('pending-healthy', 1);
    ledger.current.backupPath = null;
    const env = createFakeEnv({ ledger });
    env.installedVersion = '0.2.0';
    const service = createService(env);
    const decision = await service.bootstrap();
    expect(decision).toMatchObject({ decision: 'no-backup', toVersion: '0.2.0' });
    expect(env.events).toEqual([{ type: 'rollback-unavailable', toVersion: '0.2.0' }]);
    expect(env.restored).toEqual([]);
  });

  it('回滚期间不自动检查更新（先恢复到可用状态）', async () => {
    const env = createFakeEnv({ ledger: pendingLedger('pending-healthy', 1) });
    env.installedVersion = '0.2.0';
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
