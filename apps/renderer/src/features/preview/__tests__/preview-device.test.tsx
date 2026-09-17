import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PreviewApiProvider, type DeviceChannel } from '../preview-api';
import { DevicePreview } from '../DevicePreview';
import { createFakePreviewApi } from './fake-preview';

function renderDevice(api: ReturnType<typeof createFakePreviewApi>): void {
  render(
    <PreviewApiProvider api={api}>
      <DevicePreview />
    </PreviewApiProvider>,
  );
}

describe('DevicePreview（T6-06 多端预览）', () => {
  it('按 kind 分组展示通道，可用的展示可用态并带工具链名', async () => {
    const api = createFakePreviewApi();
    renderDevice(api);

    await waitFor(() => expect(screen.getByText('Android 模拟器')).toBeInTheDocument());
    // 三个分组标题
    expect(screen.getByRole('heading', { name: '手机' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '鸿蒙' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '桌面端' })).toBeInTheDocument();
    // 可用通道带工具链
    expect(screen.getByText('可用（adb）')).toBeInTheDocument();
  });

  it('工具链缺失的通道展示安装引导，且不弹报错弹窗', async () => {
    const api = createFakePreviewApi();
    renderDevice(api);

    const guide = await screen.findByText(/未检测到 hdc 工具链/);
    expect(guide).toBeInTheDocument();
    expect(screen.getByText('工具链缺失')).toBeInTheDocument();
    // 引导走 role=status，不是 alert
    expect(guide).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('只有被选中的目标端才展示预览入口，未选中的隐藏', async () => {
    const api = createFakePreviewApi();
    renderDevice(api);

    await waitFor(() => expect(screen.getByText('Android 模拟器')).toBeInTheDocument());
    // mobile 选中 → 有预览入口；desktop 未选中 → 隐藏入口
    expect(screen.getAllByText('生成二维码')).toHaveLength(1);
    expect(screen.getByText('未选择该目标端，预览入口已隐藏')).toBeInTheDocument();
  });

  it('局域网分享默认关闭；取消风险提示后保持关闭且不调用 setLanSharing', async () => {
    const user = userEvent.setup();
    const api = createFakePreviewApi();
    const setLan = vi.spyOn(api, 'setLanSharing');
    renderDevice(api);

    const toggle = await screen.findByRole('switch', { name: '局域网分享' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);

    // 风险提示必须出现，含关键约束文案
    const risk = await screen.findByText(/不生成任何云端链接/);
    expect(risk).toBeInTheDocument();
    expect(screen.getByText(/仅限可信内网/)).toBeInTheDocument();

    // 取消 → 仍关闭，且绝不调用 setLanSharing
    await user.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });
    expect(setLan).not.toHaveBeenCalled();
  });

  it('确认风险后开启局域网分享并调用 setLanSharing(true)', async () => {
    const user = userEvent.setup();
    const api = createFakePreviewApi();
    const setLan = vi.spyOn(api, 'setLanSharing');
    renderDevice(api);

    const toggle = await screen.findByRole('switch', { name: '局域网分享' });
    await user.click(toggle);
    await user.click(await screen.findByRole('button', { name: '我已了解，开启' }));

    await waitFor(() => expect(setLan).toHaveBeenCalledWith(true));
    expect(api.internal.lanEnabled).toBe(true);
  });

  it('生成二维码只给内网 http 地址，界面上不出现任何 https 云链接', async () => {
    const user = userEvent.setup();
    const api = createFakePreviewApi();
    const qrSpy = vi.spyOn(api, 'deviceQr');
    renderDevice(api);

    await user.click(await screen.findByRole('button', { name: '生成二维码' }));

    const qrBox = await screen.findByTestId('device-qr');
    expect(qrSpy).toHaveBeenCalledWith('mobile-1');
    expect(qrBox).toHaveTextContent('http://192.168.1.20:4173');

    // 硬约束 D-09：绝不生成云端链接
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/https:\/\//);
    expect(screen.queryByRole('link', { name: /https:/ })).not.toBeInTheDocument();
  });

  it('无任何通道时按紧凑提示渲染，不崩溃', async () => {
    const api = createFakePreviewApi({ devices: [] as readonly DeviceChannel[] });
    renderDevice(api);

    await waitFor(() => {
      expect(screen.getByRole('region', { name: '多端预览' })).toBeInTheDocument();
    });
    expect(screen.queryByText('生成二维码')).not.toBeInTheDocument();
  });
});
