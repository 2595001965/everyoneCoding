/**
 * 用量与预算端口（T10-01 / FR-AI-09）。
 *
 * 冻结契约：外壳注入 `globalThis.__EC_USAGE__`。
 * - 纯聚合（两级视图 / CSV）由渲染层直接调 `@ec/ai` 的纯函数；
 * - 数据读取（usage_record 行）与预算写入（BudgetGuard.configure）走端口。
 */

import { createContext, useContext, type ReactNode } from 'react';

import type { UsageReport, UsageReportRow } from '@ec/ai';
import type { BudgetConfig, BudgetDecision } from '@ec/ai';

export interface UsageApi {
  /** 全部用量行（本月；外壳负责时间过滤） */
  listRows(): Promise<UsageReportRow[]>;
  /** 当前预算配置 */
  getBudget(): Promise<BudgetConfig>;
  /** 更新预算配置 */
  setBudget(config: BudgetConfig): Promise<void>;
  /** 预算判定（含已花费；用于面板实时展示） */
  budgetDecision(): Promise<BudgetDecision>;
}

const UsageContext = createContext<UsageApi | null>(null);

export function UsageApiProvider({ api, children }: { api: UsageApi | null; children: ReactNode }): JSX.Element {
  return <UsageContext.Provider value={api}>{children}</UsageContext.Provider>;
}

export function useUsageOptional(): UsageApi | null {
  return useContext(UsageContext);
}

export function useUsage(): UsageApi {
  const api = useContext(UsageContext);
  if (!api) throw new Error('用量端口未注入：请先在外壳中装配 globalThis.__EC_USAGE__');
  return api;
}

export function UsageUnavailable(): JSX.Element {
  return (
    <div className="ec-usage">
      <p className="ec-usage__hint">用量端口尚未装配。初始化后这里可以查看 AI 用量与预算。</p>
    </div>
  );
}

export function readInjectedUsageApi(): UsageApi | null {
  const injected = (globalThis as { __EC_USAGE__?: UsageApi }).__EC_USAGE__;
  return injected ?? null;
}

/** 用量报表行（导出 CSV 时的复用类型） */
export type { UsageReport, UsageReportRow };
