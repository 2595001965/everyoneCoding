/**
 * ProjectDashboard（T9-02 / FR-WSP-06）：项目仪表盘。
 *
 * 五项指标：记忆条目数（按五层） / 页面数（按端） / 功能完成度 / AI 调用量与成本 / 最近 Git 提交。
 * 每项可点击下钻到明细；指标由外壳聚合（含缓存与增量刷新），本组件负责展示与刷新节流。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Spinner } from '@ec/ui';

import { DrilldownPanel } from './DrilldownPanel';
import { MetricsCard } from './MetricsCard';
import { useWorkspace, type DashboardMetrics, type MetricDetail, type MetricKey } from './workspace-api';

const SCOPE_LABELS: Record<string, string> = {
  longterm: '长期',
  project: '项目',
  feature: '功能',
  page: '页面',
  issue: '问题',
};

const PLATFORM_LABELS: Record<string, string> = {
  web: 'Web',
  android: 'Android',
  ios: 'iOS',
  harmonyos: 'HarmonyOS',
  windows: 'Windows',
  linux: 'Linux',
  macos: 'macOS',
};

export interface ProjectDashboardProps {
  projectId: string;
  /** 下钻跳转（如记忆中心 / Git 页） */
  onOpenRef?: ((key: MetricKey, refId: string | undefined, label: string) => void) | undefined;
}

export function ProjectDashboard({ projectId, onOpenRef }: ProjectDashboardProps): JSX.Element {
  const api = useWorkspace();
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [detail, setDetail] = useState<MetricDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 打开耗时（毫秒，性能口径：从挂载到首帧可得数据） */
  const [openMs, setOpenMs] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const started = Date.now();
    try {
      setMetrics(await api.getDashboardMetrics(projectId));
      setOpenMs(Date.now() - started);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const drilldown = useCallback(
    async (key: MetricKey) => {
      setDetailLoading(true);
      try {
        setDetail(await api.getMetricDetail(projectId, key));
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setDetailLoading(false);
      }
    },
    [api, projectId],
  );

  const cards = useMemo(() => {
    if (!metrics) return [];
    const memoryBreakdown = Object.entries(metrics.memory.byScope).map(([scope, count]) => ({
      label: SCOPE_LABELS[scope] ?? scope,
      value: String(count),
    }));
    const pageBreakdown = Object.entries(metrics.pages.byPlatform).map(([platform, count]) => ({
      label: PLATFORM_LABELS[platform] ?? platform,
      value: String(count),
    }));
    return [
      {
        key: 'memory' as MetricKey,
        title: '记忆条目',
        value: String(metrics.memory.total),
        breakdown: memoryBreakdown,
      },
      {
        key: 'pages' as MetricKey,
        title: '页面数',
        value: String(metrics.pages.total),
        breakdown: pageBreakdown,
      },
      {
        key: 'features' as MetricKey,
        title: '功能完成度',
        value: `${Math.round(metrics.features.completion * 100)}%`,
        caption: `${metrics.features.done} / ${metrics.features.total} 个节点已完成`,
      },
      {
        key: 'usage' as MetricKey,
        title: 'AI 调用量',
        value: `${metrics.usage.periodTokens.toLocaleString('zh-CN')} tokens`,
        caption: `${metrics.usage.periodLabel}；累计 ${metrics.usage.totalTokens.toLocaleString('zh-CN')} tokens / ¥${metrics.usage.totalCost.toFixed(2)}`,
        breakdown: metrics.usage.byModel.slice(0, 4).map((item) => ({
          label: item.modelId,
          value: `${item.tokens.toLocaleString('zh-CN')} / ¥${item.cost.toFixed(2)}`,
        })),
      },
      {
        key: 'git' as MetricKey,
        title: '最近提交',
        value: String(metrics.git.recent.length),
        caption: metrics.git.recent[0]?.message ?? '暂无提交记录',
        breakdown: metrics.git.recent.slice(0, 5).map((commit) => ({
          label: commit.sha.slice(0, 7),
          value: commit.message,
        })),
      },
    ];
  }, [metrics]);

  if (loading) {
    return (
      <section className="ec-ws__dashboard" aria-label="项目仪表盘">
        <Spinner /> <span className="ec-ws__hint">正在聚合指标…</span>
      </section>
    );
  }

  if (error) {
    return (
      <section className="ec-ws__dashboard" aria-label="项目仪表盘">
        <p className="ec-ws__error">{error}</p>
        <Button variant="secondary" onClick={() => void load()}>
          重试
        </Button>
      </section>
    );
  }

  return (
    <section className="ec-ws__dashboard" aria-label="项目仪表盘">
      <header className="ec-ws__dashboard-head">
        <h1>项目仪表盘</h1>
        <span className="ec-ws__hint" role="status">
          {`打开耗时 ${openMs ?? 0}ms（聚合 ${metrics?.computeMs ?? 0}ms，缓存后增量刷新）`}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          刷新
        </Button>
      </header>

      <div className="ec-ws__metrics">
        {cards.map((card) => (
          <MetricsCard
            key={card.key}
            metricKey={card.key}
            title={card.title}
            value={card.value}
            caption={card.caption}
            breakdown={card.breakdown}
            onDrilldown={(key) => void drilldown(key)}
          />
        ))}
      </div>

      <DrilldownPanel
        detail={detail}
        loading={detailLoading}
        onClose={() => setDetail(null)}
        {...(onOpenRef ? { onOpenRow: onOpenRef } : {})}
      />
    </section>
  );
}
