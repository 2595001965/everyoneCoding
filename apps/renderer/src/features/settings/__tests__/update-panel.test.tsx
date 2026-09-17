import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { UpdatePanel } from '../UpdatePanel';
import { UpdateApiProvider, type UpdateApi, type UpdateViewState } from '../update-api';

function baseState(patch: Partial<UpdateViewState> = {}): UpdateViewState {
  return {
    currentVersion: '0.1.0',
    channel: 'stable',
    autoCheck: true,
    autoDownload: false,
    allowDeferred: true,
    lastCheckAt: null,
    available: null,
    phase: 'idle',
    percent: undefined,
    message: null,
    lastSettled: null,
    ...patch,
  };
}

/** 内存假端口：动作直接改状态并返回，不需要真实网络（与 usage/settings 面板测试同思路）。 */
function createFakeUpdateApi(initial: Partial<UpdateViewState> = {}) {
  let state = baseState(initial);
  const calls: string[] = [];
  const api: UpdateApi = {
    async getState() {
      return state;
    },
    async check() {
      calls.push('check');
      state = { ...state, lastCheckAt: 1_700_000_000_000, phase: 'available', available: { version: '0.2.0', notes: '修了几个问题' } };
      return state;
    },
    async install() {
      calls.push('install');
      state = { ...state, phase: 'done', percent: 100, message: '更新已应用，重启后生效' };
      return state;
    },
    async defer(version) {
      calls.push(`defer:${version}`);
      state = { ...state, available: null, phase: 'idle', message: `${version} 已推迟提醒` };
      return state;
    },
    async saveSettings(patch) {
      calls.push(`save:${JSON.stringify(patch)}`);
      state = { ...state, ...patch };
      return state;
    },
    onProgress() {
      return () => undefined;
    },
  };
  return { api, calls, setState: (next: Partial<UpdateViewState>) => { state = { ...state, ...next }; } };
}

function renderPanel(api: UpdateApi | null) {
  return render(
    <UpdateApiProvider api={api}>
      <UpdatePanel />
    </UpdateApiProvider>,
  );
}

let fake: ReturnType<typeof createFakeUpdateApi>;

beforeEach(() => {
  fake = createFakeUpdateApi();
});

describe('更新面板（T10-04 / FR-SET-05）', () => {
  it('未注入端口时展示装配引导而不是崩溃', () => {
    renderPanel(null);
    expect(screen.getByText(/自动更新尚未连接/)).toBeTruthy();
  });

  it('展示当前版本、渠道与上次检查时间', async () => {
    renderPanel(fake.api);
    expect(await screen.findByText('0.1.0')).toBeTruthy();
    expect(screen.getByText(/stable（仅正式版）/)).toBeTruthy();
    expect(screen.getByText('从未检查')).toBeTruthy();
  });

  it('检查更新后显示新版本与更新说明，并提供立即更新/稍后提醒', async () => {
    renderPanel(fake.api);
    await screen.findByText('当前已是最新版本。');

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(await screen.findByText('新版本 0.2.0')).toBeTruthy();
    expect(screen.getByText('修了几个问题')).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即更新' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '稍后提醒' }));
    await waitFor(() => expect(fake.calls).toContain('defer:0.2.0'));
    expect(await screen.findByText(/已推迟提醒/)).toBeTruthy();
  });

  it('禁用"允许稍后提醒"时不渲染稍后提醒按钮', async () => {
    fake.setState({ allowDeferred: false, available: { version: '0.2.0' }, phase: 'available' });
    renderPanel(fake.api);
    await screen.findByText('新版本 0.2.0');
    expect(screen.queryByRole('button', { name: '稍后提醒' })).toBeNull();
  });

  it('下载阶段渲染进度条（role=progressbar + aria-valuenow）', async () => {
    fake.setState({ phase: 'downloading', percent: 42, message: '开始下载 0.2.0' });
    renderPanel(fake.api);
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText('42%')).toBeTruthy();
  });

  it('安装完成后提示"重启后生效"', async () => {
    renderPanel(fake.api);
    await screen.findByRole('button', { name: '检查更新' });
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    fireEvent.click(await screen.findByRole('button', { name: '立即更新' }));
    expect(await screen.findByText('更新完成')).toBeTruthy();
    expect(screen.getByText('更新已应用，重启后生效')).toBeTruthy();
  });

  it('上次更新回滚成功时显示回滚版本与原因', async () => {
    fake.setState({
      lastSettled: {
        toVersion: '0.2.0',
        fromVersion: '0.1.0',
        stage: 'rolled-back',
        updatedAt: 1_700_000_000_000,
        lastError: null,
      },
    });
    renderPanel(fake.api);
    expect(await screen.findByText(/0.2.0 启动失败，已自动回滚到 0.1.0/)).toBeTruthy();
  });

  it('回滚失败时提示手动重装（不假装成功）', async () => {
    fake.setState({
      lastSettled: {
        toVersion: '0.2.0',
        fromVersion: '0.1.0',
        stage: 'rollback-failed',
        updatedAt: 1_700_000_000_000,
        lastError: '备份目录被占用',
      },
    });
    renderPanel(fake.api);
    expect(await screen.findByText(/自动回滚未成功（备份目录被占用）/)).toBeTruthy();
    expect(screen.getByText(/请重新安装 0.1.0 安装包/)).toBeTruthy();
  });

  it('上一个版本健康落定时显示"已更新到"', async () => {
    fake.setState({
      lastSettled: {
        toVersion: '0.2.0',
        fromVersion: '0.1.0',
        stage: 'healthy',
        updatedAt: 1_700_000_000_000,
        lastError: null,
      },
    });
    renderPanel(fake.api);
    expect(await screen.findByText(/已更新到 0.2.0/)).toBeTruthy();
  });

  it('切换更新偏好写回设置（开关即时生效）', async () => {
    renderPanel(fake.api);
    const autoDownload = await screen.findByRole('switch', { name: '自动下载更新' });
    fireEvent.click(autoDownload);
    await waitFor(() => expect(fake.calls).toContain('save:{"autoDownload":true}'));
    expect(screen.getByRole('switch', { name: '自动下载更新' }).getAttribute('aria-checked')).toBe('true');
  });

  it('检查更新可读地反映离线跳过（不报错）', async () => {
    fake.setState({ message: '当前离线，已跳过更新检查（不影响使用）' });
    renderPanel(fake.api);
    expect(await screen.findByText(/当前离线，已跳过更新检查/)).toBeTruthy();
  });
});
