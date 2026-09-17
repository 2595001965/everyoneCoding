/**
 * OnboardingCard 测试（T10-05 / NFR-U-01）。
 *
 * 覆盖：
 * 1. 空项目列表时出现在工作台顶部，三步引导文案齐备（每步含明确的下一步指引）；
 * 2. 有项目时不出现（不打扰已上手用户）；
 * 3. 「新建第一个项目」直达按钮触发新建对话框打开；
 * 4. 端口注入时步骤按真实进度点亮；未注入端口时也能正常显示（会话级兜底）；
 * 5. 「不再显示」写端口 + 本会话不再出现。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OnboardingCard, ONBOARDING_PORT_KEY, type OnboardingApi } from '../OnboardingCard';

function setPort(api: OnboardingApi | undefined): void {
  (globalThis as Record<string, unknown>)[ONBOARDING_PORT_KEY] = api;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  setPort(undefined);
  cleanup();
});

describe('OnboardingCard（NFR-U-01 首次使用引导）', () => {
  it('进度读取失败不会在重新渲染时无限重试', async () => {
    const getProgress = vi.fn().mockRejectedValue(new Error('offline'));
    setPort({
      getProgress,
      isDismissed: vi.fn().mockResolvedValue(false),
      dismiss: vi.fn().mockResolvedValue(undefined),
    });
    const { rerender } = render(<OnboardingCard onCreateProject={() => undefined} />);
    await act(async () => {
      await Promise.resolve();
    });
    rerender(<OnboardingCard onCreateProject={() => undefined} />);
    expect(getProgress).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('新手引导')).toBeTruthy();
  });
  it('显示三步引导，每步含明确下一步指引', () => {
    setPort(undefined);
    render(<OnboardingCard onCreateProject={() => undefined} />);
    expect(screen.getByText('欢迎使用 EveryoneCoding')).toBeTruthy();
    expect(screen.getByText('① 新建项目')).toBeTruthy();
    expect(screen.getByText('② 描述你的想法')).toBeTruthy();
    expect(screen.getByText('③ 生成界面')).toBeTruthy();
    // 每一步都有具体操作指引（NFR-U-01：空状态要有明确下一步）
    expect(screen.getByText(/200 字的产品想法/)).toBeTruthy();
    expect(screen.getByText(/S2 由 AI 生成页面 DSL/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建第一个项目' })).toBeTruthy();
  });

  it('端口注入时按真实进度点亮步骤', async () => {
    const port: OnboardingApi = {
      getProgress: vi.fn().mockResolvedValue({
        projectCreated: true,
        requirementReady: true,
        interfaceReady: false,
      }),
      isDismissed: vi.fn().mockResolvedValue(false),
      dismiss: vi.fn().mockResolvedValue(undefined),
    };
    setPort(port);
    render(<OnboardingCard onCreateProject={() => undefined} />);

    await waitFor(() =>
      expect(screen.getByText('① 新建项目').closest('li')?.dataset.done).toBe('true'),
    );
    expect(screen.getByText('② 描述你的想法').closest('li')?.dataset.done).toBe('true');
    expect(screen.getByText('③ 生成界面').closest('li')?.dataset.done).toBe('false');
  });

  it('「新建第一个项目」触发新建动作', () => {
    const onCreateProject = vi.fn();
    setPort(undefined);
    render(<OnboardingCard onCreateProject={onCreateProject} />);
    fireEvent.click(screen.getByRole('button', { name: '新建第一个项目' }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it('「不再显示」调用端口 dismiss，本会话不再出现', async () => {
    const dismiss = vi.fn().mockResolvedValue(undefined);
    setPort({
      getProgress: vi.fn().mockResolvedValue({
        projectCreated: false,
        requirementReady: false,
        interfaceReady: false,
      }),
      isDismissed: vi.fn().mockResolvedValue(false),
      dismiss,
    });
    const { unmount } = render(<OnboardingCard onCreateProject={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '不再显示' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
    // 组件内部已隐藏
    await waitFor(() => expect(screen.queryByText('欢迎使用 EveryoneCoding')).toBeNull());
    // 重新挂载（同会话）也不再出现——会话级兜底生效
    unmount();
    render(<OnboardingCard onCreateProject={() => undefined} />);
    await waitFor(() => expect(screen.queryByText('欢迎使用 EveryoneCoding')).toBeNull());
  });

  it('端口读取失败不崩溃（如实退化为纯引导）', () => {
    setPort({
      getProgress: vi.fn().mockRejectedValue(new Error('端口故障')),
      isDismissed: vi.fn().mockRejectedValue(new Error('端口故障')),
      dismiss: vi.fn().mockResolvedValue(undefined),
    });
    render(<OnboardingCard onCreateProject={() => undefined} />);
    expect(screen.getByText('欢迎使用 EveryoneCoding')).toBeTruthy();
  });

  it('端口报告已关闭（跨会话持久）时不再出现', async () => {
    setPort({
      getProgress: vi.fn().mockResolvedValue({
        projectCreated: false,
        requirementReady: false,
        interfaceReady: false,
      }),
      isDismissed: vi.fn().mockResolvedValue(true),
      dismiss: vi.fn().mockResolvedValue(undefined),
    });
    render(<OnboardingCard onCreateProject={() => undefined} />);
    await waitFor(() => expect(screen.queryByText('欢迎使用 EveryoneCoding')).toBeNull());
  });
});

describe('WorkspaceHome 集成：空态出现引导（T10-05）', () => {
  // 复用 fake-workspace 的真实端口（与 workspace.test.tsx 同源）
  it('零项目时引导卡与空状态同屏，且不与归档页签混淆', async () => {
    const { createFakeWorkspace } = await import('./fake-workspace');
    const { WorkspaceApiProvider } = await import('../workspace-api');
    const { WorkspaceHome } = await import('../WorkspaceHome');
    const env = createFakeWorkspace();
    render(
      <WorkspaceApiProvider api={env.api}>
        <WorkspaceHome
          onOpenProject={() => undefined}
          onOpenSettings={() => undefined}
          onCreateProject={() => undefined}
        />
      </WorkspaceApiProvider>,
    );
    expect(await screen.findByText('欢迎使用 EveryoneCoding')).toBeTruthy();
    expect(screen.getByText('还没有项目')).toBeTruthy();

    // 归档页签为空时显示归档空态文案，但不出新手引导
    fireEvent.click(screen.getByRole('tab', { name: '归档' }));
    await screen.findByText('没有归档项目');
    expect(screen.queryByText('欢迎使用 EveryoneCoding')).toBeNull();
  });
});
