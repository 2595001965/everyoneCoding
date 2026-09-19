/**
 * 预算告警面板逻辑测试（T10-01）：阈值告警、超限拒绝（含"本月至今日用量"）、表单校验。
 */

import { describe, expect, it } from 'vitest';

import {
  budgetAlertView,
  budgetConfigFromInput,
  emptyBudgetView,
  validateBudgetInput,
} from '../../gateway/budget-alert';

describe('budget-alert：面板状态', () => {
  it('无预算配置 → 空态', () => {
    const view = budgetAlertView({ ok: true });
    expect(view.level).toBe('ok');
    expect(view.message).toContain('未设置预算');
  });

  it('达到 80% 阈值 → 告警', () => {
    const view = budgetAlertView({
      ok: true,
      warn: { scope: 'monthly', ratio: 0.8, spent: 80, limit: 100 },
    });
    expect(view.level).toBe('warning');
    expect(view.ratio).toBeCloseTo(0.8);
    expect(view.message).toContain('本月预算已使用 80%');
  });

  it('月度超限 → 拒绝并给出"本月至今用量"说明', () => {
    const view = budgetAlertView({
      ok: false,
      scope: 'monthly',
      spent: 101.5,
      limit: 100,
      message: '本月预算已用尽（$101.5000 / $100.00），可在设置中调整或次月再试',
    });
    expect(view.level).toBe('exceeded');
    expect(view.message).toContain('本月至今用量 $101.5000');
    expect(view.message).toContain('上限 $100.00');
    expect(view.message).toContain('已拒绝新的 AI 请求');
    expect(view.hint).toContain('次月再试');
  });

  it('日预算超限 → 拒绝文案使用"今日"', () => {
    const view = budgetAlertView({
      ok: false,
      scope: 'daily',
      spent: 5.2,
      limit: 5,
      message: '今日预算已用尽',
    });
    expect(view.level).toBe('exceeded');
    expect(view.scope).toBe('daily');
    expect(view.message).toContain('今日预算已用尽');
  });

  it('emptyBudgetView 是合法空态', () => {
    expect(emptyBudgetView().level).toBe('ok');
    expect(emptyBudgetView().limit).toBeNull();
  });
});

describe('budget-alert：表单校验', () => {
  it('合法输入通过', () => {
    expect(validateBudgetInput({ dailyUsd: '5', monthlyUsd: '100', alertRatio: '0.8' })).toBeNull();
    expect(validateBudgetInput({ dailyUsd: '', monthlyUsd: '100', alertRatio: '' })).toBeNull();
    expect(validateBudgetInput({ dailyUsd: '', monthlyUsd: '', alertRatio: '' })).toBeNull(); // 全空 = 不限
  });

  it('负数与非数字被拒绝', () => {
    expect(validateBudgetInput({ dailyUsd: '-1', monthlyUsd: '', alertRatio: '0.8' })).toContain(
      '日预算',
    );
    expect(validateBudgetInput({ dailyUsd: 'abc', monthlyUsd: '', alertRatio: '0.8' })).toContain(
      '日预算',
    );
    expect(validateBudgetInput({ dailyUsd: '', monthlyUsd: 'xyz', alertRatio: '0.8' })).toContain(
      '月预算',
    );
  });

  it('告警阈值必须在 (0,1]', () => {
    expect(validateBudgetInput({ dailyUsd: '5', monthlyUsd: '', alertRatio: '0' })).toContain(
      '阈值',
    );
    expect(validateBudgetInput({ dailyUsd: '5', monthlyUsd: '', alertRatio: '1.5' })).toContain(
      '阈值',
    );
    expect(validateBudgetInput({ dailyUsd: '5', monthlyUsd: '', alertRatio: '1' })).toBeNull();
  });

  it('budgetConfigFromInput 空串转 null、非法阈值回落 0.8', () => {
    const parsed = budgetConfigFromInput({ dailyUsd: '', monthlyUsd: '80', alertRatio: '' });
    expect(parsed).toEqual({ dailyUsd: null, monthlyUsd: 80, alertRatio: 0.8 });
    const fallback = budgetConfigFromInput({ dailyUsd: '', monthlyUsd: '', alertRatio: '999' });
    expect(fallback.alertRatio).toBe(0.8);
  });
});
