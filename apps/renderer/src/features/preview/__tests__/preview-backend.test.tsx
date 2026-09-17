import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PreviewApiProvider } from '../preview-api';
import { BackendPanel } from '../BackendPanel';
import { ApiDebugger } from '../ApiDebugger';
import { createFakePreviewApi } from './fake-preview';

describe('BackendPanel（T6-06）', () => {
  it('展示项目识别信息与日志（按级别着色）', async () => {
    const api = createFakePreviewApi();
    render(
      <PreviewApiProvider api={api}>
        <BackendPanel />
      </PreviewApiProvider>,
    );

    await waitFor(() => expect(screen.getByText('Node.js 项目')).toBeInTheDocument());
    expect(screen.getByText('npm install')).toBeInTheDocument();
    expect(screen.getByText('npm run dev')).toBeInTheDocument();

    // stderr 日志按 error 级着色
    const errorLog = screen.getByText('启动失败 fatal error');
    expect(errorLog.closest('.ec-backend-panel__log')).toHaveClass('ec-backend-panel__log--error');
    // 关键字过滤
    const search = screen.getByRole('textbox', { name: '过滤日志关键字' }) as HTMLInputElement;
    await userEvent.setup().type(search, 'fatal');
    await waitFor(() => {
      expect(screen.queryByText('依赖安装完成')).not.toBeInTheDocument();
      expect(screen.getByText('启动失败 fatal error')).toBeInTheDocument();
    });
  });

  it('启动按钮调用 startBackend 并展示运行状态', async () => {
    const user = userEvent.setup();
    const api = createFakePreviewApi();
    render(
      <PreviewApiProvider api={api}>
        <BackendPanel />
      </PreviewApiProvider>,
    );

    await user.click(await screen.findByRole('button', { name: '启动' }));
    await waitFor(() => {
      expect(screen.getByText('运行中 · http://localhost:3000')).toBeInTheDocument();
    });
  });

  it('未识别到项目类型时提示可编辑命令映射（不报错）', async () => {
    const api = createFakePreviewApi();
    // 把项目类型改成 unknown
    vi.spyOn(api, 'projectProfile').mockResolvedValue({
      ok: true,
      data: {
        kind: 'unknown',
        label: '未知项目类型',
        installCmd: null,
        startCmd: null,
        portHint: null,
        envHints: [],
        evidence: [],
        confidence: 0,
        requiresManualCommand: true,
      },
      logs: [],
      error: null,
    });
    render(
      <PreviewApiProvider api={api}>
        <BackendPanel />
      </PreviewApiProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/未识别到项目类型，请在设置中编辑命令映射/)).toBeInTheDocument();
    });
  });
});

describe('ApiDebugger（T6-06）', () => {
  it('展示请求列表，失败项高亮', async () => {
    const api = createFakePreviewApi();
    render(
      <PreviewApiProvider api={api}>
        <ApiDebugger />
      </PreviewApiProvider>,
    );

    await waitFor(() => expect(screen.getAllByTestId('api-row').length).toBe(2));
    const failed = screen.getByText('/login').closest('.ec-api-debugger__row');
    expect(failed).toHaveClass('ec-api-debugger__row--failed');
  });

  it('展开请求可看入参/响应，重放与复制 cURL', async () => {
    const user = userEvent.setup();
    // userEvent.setup() 会用自己的剪贴板桩替换 navigator.clipboard，
    // 所以必须在 setup 之后再装我们的 spy；jsdom 里 clipboard 是只读 getter，用 defineProperty。
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const api = createFakePreviewApi();
    render(
      <PreviewApiProvider api={api}>
        <ApiDebugger />
      </PreviewApiProvider>,
    );

    // 展开失败行
    const loginSummary = (await screen.findByText('/login')).closest('button');
    await user.click(loginSummary as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('response-body')).toBeInTheDocument());
    expect(screen.getByTestId('request-body')).toBeInTheDocument();
    expect(screen.getByText('Mock 返回错误状态 500')).toBeInTheDocument();

    // 复制 cURL
    await user.click(screen.getByRole('button', { name: '复制为 cURL' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const arg = writeText.mock.calls[0]?.[0] as string | undefined;
    expect(arg).toMatch(/^curl -X /);
  });
});
