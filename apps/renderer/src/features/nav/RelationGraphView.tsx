/**
 * 关系图谱视图（T6-07 要点 2）：页面 → 元素 → 接口 → 后端模块 → 数据表。
 *
 * - 布局用领域层 `layoutGraph`（同类型节点同一 y，组内 x 单调递增，坐标落界）；
 * - 缩放：`+` / `-` 只改 SVG `viewBox`，不重算布局；
 * - 筛选：按节点类型勾选，用 `filterGraph`（只保留两端都在的边）；
 * - 选中节点：用 `highlightPaths` 求上下游，给节点 / 边加高亮类。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { EmptyState } from '@ec/ui';
import {
  filterGraph,
  highlightPaths,
  layoutGraph,
  type RelationGraph,
  type RelationNodeType,
} from '@ec/ai';

import { useNavApi } from './nav-api';

export interface RelationGraphViewProps {
  /** 画布尺寸（测试可据此断言坐标） */
  width?: number;
  height?: number;
}

const ALL_TYPES: readonly RelationNodeType[] = ['page', 'element', 'api', 'module', 'table'];

const TYPE_LABELS: Record<RelationNodeType, string> = {
  page: '页面',
  element: '元素',
  api: '接口',
  module: '后端模块',
  table: '数据表',
};

const TYPE_COLORS: Record<RelationNodeType, string> = {
  page: 'var(--ec-color-primary)',
  element: 'var(--ec-color-info)',
  api: 'var(--ec-color-success)',
  module: 'var(--ec-color-warning)',
  table: 'var(--ec-color-danger)',
};

export function RelationGraphView({ width = 800, height = 600 }: RelationGraphViewProps): JSX.Element {
  const api = useNavApi();
  const [graph, setGraph] = useState<RelationGraph | null>(null);
  const [types, setTypes] = useState<RelationNodeType[]>([...ALL_TYPES]);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  const load = useCallback(async () => {
    setGraph(await api.relationGraph());
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 筛选后的图（边两端都要在） */
  const filtered = useMemo(() => (graph === null ? null : filterGraph(graph, types)), [graph, types]);
  const layout = useMemo(
    () => (filtered === null ? null : layoutGraph(filtered, { width, height })),
    [filtered, width, height],
  );
  const highlight = useMemo(
    () => (graph === null || selected === null ? null : highlightPaths(graph, selected)),
    [graph, selected],
  );

  const toggleType = useCallback((type: RelationNodeType) => {
    setTypes((prev) => (prev.includes(type) ? prev.filter((item) => item !== type) : [...prev, type]));
  }, []);

  const zoomIn = useCallback(() => setZoom((value) => Math.min(3, Number((value + 0.25).toFixed(2)))), []);
  const zoomOut = useCallback(() => setZoom((value) => Math.max(0.5, Number((value - 0.25).toFixed(2)))), []);

  if (graph === null) return <span role="status">加载关系图谱…</span>;

  const viewW = width / zoom;
  const viewH = height / zoom;
  const viewBox = `${(width - viewW) / 2} ${(height - viewH) / 2} ${viewW} ${viewH}`;

  return (
    <div className="ec-relation-graph" data-testid="relation-graph-view" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="ec-relation-graph__toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {ALL_TYPES.map((type) => (
          <label key={type} className="ec-relation-graph__filter" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={types.includes(type)}
              onChange={() => toggleType(type)}
              aria-label={`筛选 ${TYPE_LABELS[type]}`}
              data-testid={`graph-filter-${type}`}
            />
            <span>{TYPE_LABELS[type]}</span>
          </label>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={zoomOut} aria-label="缩小" data-testid="graph-zoom-out" style={btnStyle}>
          −
        </button>
        <span data-testid="graph-zoom-value">{zoom.toFixed(2)}</span>
        <button type="button" onClick={zoomIn} aria-label="放大" data-testid="graph-zoom-in" style={btnStyle}>
          ＋
        </button>
        <span style={{ color: 'var(--ec-color-text-secondary)' }} data-testid="graph-counts">
          {filtered?.nodes.length ?? 0} 个节点 / {filtered?.edges.length ?? 0} 条边
        </span>
      </div>

      {layout === null || layout.nodes.length === 0 ? (
        <EmptyState title="当前筛选下没有节点" description="请在上方勾选至少一种节点类型。" />
      ) : (
        <svg
          className="ec-relation-graph__svg"
          data-testid="relation-graph-svg"
          role="img"
          aria-label="关系图谱"
          width={width}
          height={height}
          viewBox={viewBox}
          style={{ border: '1px solid var(--ec-color-border)', borderRadius: 6, background: 'var(--ec-color-surface)' }}
        >
          {filtered?.edges.map((edge) => {
            const from = layout.nodes.find((node) => node.id === edge.from);
            const to = layout.nodes.find((node) => node.id === edge.to);
            if (from === undefined || to === undefined) return null;
            const isHi = highlight?.edges.includes(edge.id) === true;
            return (
              <line
                key={edge.id}
                data-testid="relation-edge"
                data-edge={edge.id}
                className={isHi ? 'ec-relation-graph__edge ec-relation-graph__edge--hl' : 'ec-relation-graph__edge'}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={isHi ? 'var(--ec-color-primary)' : 'var(--ec-color-border)'}
                strokeWidth={isHi ? 2 : 1}
              />
            );
          })}

          {layout.nodes.map((node) => {
            const isHi = highlight?.nodes.includes(node.id) === true;
            return (
              <g
                key={node.id}
                className={isHi ? 'ec-relation-graph__node ec-relation-graph__node--hl' : 'ec-relation-graph__node'}
                data-testid="relation-node"
                data-node={node.id}
                data-type={node.type}
                data-x={node.x}
                data-y={node.y}
                onClick={() => setSelected(node.id)}
                style={{ cursor: 'pointer' }}
              >
                <circle cx={node.x} cy={node.y} r={isHi ? 9 : 6} fill={TYPE_COLORS[node.type]} />
                <text x={node.x + 10} y={node.y + 4} fontSize={11} fill="var(--ec-color-text)">
                  {node.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {highlight !== null && (
        <div role="status" data-testid="graph-highlight" style={{ color: 'var(--ec-color-text-secondary)' }}>
          已高亮 {highlight.nodes.length} 个节点 / {highlight.edges.length} 条边：上游 {highlight.upstream.length} 个，下游{' '}
          {highlight.downstream.length} 个
        </div>
      )}
    </div>
  );
}

const btnStyle = {
  padding: '2px 8px',
  border: '1px solid var(--ec-color-border)',
  borderRadius: 6,
  background: 'var(--ec-color-surface)',
  color: 'var(--ec-color-text)',
  cursor: 'pointer',
} as const;
