/**
 * 用量仪表盘（T10-01）：两级视图（全局 / 项目）+ 按维度分组 + CSV 导出。
 *
 * 分组与合计由 `@ec/ai` 的纯函数计算（buildGlobalReport / buildProjectReport），
 * 数据行经端口读取；不引重型图表库（NFR 包体约束）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { buildGlobalReport, buildProjectReport, reportToCsv, type UsageReport } from '@ec/ai';
import { Button, Table, Tag } from '@ec/ui';
import { useUsageOptional, type UsageReportRow } from './usage-api';
import './usage.css';

type Scope = 'global' | 'project';
type GroupKey = 'model' | 'provider' | 'purpose' | 'project';

const GROUP_LABELS: Record<GroupKey, string> = {
  model: '按模型',
  provider: '按中转',
  purpose: '按用途',
  project: '按项目',
};

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatTokens(value: number): string {
  return value.toLocaleString('zh-CN');
}

export function UsageDashboard({
  projectOptions,
}: {
  projectOptions: Array<{ id: string; name: string }>;
}): JSX.Element {
  const api = useUsageOptional();
  const [scope, setScope] = useState<Scope>('global');
  const [projectId, setProjectId] = useState<string>(projectOptions[0]?.id ?? '');
  const [group, setGroup] = useState<GroupKey>('model');
  const [rows, setRows] = useState<UsageReportRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!api) return;
      const data = await api.listRows();
      if (!cancelled) {
        setRows(data);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const report: UsageReport | null = useMemo(() => {
    if (!loaded) return null;
    return scope === 'global' ? buildGlobalReport(rows) : buildProjectReport(projectId, rows);
  }, [loaded, rows, scope, projectId]);

  const groupRows = useMemo(() => {
    if (!report) return [];
    if (group === 'model') return report.byModel;
    if (group === 'provider') return report.byProvider;
    if (group === 'purpose') return report.byPurpose;
    return report.byProject;
  }, [report, group]);

  const exportCsv = useCallback(() => {
    if (!report) return;
    const csv = reportToCsv(report);
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `usage-${report.scope}${report.scope === 'project' ? `-${report.projectId}` : ''}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [report]);

  if (!api) {
    return (
      <div className="ec-usage">
        <p className="ec-usage__hint">用量端口未装配。初始化后这里可以查看本月 AI 用量与费用。</p>
      </div>
    );
  }
  if (!report) return <div className="ec-usage">加载中…</div>;

  return (
    <div className="ec-usage">
      <div className="ec-usage__toolbar">
        <div className="ec-usage__scopes" role="tablist" aria-label="用量视图">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'global'}
            data-active={scope === 'global'}
            onClick={() => setScope('global')}
          >
            全局视图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'project'}
            data-active={scope === 'project'}
            disabled={projectOptions.length === 0}
            onClick={() => setScope('project')}
          >
            项目视图
          </button>
          {scope === 'project' ? (
            <select
              aria-label="选择项目"
              className="ec-usage__project-select"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projectOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <div className="ec-usage__groups">
          {(Object.keys(GROUP_LABELS) as GroupKey[]).map((key) => (
            <button
              key={key}
              type="button"
              data-active={group === key}
              onClick={() => setGroup(key)}
            >
              {GROUP_LABELS[key]}
            </button>
          ))}
        </div>
        <Button onClick={exportCsv}>导出 CSV</Button>
      </div>

      <div className="ec-usage__summary">
        <div className="ec-usage__metric">
          <span className="ec-usage__metric-label">请求数</span>
          <span className="ec-usage__metric-value">{formatTokens(report.totals.requests)}</span>
        </div>
        <div className="ec-usage__metric">
          <span className="ec-usage__metric-label">输入 Token</span>
          <span className="ec-usage__metric-value">{formatTokens(report.totals.promptTokens)}</span>
        </div>
        <div className="ec-usage__metric">
          <span className="ec-usage__metric-label">输出 Token</span>
          <span className="ec-usage__metric-value">
            {formatTokens(report.totals.completionTokens)}
          </span>
        </div>
        <div className="ec-usage__metric">
          <span className="ec-usage__metric-label">费用（美元）</span>
          <span className="ec-usage__metric-value">
            {formatUsd(report.totals.cost)}
            {!report.totals.complete ? <Tag>部分模型缺少单价，为估算下限</Tag> : null}
          </span>
        </div>
      </div>

      <Table
        aria-label="用量分组"
        height={320}
        rowKey={(row) => (row as { key: string }).key}
        columns={[
          { key: 'key', title: GROUP_LABELS[group].slice(1) },
          { key: 'requests', title: '请求数' },
          { key: 'promptTokens', title: '输入 Token' },
          { key: 'completionTokens', title: '输出 Token' },
          { key: 'totalTokens', title: '总 Token' },
          { key: 'cost', title: '费用（美元）' },
          { key: 'avgLatencyMs', title: '平均延迟' },
        ]}
        rows={groupRows}
        renderCell={(row, column) => {
          const entry = row as { key: string; cost: number; avgLatencyMs: number | null };
          if (column.key === 'cost') return formatUsd(entry.cost);
          if (column.key === 'avgLatencyMs')
            return entry.avgLatencyMs === null ? '—' : `${entry.avgLatencyMs}ms`;
          const value = (row as unknown as Record<string, unknown>)[column.key];
          return value === undefined || value === null ? '' : String(value);
        }}
      />
    </div>
  );
}
