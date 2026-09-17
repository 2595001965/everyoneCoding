import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ProjectDashboard } from '../ProjectDashboard';
import { WorkspaceApiProvider } from '../workspace-api';
import { createFakeWorkspace, type FakeWorkspaceEnvironment } from './fake-workspace';
import { normalizeTiming, reportTiming } from './perf-probe';

let env: FakeWorkspaceEnvironment;

beforeEach(() => {
  env = createFakeWorkspace();
});

function seedSource(): void {
  env.source.memory = [
    { id: 'm1', scope: 'longterm' },
    { id: 'm2', scope: 'project' },
    { id: 'm3', scope: 'project' },
    { id: 'm4', scope: 'feature' },
    { id: 'm5', scope: 'page' },
    { id: 'm6', scope: 'issue' },
  ];
  env.source.pages = [
    { id: 'pg1', platform: 'web' },
    { id: 'pg2', platform: 'web' },
    { id: 'pg3', platform: 'android' },
  ];
  env.source.features = [
    { id: 'f1', done: true },
    { id: 'f2', done: true },
    { id: 'f3', done: false },
    { id: 'f4', done: false },
  ];
  env.source.usage = [
    { modelId: 'gpt-5', tokens: 1000, cost: 0.5, at: 1_700_000_000_000 },
    { modelId: 'gpt-5', tokens: 2000, cost: 1.0, at: 1_699_000_000_000 },
    { modelId: 'claude', tokens: 500, cost: 0.25, at: 1_600_000_000_000 },
  ];
  env.source.commits = Array.from({ length: 7 }).map((_, index) => ({
    sha: `sha${index}000000`,
    message: `提交 ${index + 1}`,
    author: '小吴',
    at: 1_700_000_000_000 + index * 1000,
  }));
  env.source.periodStart = 1_698_000_000_000;
}

function renderDashboard(onOpenRef = vi.fn()) {
  render(
    <WorkspaceApiProvider api={env.api}>
      <ProjectDashboard projectId="p-001" onOpenRef={onOpenRef} />
    </WorkspaceApiProvider>,
  );
  return { onOpenRef };
}

describe('项目仪表盘五项指标（T9-02 / FR-WSP-06）', () => {
  it('五项指标数值与源数据完全一致', async () => {
    seedSource();
    renderDashboard();

    const metrics = await env.api.getDashboardMetrics('p-001');
    expect(metrics.memory.total).toBe(6);
    expect(metrics.memory.byScope['project']).toBe(2);
    expect(metrics.pages).toMatchObject({ total: 3 });
    expect(metrics.pages.byPlatform['web']).toBe(2);
    expect(metrics.features).toMatchObject({ done: 2, total: 4 });
    expect(metrics.features.completion).toBeCloseTo(0.5);
    // 本期（近 30 天）= 前两条 3000 tokens；累计 3500
    expect(metrics.usage.periodTokens).toBe(3000);
    expect(metrics.usage.totalTokens).toBe(3500);
    expect(metrics.usage.totalCost).toBeCloseTo(1.75);
    expect(metrics.usage.byModel.find((item) => item.modelId === 'gpt-5')?.tokens).toBe(3000);
    // 最近提交最多 5 条，按时间倒序
    expect(metrics.git.recent).toHaveLength(5);
    expect(metrics.git.recent[0]!.message).toBe('提交 7');

    // 卡片渲染与源数据一致
    expect(await screen.findByText('6')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText(/3,000 tokens/)).toBeTruthy();
  });

  it('记忆指标按五层分组展示', async () => {
    seedSource();
    renderDashboard();
    const card = await screen.findByText('记忆条目').then((node) => node.closest('article')!);
    expect(within(card).getByText('长期')).toBeTruthy();
    expect(within(card).getByText('项目')).toBeTruthy();
    expect(within(card).getByText('问题')).toBeTruthy();
  });

  it('页面指标按端分组展示（Web / Android）', async () => {
    seedSource();
    renderDashboard();
    const card = await screen.findByText('页面数').then((node) => node.closest('article')!);
    expect(within(card).getByText('Web')).toBeTruthy();
    expect(within(card).getByText('Android')).toBeTruthy();
  });

  it('每项指标可下钻到明细并支持跳转', async () => {
    seedSource();
    const { onOpenRef } = renderDashboard();
    await screen.findByText('记忆条目');

    fireEvent.click(screen.getByRole('button', { name: '查看记忆条目明细' }));
    const panel = await screen.findByLabelText('指标明细');
    expect(within(panel).getByText('记忆条目明细')).toBeTruthy();
    // 明细行可点击跳转（refId = 记忆层）
    fireEvent.click(within(panel).getByRole('button', { name: 'project' }));
    expect(onOpenRef).toHaveBeenCalledWith('memory', 'project', 'project');

    fireEvent.click(within(panel).getByRole('button', { name: '关闭' }));
    expect(screen.queryByLabelText('指标明细')).toBeNull();
  });

  it('Git 指标下钻列出最近提交', async () => {
    seedSource();
    renderDashboard();
    await screen.findByText('最近提交');
    fireEvent.click(screen.getByRole('button', { name: '查看最近提交明细' }));
    const panel = await screen.findByLabelText('指标明细');
    expect(within(panel).getByText('最近提交明细')).toBeTruthy();
    expect(within(panel).getByText('提交 7')).toBeTruthy();
  });

  it('打开仪表盘耗时（含聚合）在预算内并打印口径', async () => {
    seedSource();
    // 口径与 workspace.test.tsx 一致：3 次采样取最小 + 机器吞吐探针归一化，
    // 避免全量并行抢 CPU 时把调度争用误报成性能回归。
    const samples: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      cleanup();
      const started = performance.now();
      renderDashboard();
      await screen.findByText('项目仪表盘');
      await screen.findByText('6');
      samples.push(Number((performance.now() - started).toFixed(2)));
    }
    const timing = normalizeTiming(samples);
    reportTiming('仪表盘打开耗时', 1000, timing, 'jsdom 口径');
    expect(timing.normalized).toBeLessThan(1000);
  });

  it('聚合失败时展示错误与重试入口', async () => {
    env.api.getDashboardMetrics = () => Promise.reject(new Error('指标聚合失败'));
    renderDashboard();
    expect(await screen.findByText('指标聚合失败')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('空项目（无任何数据）指标为零而不是崩溃', async () => {
    renderDashboard();
    expect(await screen.findByText('记忆条目')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/累计 0 tokens/)).toBeTruthy());
  });
});
