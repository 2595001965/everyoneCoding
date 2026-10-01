import { describe, expect, it } from 'vitest';
import type { UpdateInfo, UpdateProgress } from '@ec/shell-api';
import {
  UpdateService,
  type UpdateFlowEvent,
  type UpdatePorts,
  type UpdateRuntimeState,
} from '@ec/core';

import { createUpdateApi } from '../update-service-host';
import type { UpdateProgressEvent } from '../update-api';

/**
 * 适配器测试：**真实 `UpdateService` + 内存假端口**（与 Wave 7 重命名同一思路）。
 * 断言的是"点一个按钮，服务真的走了对应分支、状态真的变成 X"，而不是渲染文本。
 */
function createEnv(
  options: {
    available?: UpdateInfo | null;
    failDownload?: string;
    failCheck?: string;
    online?: boolean;
  } = {},
) {
  let now = 1_700_000_000_000;
  let persisted: UpdateRuntimeState | null = {
    lastCheckAt: null,
    reminder: { deferredVersion: null, deferredUntil: null, snoozeCount: 0 },
    ledger: { current: null, history: [] },
  };
  const events: UpdateFlowEvent[] = [];
  let installed = '0.1.0';
  const available =
    options.available === undefined
      ? { version: '0.2.0', notes: '修了几个问题' }
      : options.available;

  const progressListeners = new Set<(progress: UpdateProgress) => void>();
  const ports: UpdatePorts = {
    updater: {
      async check() {
        if (options.failCheck !== undefined) throw new Error(options.failCheck);
        return available;
      },
      async download() {
        if (options.failDownload !== undefined) throw new Error(options.failDownload);
        for (const listener of progressListeners) {
          listener({
            phase: 'downloading',
            percent: 37,
            message: '差分下载：仅需 1.2 MB（共 80 MB）',
          });
        }
        return available;
      },
      async installAndRestart() {
        installed = available?.version ?? installed;
      },
      async downloadAndInstall() {
        throw new Error('不应被调用');
      },
      onProgress(listener: (progress: UpdateProgress) => void) {
        progressListeners.add(listener);
        return () => progressListeners.delete(listener);
      },
    },
    now: () => now,
    isOnline: () => options.online ?? true,
    async backupCurrentVersion(fromVersion) {
      return `D:/bak/${fromVersion}`;
    },
    async restoreBackup() {
      installed = '0.1.0';
    },
    async loadRuntime() {
      return persisted;
    },
    async saveRuntime(state) {
      persisted = JSON.parse(JSON.stringify(state)) as UpdateRuntimeState;
    },
    async currentVersion() {
      return installed;
    },
  };

  const service = new UpdateService({ ports });
  service.subscribeEvents((event) => events.push(event));
  const savedPatches: unknown[] = [];
  const api = createUpdateApi({
    service,
    currentVersion: '0.1.0',
    isOnline: () => options.online ?? true,
    persistSettings: async (patch) => {
      savedPatches.push(patch);
    },
  });
  return {
    api,
    service,
    events,
    savedPatches,
    advance: (ms: number) => {
      now += ms;
    },
    installedVersion: () => installed,
  };
}

