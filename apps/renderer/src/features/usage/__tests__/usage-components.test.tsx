/**
 * 用量与预算渲染层测试（T10-01）：
 * - UsageDashboard 两级视图切换、分组数据准确、CSV 导出
 * - BudgetSettings 告警展示与超限拒绝提示
 * - 端口未注入时展示引导
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { BudgetConfig, BudgetDecision } from '@ec/ai';
import { UsageDashboard } from '../UsageDashboard';
import { BudgetSettings } from '../BudgetSettings';
import { UsageApiProvider } from '../usage-api';
import type { UsageApi, UsageReportRow } from '../usage-api';

function fakeRows(): UsageReportRow[] {
  return [
    { providerId: 'prov-1', modelId: 'gpt-a', projectId: 'p1', purpose: 'generate', promptTokens: 1000, completionTokens: 500, totalTokens: 1500, cost: 0.02, latencyMs: 900, createdAt: 1 },
    { providerId: 'prov-1', modelId: 'gpt-a', projectId: 'p1', purpose: 'chat', promptTokens: 200, completionTokens: 100, totalTokens: 300, cost: 0.01, latencyMs: 700, createdAt: 2 },
    { providerId: 'prov-2', modelId: 'claude-b', projectId: 'p2', purpose: 'generate', promptTokens: 800, completionTokens: 400, totalTokens: 1200, cost: null, latencyMs: null, createdAt: 3 },
  ];
}

function createFakeUsageApi(overrides?: Partial<UsageApi>): UsageApi {
  const state: { budget: BudgetConfig } = {
    budget: { dailyUsd: null, monthlyUsd: null, alertRatio: 0.8 },
  };
  const api: UsageApi = {
    listRows: async () => fakeRows(),
    getBudget: async () => ({ ...state.budget }),
    setBudget: async (config) => {
      state.budget = { ...config };
    },
    budgetDecision: async () => ({ ok: true }) as BudgetDecision,
    ...overrides,
  };
  return api;
}

function renderDashboard(api: UsageApi | null, projects: Array<{ id: string; name: string }> = []) {
  return render(
    <UsageApiProvider api={api}>
      <UsageDashboard projectOptions={projects} />
    </UsageApiProvider>,
  );
}

describe('UsageDashboard', () => {
  it('未注入端口时展示引导而不崩溃', () => {
    renderDashboard(null);
    expect(screen.getByText(/用量端口未装配/)).toBeTruthy();
  });

  it('全局视图显示合计与模型分组', async () => {
    renderDashboard(createFakeUsageApi());
    await waitFor(() => expect(screen.getByText('gpt-a')).toBeTruthy());
    // 合计卡片：请求数 3、输出 1000（metrics 区文本，避免与表格列标题撞词）
    const metrics = document.querySelector('.ec-usage__summary');
    expect(metrics?.textContent).toContain('3');
    expect(metrics?.textContent).toContain('1,000');
    // 部分模型缺单价的标注
    expect(screen.getByText(/部分模型缺少单价/)).toBeTruthy();
  });

  it('切换到项目视图只显示该项目的记录', async () => {
    renderDashboard(createFakeUsageApi(), [{ id: 'p1', name: '课程平台' }, { id: 'p2', name: '电商后台' }]);
    await waitFor(() => expect(screen.getByText('gpt-a')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: '项目视图' }));
    await waitFor(() => expect(screen.getByLabelText('选择项目')).toBeTruthy());
    // claude-b（属于 p2）不应出现在 p1 的项目视图
    expect(screen.queryByText('claude-b')).toBeNull();
    const metrics = document.querySelector('.ec-usage__summary');
    expect(metrics?.textContent).toContain('2'); // p1 的请求数
  });

  it('切换分组维度（按中转）', async () => {
    renderDashboard(createFakeUsageApi());
    await waitFor(() => expect(screen.getByText('gpt-a')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '按中转' }));
    expect(screen.getByText('prov-1')).toBeTruthy();
    expect(screen.getByText('prov-2')).toBeTruthy();
  });

  it('导出 CSV 触发下载', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true, writable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderDashboard(createFakeUsageApi());
    await waitFor(() => expect(screen.getByText('gpt-a')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '导出 CSV' })).toBeTruthy();

    clickSpy.mockRestore();
  });
});

describe('BudgetSettings', () => {
  function renderBudget(api: UsageApi | null) {
    return render(
      <UsageApiProvider api={api}>
        <BudgetSettings />
      </UsageApiProvider>,
    );
  }

  beforeEach(() => {
    // jsdom 下 anchor.click 会真的抛导航错误，这里静默
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  it('未注入端口时展示引导', () => {
    renderBudget(null);
    expect(screen.getByText(/预算端口未装配/)).toBeTruthy();
  });

  it('无预算时展示空态', async () => {
    renderBudget(createFakeUsageApi());
    await waitFor(() => expect(screen.getByText(/未设置预算，用量不受限制/)).toBeTruthy());
  });

  it('超限拒绝时展示"本月至今用量"与拒绝说明', async () => {
    const decision: BudgetDecision = {
      ok: false,
      scope: 'monthly',
      spent: 101.5,
      limit: 100,
      message: '本月预算已用尽（$101.5000 / $100.00），可在设置中调整或次月再试',
    };
    renderBudget(
      createFakeUsageApi({
        budgetDecision: async () => decision,
        getBudget: async () => ({ dailyUsd: null, monthlyUsd: 100, alertRatio: 0.8 }),
      }),
    );
    await waitFor(() => expect(screen.getByText(/本月至今用量 \$101\.5000/)).toBeTruthy());
    expect(screen.getByText(/已拒绝新的 AI 请求/)).toBeTruthy();
  });

  it('填写并保存预算（校验通过后调用 setBudget）', async () => {
    const setBudget = vi.fn(async () => undefined);
    renderBudget(createFakeUsageApi({ setBudget }));
    const monthly = await screen.findByLabelText('月预算');
    fireEvent.change(monthly, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '保存预算' }));
    await waitFor(() => expect(setBudget).toHaveBeenCalledWith({ dailyUsd: null, monthlyUsd: 100, alertRatio: 0.8 }));
    expect(await screen.findByText('已保存')).toBeTruthy();
  });

  it('非法输入被拦截且不调用 setBudget', async () => {
    const setBudget = vi.fn(async () => undefined);
    renderBudget(createFakeUsageApi({ setBudget }));
    const daily = await screen.findByLabelText('日预算');
    fireEvent.change(daily, { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存预算' }));
    await waitFor(() => expect(screen.getByText(/日预算必须是 ≥0 的数字/)).toBeTruthy());
    expect(setBudget).not.toHaveBeenCalled();
  });
});
