/**
 * MetricsCard（T9-02 / FR-WSP-06）：单项指标卡片，点击下钻。
 */

import type { MetricKey } from './workspace-api';

export interface MetricsCardProps {
  metricKey: MetricKey;
  title: string;
  /** 主数值（已格式化） */
  value: string;
  /** 副标题（如"本期 / 累计"） */
  caption?: string | undefined;
  /** 分项摘要（如各层条目数） */
  breakdown?: Array<{ label: string; value: string }> | undefined;
  onDrilldown: (key: MetricKey) => void;
}

export function MetricsCard({ metricKey, title, value, caption, breakdown, onDrilldown }: MetricsCardProps): JSX.Element {
  return (
    <article className="ec-ws__metric" data-metric={metricKey}>
      <header className="ec-ws__metric-head">
        <h3>{title}</h3>
        <button
          type="button"
          className="ec-ws__metric-drill"
          onClick={() => onDrilldown(metricKey)}
          aria-label={`查看${title}明细`}
        >
          明细 →
        </button>
      </header>
      <p className="ec-ws__metric-value">{value}</p>
      {caption ? <p className="ec-ws__hint">{caption}</p> : null}
      {breakdown && breakdown.length > 0 ? (
        <ul className="ec-ws__metric-breakdown">
          {breakdown.map((item) => (
            <li key={item.label}>
              <span>{item.label}</span>
              <span>{item.value}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
