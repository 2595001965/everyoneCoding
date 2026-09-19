/**
 * 项目仪表盘与阶段视图的共享形状（T9-02 / FR-WSP-06）。
 *
 * 为什么放在 core 而不是渲染层：这些结构**跨进程传递**——主进程的 workspace 域运行时
 * 负责聚合（SQL / DSL / usage），渲染层只负责展示。若两边各写一份声明，字段一变就会
 * 出现"主进程发了、渲染层解析不到"的静默漂移。放这里做单一事实源，两侧都从这里取。
 */

import type { ProjectSummary } from './project-types';

/** 流水线阶段（进度环用；null 表示项目尚未进入流水线） */
export interface ProjectStageInfo {
  stage: string;
  status: string;
  /** 已确认阶段数 / 总阶段数（用于进度环比例） */
  confirmed: number;
  total: number;
}

/** 复制结果（含各资源计数，供 UI 展示"复制了什么"） */
export interface DuplicateResult {
  project: ProjectSummary;
  copied: { design: number; memory: number; docs: number; codeFiles: number };
}

/** 五项指标的聚合结果 */
export interface DashboardMetrics {
  /** 记忆条目数（按五层分组） */
  memory: { total: number; byScope: Record<string, number> };
  /** 页面数（按端分组；端信息取自设计 DSL，无 DSL 时为空分组） */
  pages: { total: number; byPlatform: Record<string, number> };
  /** 功能完成度 */
  features: { done: number; total: number; completion: number };
  /** AI 调用量与成本（本期 / 累计，按模型分组） */
  usage: {
    periodLabel: string;
    periodTokens: number;
    periodCost: number;
    totalTokens: number;
    totalCost: number;
    byModel: Array<{ modelId: string; tokens: number; cost: number }>;
  };
  /** 最近 Git 提交（最多 5 条；git 能力未装配时为空） */
  git: { recent: Array<{ sha: string; message: string; author: string; at: number }> };
  /** 聚合计算耗时（毫秒，性能口径） */
  computeMs: number;
}

/** 指标键 */
export type MetricKey = 'memory' | 'pages' | 'features' | 'usage' | 'git';

/** 下钻明细行 */
export interface MetricDetailRow {
  label: string;
  value: string;
  /** 关联对象 id（如记忆 scope 筛选、页面 id），供跳转 */
  refId?: string | undefined;
}

/** 下钻明细 */
export interface MetricDetail {
  key: MetricKey;
  title: string;
  rows: MetricDetailRow[];
}
