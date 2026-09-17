/**
 * 预算告警面板逻辑（T10-01）：把 BudgetGuard 的判定转成 UI 可直接展示的状态。
 *
 * 纯函数（数据经参数传入），渲染层与 Node 侧共用；不碰 SQLite。
 */

import type { BudgetConfig, BudgetDecision } from './budget';

/** 预算面板状态：正常 / 接近阈值告警 / 超限拒绝 */
export type BudgetAlertLevel = 'ok' | 'warning' | 'exceeded';

export interface BudgetAlertView {
  level: BudgetAlertLevel;
  /** 作用域；level=ok 且无预算配置时为 null */
  scope: 'daily' | 'monthly' | null;
  /** 已花费（美元） */
  spent: number;
  /** 预算上限（美元）；level=ok 且未配置时为 null */
  limit: number | null;
  /** 使用比例 0~1（limit 为 null 时为 0） */
  ratio: number;
  /** 面板主文案（含"本月至今日用量"说明，可直接渲染） */
  message: string;
  /** 拒绝时的操作引导 */
  hint: string | null;
}

/** 无预算配置时的空态 */
export function emptyBudgetView(): BudgetAlertView {
  return { level: 'ok', scope: null, spent: 0, limit: null, ratio: 0, message: '未设置预算，用量不受限制', hint: null };
}

/**
 * 把判定结果转成面板视图。
 * 超限拒绝的文案必须带"本月/今日已用金额与上限"（任务卡：拒绝时给出用量说明）。
 */
export function budgetAlertView(decision: BudgetDecision): BudgetAlertView {
  if (decision.ok) {
    if (!decision.warn) return emptyBudgetView();
    const scopeText = decision.warn.scope === 'daily' ? '今日' : '本月';
    return {
      level: 'warning',
      scope: decision.warn.scope,
      spent: decision.warn.spent,
      limit: decision.warn.limit,
      ratio: decision.warn.ratio,
      message: `${scopeText}预算已使用 ${(decision.warn.ratio * 100).toFixed(0)}%（$${decision.warn.spent.toFixed(4)} / $${decision.warn.limit.toFixed(2)}），接近上限`,
      hint: '可在设置中调整预算，或留意后续请求消耗',
    };
  }
  const scopeText = decision.scope === 'daily' ? '今日' : '本月';
  const retryText = decision.scope === 'daily' ? '明日' : '次月';
  return {
    level: 'exceeded',
    scope: decision.scope,
    spent: decision.spent,
    limit: decision.limit,
    ratio: decision.limit > 0 ? decision.spent / decision.limit : 1,
    message: `${scopeText}预算已用尽：${scopeText}至今用量 $${decision.spent.toFixed(4)}，上限 $${decision.limit.toFixed(2)}，已拒绝新的 AI 请求`,
    hint: `可在设置中调整预算或${retryText}再试`,
  };
}

/** 校验预算输入（设置页表单用；非法输入返回错误文案，合法返回 null） */
export function validateBudgetInput(input: {
  dailyUsd: string;
  monthlyUsd: string;
  alertRatio: string;
}): string | null {
  const parse = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const ratio = Number(input.alertRatio.trim() === '' ? '0.8' : input.alertRatio);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) return '告警阈值必须是 0~1 之间的小数（默认 0.8）';
  const daily = parse(input.dailyUsd);
  const monthly = parse(input.monthlyUsd);
  if (input.dailyUsd.trim() !== '' && daily === null) return '日预算必须是 ≥0 的数字（留空表示不限）';
  if (input.monthlyUsd.trim() !== '' && monthly === null) return '月预算必须是 ≥0 的数字（留空表示不限）';
  // 全空 = 两者都不限，是合法组合（emptyBudgetView 展示"未设置预算"）
  return null;
}

/** 表单值 → BudgetConfig（空串转 null） */
export function budgetConfigFromInput(input: {
  dailyUsd: string;
  monthlyUsd: string;
  alertRatio: string;
}): BudgetConfig {
  const num = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const ratioRaw = input.alertRatio.trim();
  const ratio = ratioRaw === '' ? 0.8 : Number(ratioRaw);
  return {
    dailyUsd: num(input.dailyUsd),
    monthlyUsd: num(input.monthlyUsd),
    alertRatio: Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.8,
  };
}
