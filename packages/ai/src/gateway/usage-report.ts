/**
 * 用量报表（T10-01 / FR-AI-09）：项目级与全局两级视图聚合 + CSV 导出。
 *
 * 与 `usage-tracker.ts`（单次调用记录与事件广播）的分工：
 * - usage-tracker 负责"写路径"（record + 预算事件）；
 * - 本模块负责"读路径"（按 Provider / 模型 / 项目 / 用途分组聚合、两级视图、CSV）。
 * 全部为纯函数（repo 数据经端口传入），可进浏览器入口。
 */

import type { UsageRecord, UsageTotals } from '../repo/usage-repo';

/** 单条用量记录的最小形状（usage_record 行的投影；渲染层镜像同构） */
export interface UsageReportRow {
  providerId: string | null;
  modelId: string | null;
  projectId: string | null;
  purpose: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number | null;
  latencyMs: number | null;
  createdAt: number;
}

/** 分组维度键 */
export type UsageGroup = 'provider' | 'model' | 'project' | 'purpose';

/** 分组聚合行 */
export interface UsageGroupRow {
  key: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 费用下限：单价缺失的记录按 0 计（complete=false 时 UI 需标注"估算下限"） */
  cost: number;
  /** 平均延迟（毫秒；无延迟数据时为 null） */
  avgLatencyMs: number | null;
}

/** 两级视图：全局（跨项目）与单项目 */
export interface UsageReport {
  scope: 'global' | 'project';
  projectId: string | null;
  totals: UsageTotals;
  byModel: UsageGroupRow[];
  byProvider: UsageGroupRow[];
  byPurpose: UsageGroupRow[];
  byProject: UsageGroupRow[];
}

function groupRows(
  rows: readonly UsageReportRow[],
  keyOf: (row: UsageReportRow) => string | null,
): UsageGroupRow[] {
  const buckets = new Map<
    string,
    {
      requests: number;
      prompt: number;
      completion: number;
      total: number;
      cost: number;
      latencySum: number;
      latencyCount: number;
    }
  >();
  for (const row of rows) {
    const key = keyOf(row) ?? '(未记录)';
    const bucket = buckets.get(key) ?? {
      requests: 0,
      prompt: 0,
      completion: 0,
      total: 0,
      cost: 0,
      latencySum: 0,
      latencyCount: 0,
    };
    bucket.requests += 1;
    bucket.prompt += row.promptTokens;
    bucket.completion += row.completionTokens;
    bucket.total += row.totalTokens;
    bucket.cost += row.cost ?? 0;
    if (row.latencyMs !== null) {
      bucket.latencySum += row.latencyMs;
      bucket.latencyCount += 1;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      requests: bucket.requests,
      promptTokens: bucket.prompt,
      completionTokens: bucket.completion,
      totalTokens: bucket.total,
      cost: bucket.cost,
      avgLatencyMs:
        bucket.latencyCount > 0 ? Math.round(bucket.latencySum / bucket.latencyCount) : null,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

function totalsOf(rows: readonly UsageReportRow[]): UsageTotals {
  let missingCost = 0;
  let cost = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const row of rows) {
    promptTokens += row.promptTokens;
    completionTokens += row.completionTokens;
    if (row.cost === null) missingCost += 1;
    else cost += row.cost;
  }
  return {
    requests: rows.length,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cost,
    complete: missingCost === 0,
  };
}

/** 全局视图（不限项目） */
export function buildGlobalReport(rows: readonly UsageReportRow[]): UsageReport {
  return {
    scope: 'global',
    projectId: null,
    totals: totalsOf(rows),
    byModel: groupRows(rows, (row) => row.modelId),
    byProvider: groupRows(rows, (row) => row.providerId),
    byPurpose: groupRows(rows, (row) => row.purpose),
    byProject: groupRows(rows, (row) => row.projectId),
  };
}

/** 项目级视图（只聚合该项目的记录） */
export function buildProjectReport(
  projectId: string,
  rows: readonly UsageReportRow[],
): UsageReport {
  const scoped = rows.filter((row) => row.projectId === projectId);
  return {
    scope: 'project',
    projectId,
    totals: totalsOf(scoped),
    byModel: groupRows(scoped, (row) => row.modelId),
    byProvider: groupRows(scoped, (row) => row.providerId),
    byPurpose: groupRows(scoped, (row) => row.purpose),
    byProject: [],
  };
}

/** CSV 导出（UTF-8 文本；含 BOM 由调用方自行处理，避免双写） */
export function reportToCsv(report: UsageReport): string {
  const lines: string[] = [];
  lines.push(`scope,${report.scope}`);
  if (report.projectId !== null) lines.push(`project,${report.projectId}`);
  lines.push(
    'group,key,requests,prompt_tokens,completion_tokens,total_tokens,cost_usd,avg_latency_ms',
  );
  const sections: Array<[UsageGroup, UsageGroupRow[]]> = [
    ['model', report.byModel],
    ['provider', report.byProvider],
    ['purpose', report.byPurpose],
    ['project', report.byProject],
  ];
  for (const [group, rows] of sections) {
    for (const row of rows) {
      // CSV 转义：含逗号/引号/换行的字段加引号并双写引号
      const key = /[",\r\n]/.test(row.key) ? `"${row.key.replaceAll('"', '""')}"` : row.key;
      lines.push(
        [
          group,
          key,
          row.requests,
          row.promptTokens,
          row.completionTokens,
          row.totalTokens,
          row.cost.toFixed(6),
          row.avgLatencyMs ?? '',
        ].join(','),
      );
    }
  }
  return lines.join('\r\n');
}

/** 从 repo 记录投影到报表行（适配层用，渲染层不需要） */
export function rowFromRecord(record: UsageRecord): UsageReportRow {
  return {
    providerId: record.providerId,
    modelId: record.modelId,
    projectId: record.projectId,
    purpose: record.purpose,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    totalTokens: record.totalTokens,
    cost: record.cost,
    latencyMs: record.latencyMs,
    createdAt: record.createdAt,
  };
}