describe('更新端口适配器（真实服务 + 内存端口）', () => {
  it('初始状态反映当前版本与默认偏好', async () => {
    const env = createEnv();
    const state = await env.api.getState();
    expect(state.currentVersion).toBe('0.1.0');
    expect(state.channel).toBe('stable');
    expect(state.autoCheck).toBe(true);
    expect(state.available).toBeNull();
    expect(state.phase).toBe('idle');
    expect(state.lastCheckAt).toBeNull();
  });

  it('手动检查后状态变为 available，并带出更新说明', async () => {
    const env = createEnv();
    const state = await env.api.check();
    expect(state.phase).toBe('available');
    expect(state.available).toEqual({ version: '0.2.0', notes: '修了几个问题' });
    expect(state.lastCheckAt).not.toBeNull();
    expect(state.message).toContain('0.2.0');
  });

  it('没有新版本时 available 为 null（不误报）', async () => {
    const env = createEnv({ available: null });
    const state = await env.api.check();
    expect(state.available).toBeNull();
    expect(state.phase).toBe('idle');
  });

  it('比当前旧的版本不会显示为可更新', async () => {
    const env = createEnv({ available: { version: '0.0.9' } });
    const state = await env.api.check();
    expect(state.available).toBeNull();
  });

  it('立即更新：进入"正在重启并安装"，服务已落盘备份路径，安装器接管', async () => {
    const env = createEnv();
    await env.api.check();
    const state = await env.api.install();
    expect(state.phase).toBe('installing');
    expect(state.percent).toBe(100);
    expect(state.message).toContain('正在重启并安装');
    expect(env.service.currentRecord?.backupPath).toBe('D:/bak/0.1.0');
    expect(env.installedVersion()).toBe('0.2.0');
  });

  it('下载进度（含差分下载说明）实时推给面板', async () => {
    const env = createEnv();
    const seen: UpdateProgressEvent[] = [];
    env.api.onProgress((progress) => seen.push(progress));
    await env.api.check();
    await env.api.install();
    expect(seen).toContainEqual({
      phase: 'downloading',
      percent: 37,
      message: '差分下载：仅需 1.2 MB（共 80 MB）',
    });
  });

  it.each([
    ['验签失败', 'UPDATE_SIGNATURE: minisign signature verification failed', /签名校验失败/],
    ['半包', 'UPDATE_INTEGRITY: sha512 checksum mismatch', /校验不一致/],
    ['网络中断', 'UPDATE_NETWORK: socket hang up', /无法连接更新服务或下载中断/],
  ])('下载阶段%s：阶段为 error，文案归类、原始原因进详情', async (_name, error, pattern) => {
    const env = createEnv({ failDownload: error });
    await env.api.check();
    const state = await env.api.install();
    expect(state.phase).toBe('error');
    expect(state.message).toMatch(pattern);
    expect(state.detail).toBe(error);
    expect(env.installedVersion()).toBe('0.1.0');
  });

  it('检查时更新源不可达：面板报"检查更新失败"而不是卡在"正在检查"', async () => {
    const env = createEnv({ failCheck: 'connect ECONNREFUSED 127.0.0.1:18080' });
    const state = await env.api.check();
    expect(state.phase).toBe('error');
    expect(state.message).toMatch(/检查更新失败：无法连接更新服务/);
  });

  it('离线：状态带 offline=true，手动检查只提示离线', async () => {
    const env = createEnv({ online: false });
    const state = await env.api.check();
    expect(state.offline).toBe(true);
    expect(state.phase).toBe('idle');
    expect(state.message).toContain('当前离线');
  });

  it('自动下载完成后为 ready，点"重启并更新"才交给安装器', async () => {
    const env = createEnv();
    await env.api.saveSettings({ autoDownload: true });
    await env.service.checkNow(true);
    let state = await env.api.getState();
    expect(state.phase).toBe('ready');
    expect(state.readyVersion).toBe('0.2.0');
    expect(env.installedVersion()).toBe('0.1.0');
    state = await env.api.restart();
    expect(state.phase).toBe('installing');
    expect(env.installedVersion()).toBe('0.2.0');
  });

  it('安装后再次装配（模拟重启）→ 健康落定 → lastSettled 显示已更新到新版本', async () => {
    const env = createEnv();
    await env.api.check();
    await env.api.install();
    await env.service.markHealthy();
    const state = await env.api.getState();
    expect(state.lastSettled).toMatchObject({ toVersion: '0.2.0', stage: 'healthy' });
  });

  it('稍后提醒后不再重复提示（自动检查走 defer 分支），但手动仍可更新', async () => {
    const env = createEnv();
    await env.api.check();
    const state = await env.api.defer('0.2.0');
    expect(state.message).toContain('0.2.0');
    expect(env.events.some((event) => event.type === 'defer')).toBe(true);
    // 可用版本信息保留：用户主动打开设置页仍能一键更新
    expect(state.available).toEqual({ version: '0.2.0', notes: '修了几个问题' });

    env.events.length = 0;
    env.advance(2000);
    // 手动检查同样走 decideAction：仍在推迟窗口内 → defer，不打扰
    await env.service.checkNow(true);
    expect(env.events.some((event) => event.type === 'remind')).toBe(false);
    expect(env.events.some((event) => event.type === 'defer')).toBe(true);
  });

  it('保存偏好同时更新服务设置与外壳持久化', async () => {
    const env = createEnv();
    const state = await env.api.saveSettings({ autoDownload: true, channel: 'beta' });
    expect(state.autoDownload).toBe(true);
    expect(state.channel).toBe('beta');
    expect(env.savedPatches).toEqual([{ autoDownload: true, channel: 'beta' }]);
    expect(env.service.getSettings()).toMatchObject({ autoDownload: true, channel: 'beta' });
  });

  it('进度订阅会收到阶段事件（含下载百分比）', async () => {
    const env = createEnv();
    const seen: UpdateProgressEvent[] = [];
    const unsubscribe = env.api.onProgress((progress) => seen.push(progress));
    await env.api.check();
    expect(seen.at(-1)?.phase).toBe('available');
    await env.api.install();
    expect(seen.some((progress) => progress.phase === 'installing')).toBe(true);
    unsubscribe();
    const before = seen.length;
    await env.api.defer('0.2.0');
    expect(seen).toHaveLength(before);
  });
});
