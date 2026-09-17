/**
 * DashboardTemplate 数据看板模板（T3-04 业务组件）。KPI 区 + 图表区，接受 children。
 */
import { EmptyState } from '@ec/ui';

import type { ComponentMeta, ComponentRenderProps } from '../../registry/component-registry';
import { propOptions, propString, previewOptions, previewString } from '../render-utils';

export function DashboardTemplateRenderer({ node, mode, scope, children }: ComponentRenderProps): JSX.Element {
  const title = mode === 'preview' ? previewString(node, 'title', scope, '数据看板') : propString(node, 'title', '数据看板');
  const kpis = mode === 'preview' ? previewOptions(node, 'kpis', scope) : propOptions(node, 'kpis');
  const chartType = propString(node, 'chartType', 'line');

  return (
    <section className="ecd-dashboard" data-chart-type={chartType} data-component="DashboardTemplate" data-mode={mode}>
      <header className="ecd-dashboard__header">
        <h2 className="ecd-dashboard__title">{title || '数据看板'}</h2>
      </header>
      <div className="ecd-dashboard__kpis">
        {kpis.length > 0
          ? kpis.map((kpi) => (
              <div key={kpi.value} className="ecd-kpi">
                <div className="ecd-kpi__label">{kpi.label}</div>
                <div className="ecd-kpi__value">{kpi.value}</div>
              </div>
            ))
          : <span className="ecd-placeholder">配置 KPI 指标</span>}
      </div>
      <div className="ecd-dashboard__chart">
        <EmptyState title="图表区" description={`图表类型：${chartType}`} />
      </div>
      {children}
    </section>
  );
}

export const DashboardTemplateMeta: ComponentMeta = {
  type: 'DashboardTemplate',
  displayName: '数据看板模板',
  group: '业务组件',
  description: '内置 KPI 概览与图表的看板页面模板',
  icon: 'dashboard',
  defaultProps: { title: '数据看板', kpis: [], chartType: 'line' },
  defaultStyle: {},
  acceptsChildren: true,
  propSchema: {
    fields: [
      { key: 'title', label: '标题', type: 'text', group: '内容', default: '数据看板' },
      { key: 'kpis', label: 'KPI 指标', type: 'options', group: '数据', default: [] },
      { key: 'chartType', label: '图表类型', type: 'enum', group: '数据', default: 'line', options: [
        { value: 'line', label: '折线' },
        { value: 'bar', label: '柱状' },
        { value: 'pie', label: '饼图' },
        { value: 'none', label: '无' },
      ] },
    ],
  },
};
