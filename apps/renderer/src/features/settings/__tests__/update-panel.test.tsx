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
    detail: null,
    offline: false,
    readyVersion: null,
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
      state = {
        ...state,
        lastCheckAt: 1_700_000_000_000,
        phase: 'available',
        available: { version: '0.2.0', notes: '修了几个问题' },
      };
      return state;
    },
    async install() {
      calls.push('install');
      state = { ...state, phase: 'installing', percent: 100, message: '正在重启并安装更新…' };
      return state;
    },
    async restart() {
      calls.push('restart');
      state = { ...state, phase: 'installing', percent: 100, message: '正在重启并安装更新…' };
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
  return {
    api,
    calls,
    setState: (next: Partial<UpdateViewState>) => {
      state = { ...state, ...next };
    },
  };
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

  it('立即更新后进入"正在重启并安装"，期间不能重复点检查', async () => {
    renderPanel(fake.api);
    await screen.findByRole('button', { name: '检查更新' });
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    fireEvent.click(await screen.findByRole('button', { name: '立即更新' }));
    expect(await screen.findByText('正在重启并安装…')).toBeTruthy();
    expect(screen.getByText('正在重启并安装更新…')).toBeTruthy();
    expect(screen.getByRole('button', { name: '检查更新' }).hasAttribute('disabled')).toBe(true);
  });

  it('自动下载完成（ready）时提供"重启并更新"，点击后才重启', async () => {
    fake.setState({
      phase: 'ready',
      available: { version: '0.2.0' },
      readyVersion: '0.2.0',
      message: '0.2.0 已下载并通过校验，重启后生效',
    });
    renderPanel(fake.api);
    expect(await screen.findByText('已下载，待重启')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '立即更新' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重启并更新' }));
    await waitFor(() => expect(fake.calls).toContain('restart'));
  });

  it('离线时提示且禁用检查与下载（不是报错）', async () => {
    fake.setState({ offline: true, available: { version: '0.2.0' }, phase: 'available' });
    renderPanel(fake.api);
    expect(await screen.findByText(/当前处于离线状态/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '检查更新' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '立即更新' }).hasAttribute('disabled')).toBe(true);
  });

  it('验签失败等错误展示归类后的原因与可展开的原始详情', async () => {
    fake.setState({
      phase: 'error',
      message: '更新失败：更新包签名校验失败，已拒绝安装（可能被篡改或发布配置有误）',
      detail: 'UPDATE_SIGNATURE: signature verification failed',
    });
    renderPanel(fake.api);
    expect(await screen.findByText(/更新包签名校验失败/)).toBeTruthy();
    expect(screen.getByText('失败详情')).toBeTruthy();
    expect(screen.getByText('UPDATE_SIGNATURE: signature verification failed')).toBeTruthy();
  });

  it('上次更新未安装成功时如实说明仍在旧版本', async () => {
    fake.setState({
      lastSettled: {
        toVersion: '0.2.0',
        fromVersion: '0.1.0',
        stage: 'install-failed',
        updatedAt: 1_700_000_000_000,
        lastError: '重启后仍是 0.1.0',
      },
    });
    renderPanel(fake.api);
    expect(await screen.findByText(/更新到 0.2.0 未完成，仍在使用 0.1.0/)).toBeTruthy();
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
    expect(screen.getByRole('switch', { name: '自动下载更新' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('检查更新可读地反映离线跳过（不报错）', async () => {
    fake.setState({ message: '当前离线，已跳过更新检查（不影响使用）' });
    renderPanel(fake.api);
    expect(await screen.findByText(/当前离线，已跳过更新检查/)).toBeTruthy();
  });
});
