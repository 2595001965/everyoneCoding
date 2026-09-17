import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PipelineApi } from '../pipeline-api';
import { PipelineProvider, PipelineWorkspace } from '../index';
import { createFakeApi } from './pipeline-ui.test';

/**
 * T5-02 UI 测试（第二部分）：PipelineWorkspace 集成路径（E2E-03 / E2E-19）。
 * - 未选技术方案进入 S3 被问卷阻断；
 * - 完成问卷后 S3 侧栏显示技术选型摘要；
 * - 输入想法 → 生成需求文档 → 确认 → 前进（S1→S2→S3 全链路可操作）。
 */

function renderWorkspace(api: PipelineApi): ReturnType<typeof render> {
  return render(
    <PipelineProvider api={api}>
      <PipelineWorkspace projectId="P1" userId="U-TEST" projectName="商城" />
    </PipelineProvider>,
  );
}

const IDEA_200 = [
  '做一个面向小团队的轻量项目管理系统，核心诉求：',
  '1. 需求从想法到代码全流程可视化，每个阶段产物可查看可回退；',
  '2. 界面用可视化设计器拖拽完成，导出标准 DSL；',
  '3. 所有代码由 AI 生成，客户端代码视图只读；',
  '4. 数据全部本地存储，不依赖云端同步；',
  '5. 支持七端产物（Web/Android/iOS/鸿蒙/Windows/Linux/macOS）生成。',
  '目标用户是独立开发者与小团队，期望单机即可运行。',
].join('');

describe('PipelineWorkspace（E2E-03 集成路径）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('输入想法 → 生成需求文档 → 确认 → 前进到 S2（全链路可操作）', async () => {
    const api = createFakeApi('P1');
    renderWorkspace(api);

    await userEvent.type(screen.getByTestId('idea-input'), IDEA_200);
    fireEvent.click(screen.getByTestId('idea-generate'));

    await waitFor(() => {
      expect(screen.getByTestId('artifact-viewer')).toBeInTheDocument();
    });
    // 产物渲染八项要素标题之一
    expect(screen.getByText(/项目背景/)).toBeInTheDocument();

    // 待确认 → 确认 → 前进
    fireEvent.click(screen.getByTestId('stage-confirm'));
    fireEvent.click(screen.getByTestId('stage-advance'));
    await waitFor(() => {
      expect(api.machine.statusOf('S2')).toBe('running');
    });
  });

  it('未选技术方案时进入 S3 被问卷阻断（E2E-19）', async () => {
    const api = createFakeApi('P1');
    renderWorkspace(api);

    // 快速推进 S1 → S2 → S3（S1 直接通过端口生成）
    await userEvent.type(screen.getByTestId('idea-input'), IDEA_200);
    fireEvent.click(screen.getByTestId('idea-generate'));
    await waitFor(() => expect(screen.getByTestId('artifact-viewer')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('stage-confirm'));
    fireEvent.click(screen.getByTestId('stage-advance'));
    // S2 由设计器产出 → 提交待确认 → 确认 → 前进 S3
    act(() => {
      api.submitForReview('P1', 'S2');
    });
    fireEvent.click(screen.getByTestId('stage-confirm'));
    fireEvent.click(screen.getByTestId('stage-advance'));

    // 未选方案：S3 侧栏出现问卷入口
    await waitFor(() => {
      expect(screen.getByTestId('open-tech-wizard')).toBeInTheDocument();
    });
    // 状态机层面 S3 仍是 running（待问卷），未进入生成
    expect(api.machine.statusOf('S3')).toBe('running');
  });

  it('完成问卷后 S3 侧栏显示技术选型摘要', async () => {
    const api = createFakeApi('P1');
    await api.saveTechChoice('P1', {
      targets: ['web', 'android'],
      web: 'react',
      mobile: 'flutter',
      harmony: 'arkts',
      desktop: 'tauri2',
      frontend: 'react',
      backend: 'node-nest',
      database: 'sqlite',
      orm: 'prisma',
      deploy: 'desktop',
    });
    renderWorkspace(api);

    api.startStage('P1', 'S1');
    api.submitForReview('P1', 'S1');
    api.confirm('P1', 'S1');
    api.advance('P1', 'S1', 'S2');
    api.startStage('P1', 'S2');
    api.submitForReview('P1', 'S2');
    api.confirm('P1', 'S2');
    act(() => {
      api.advance('P1', 'S2', 'S3');
    });

    await waitFor(() => {
      expect(screen.getByTestId('tech-choice-side')).toBeInTheDocument();
    });
    expect(screen.getByText(/目标端：web \/ android/)).toBeInTheDocument();
  });
});
