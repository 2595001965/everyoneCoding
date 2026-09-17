import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PreviewApiProvider, type DeviceChannel } from '../preview-api';
import { PreviewToolbar } from '../PreviewToolbar';
import { PreviewFrame } from '../PreviewFrame';
import type { ApiRequestLog } from '../preview-api';
import { createFakePreviewApi } from './fake-preview';

describe('PreviewToolbar（T6-05）', () => {
  it('三种模式一键切换，并展示地址、状态与数据来源标记', async () => {
    const user = userEvent.setup();
    const api = createFakePreviewApi();
    render(
      <PreviewApiProvider api={api}>
        <PreviewToolbar />
      </PreviewApiProvider>,
    );

    // 切到「联动预览」触发启动（假端口在该模式模拟端口占用顺延 → 4174）
    await user.click(await screen.findByRole('button', { name: /联动预览/ }));
    await waitFor(() => {
      expect(screen.getByText('服务运行中')).toBeInTheDocument();
    });
    expect(screen.getByText(/^数据来源：Mock$/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'http://localhost:4174' })).toHaveAttribute(
      'href',
      'http://localhost:4174',
    );
  });

  it('端口顺延时展示 notice', async () => {
    const user = userEvent.setup();
    const api = createFakePreviewApi();
    render(
      <PreviewApiProvider api={api}>
        <PreviewToolbar />
      </PreviewApiProvider>,
    );

    await user.click(await screen.findByRole('button', { name: /联动预览/ }));
    await waitFor(() => {
      expect(screen.getByText('端口 4173 被占用，已顺延到 4174')).toBeInTheDocument();
    });
  });

  it('刷新按钮调用 refresh 并显示耗时（毫秒数）', async () => {
    const user = userEvent.setup();
    const api = createFakePreviewApi();
    render(
      <PreviewApiProvider api={api}>
        <PreviewToolbar />
      </PreviewApiProvider>,
    );

    await user.click(await screen.findByRole('button', { name: /静态预览/ }));
    await waitFor(() => expect(screen.getByText('服务运行中')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      const el = screen.getByTestId('refresh-elapsed');
      expect(el.textContent).toMatch(/刷新耗时\s*\d+ms/);
    });
  });

  it('设备模式且未选择目标端时刷新按钮禁用', async () => {
    const user = userEvent.setup();
    const noSelected: readonly DeviceChannel[] = [
      { id: 'mobile-1', kind: 'mobile', label: 'Android', available: true, toolchain: 'adb', guide: null, selected: false },
      { id: 'harmony-1', kind: 'harmony', label: '鸿蒙', available: false, toolchain: null, guide: '安装 hdc', selected: false },
    ];
    const api = createFakePreviewApi({ devices: noSelected });
    render(
      <PreviewApiProvider api={api}>
        <PreviewToolbar />
      </PreviewApiProvider>,
    );

    await user.click(await screen.findByRole('button', { name: /设备预览/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled();
    });
  });
});

describe('PreviewFrame（T6-05）', () => {
  it('iframe 受限 sandbox 嵌入页面路由', () => {
    render(<PreviewFrame src="http://localhost:4173/login" />);
    const frame = screen.getByTestId('preview-frame');
    expect(frame).toHaveAttribute('src', 'http://localhost:4173/login');
    expect(frame).toHaveAttribute('sandbox');
  });

  it('接收 preview-request 消息触发 onRequest', async () => {
    const onRequest = vi.fn();
    const onElementClick = vi.fn();
    render(<PreviewFrame src="http://localhost:4173/login" onRequest={onRequest} onElementClick={onElementClick} />);

    const payload: ApiRequestLog = {
      id: 'r1',
      at: 1,
      method: 'GET',
      url: '/health',
      status: 200,
      durationMs: 5,
      source: 'mock',
      requestBody: null,
      responseBody: '{}',
      errorMessage: null,
    };
    window.postMessage({ type: 'preview-request', payload }, '*');
    await waitFor(() => expect(onRequest).toHaveBeenCalledWith(payload));
  });

  it('接收 element-click 消息触发 onElementClick', async () => {
    const onRequest = vi.fn();
    const onElementClick = vi.fn();
    render(<PreviewFrame src="about:blank" onRequest={onRequest} onElementClick={onElementClick} />);

    window.postMessage({ type: 'element-click', payload: { elementId: 'E1' } }, '*');
    await waitFor(() => expect(onElementClick).toHaveBeenCalledWith({ elementId: 'E1' }));
  });
});
