/**
 * 用量报表聚合测试（T10-01）：两级视图准确性、分组聚合、CSV 转义。
 */

import { describe, expect, it } from 'vitest';

import { buildGlobalReport, buildProjectReport, reportToCsv, type UsageReportRow } from '../../gateway/usage-report';

function row(overrides: Partial<UsageReportRow>): UsageReportRow {
  return {
    providerId: 'prov-1',
    modelId: 'model-a',
    projectId: 'p1',
    purpose: 'generate',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cost: 0.01,
    latencyMs: 800,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

const ROWS: UsageReportRow[] = [
  row({ modelId: 'model-a', providerId: 'prov-1', projectId: 'p1', cost: 0.01, latencyMs: 800 }),
  row({ modelId: 'model-a', providerId: 'prov-1', projectId: 'p1', cost: 0.02, latencyMs: 1200 }),
  row({ modelId: 'model-b', providerId: 'prov-2', projectId: 'p2', cost: 0.05, latencyMs: 400 }),
  row({ modelId: 'model-b', providerId: 'prov-2', projectId: null, cost: null, latencyMs: null }),
];

describe('usage-report：两级视图聚合', () => {
  it('全局视图合计准确', () => {
    const report = buildGlobalReport(ROWS);
    expect(report.scope).toBe('global');
    expect(report.totals.requests).toBe(4);
    expect(report.totals.promptTokens).toBe(400);
    expect(report.totals.completionTokens).toBe(200);
    expect(report.totals.totalTokens).toBe(600);
    expect(report.totals.cost).toBeCloseTo(0.08);
    expect(report.totals.complete).toBe(false); // 1 条缺单价
  });

  it('项目视图只聚合该项目的记录', () => {
    const report = buildProjectReport('p1', ROWS);
    expect(report.scope).toBe('project');
    expect(report.projectId).toBe('p1');
    expect(report.totals.requests).toBe(2);
    expect(report.totals.cost).toBeCloseTo(0.03);
    expect(report.byModel).toHaveLength(1);
    expect(report.byModel[0]!.key).toBe('model-a');
  });

  it('按模型分组聚合与排序（按总 token 降序）', () => {
    const report = buildGlobalReport(ROWS);
    expect(report.byModel.map((entry) => entry.key)).toEqual(['model-a', 'model-b']);
    const modelA = report.byModel[0]!;
    expect(modelA.requests).toBe(2);
    expect(modelA.totalTokens).toBe(300);
    expect(modelA.avgLatencyMs).toBe(1000); // (800+1200)/2
  });

  it('按中转/用途/项目分组均可用', () => {
    const report = buildGlobalReport(ROWS);
    expect(report.byProvider.map((entry) => entry.key)).toEqual(['prov-1', 'prov-2']);
    expect(report.byPurpose.map((entry) => entry.key)).toEqual(['generate']);
    expect(report.byProject.map((entry) => entry.key).sort()).toEqual(['(未记录)', 'p1', 'p2']);
  });

  it('平均延迟对无数据记录返回 null', () => {
    const report = buildGlobalReport([row({ latencyMs: null })]);
    expect(report.byModel[0]!.avgLatencyMs).toBeNull();
  });
});

describe('usage-report：CSV 导出', () => {
  it('表头与行结构符合预期', () => {
    const report = buildProjectReport('p1', ROWS);
    const csv = reportToCsv(report);
    expect(csv).toContain('scope,project');
    expect(csv).toContain('project,p1');
    expect(csv).toContain('group,key,requests,prompt_tokens,completion_tokens,total_tokens,cost_usd,avg_latency_ms');
    expect(csv).toContain('model,model-a,2,200,100,300,0.030000,1000');
  });

  it('含逗号/引号的键值被转义', () => {
    const rows = [row({ modelId: 'model,with"quotes"' })];
    const csv = reportToCsv(buildGlobalReport(rows));
    expect(csv).toContain('"model,with""quotes"""');
  });

  it('空数据导出只含表头（无分组行）', () => {
    const csv = reportToCsv(buildGlobalReport([]));
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2); // scope 行 + group 表头行，无数据行
    expect(lines[0]).toBe('scope,global');
    expect(lines[1]).toBe('group,key,requests,prompt_tokens,completion_tokens,total_tokens,cost_usd,avg_latency_ms');
  });
});
