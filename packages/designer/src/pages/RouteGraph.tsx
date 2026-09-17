/**
 * RouteGraph：页面跳转关系图（T3-07）。
 *
 * 自绘 SVG 连线 + DOM 节点（不引第三方图库）：
 * - 节点 = 页面（按网格布局，绝对定位 DOM）；
 * - 边 = 事件流里的 navigate 动作（target 匹配目标页面 route）；
 * - 未匹配到目标页面的跳转画到右侧「未匹配」占位；
 * - 点击边打开 RouteEditor 编辑目标页面与路由参数。
 */
import * as React from 'react';
import { EmptyState } from '@ec/ui';

import type { PageDsl, RouteParam } from '../dsl/types';
import { buildRouteEdges, type RouteEdge } from './route-table';
import { RouteEditor } from './RouteEditor';

export interface RouteGraphProps {
  pages: PageDsl[];
  height: number;
  onUpdateAction: (
    pageId: string,
    eventId: string,
    actionId: string,
    patch: { target?: string; params?: RouteParam[] },
  ) => void;
}

const NODE_W = 150;
const NODE_H = 46;
const GAP_X = 90;
const GAP_Y = 28;
const UNMATCHED_X = 40;

interface Box {
  x: number;
  y: number;
}

export function RouteGraph({ pages, height, onUpdateAction }: RouteGraphProps): React.ReactElement {
  const [editingEdge, setEditingEdge] = React.useState<RouteEdge | null>(null);
  const edges = React.useMemo(() => buildRouteEdges(pages), [pages]);

  const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(pages.length))));
  const rows = Math.ceil(pages.length / cols);
  const boxes = React.useMemo(() => {
    const map = new Map<string, Box>();
    pages.forEach((page, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      map.set(page.id, { x: col * (NODE_W + GAP_X), y: row * (NODE_H + GAP_Y) });
    });
    return map;
  }, [pages, cols]);

  const canvasW = cols * (NODE_W + GAP_X);
  const canvasH = rows * (NODE_H + GAP_Y);

  if (pages.length === 0) {
    return (
      <div className="ec-route-graph" style={{ height }}>
        <EmptyState title="路由图" description="还没有页面，无法绘制跳转关系" />
      </div>
    );
  }

  const edgePath = (sx: number, sy: number, tx: number, ty: number): string => {
    const dx = Math.max(30, Math.abs(tx - sx) / 2);
    return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  };

  return (
    <div className="ec-route-graph" style={{ height, overflow: 'auto', position: 'relative' }}>
      <svg
        width={canvasW + UNMATCHED_X * 2}
        height={canvasH}
        className="ec-route-graph__svg"
        aria-label="路由跳转关系图"
      >
        <defs>
          <marker id="ec-route-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L8,3 L0,6 Z" fill="currentColor" />
          </marker>
        </defs>
        {edges.map((edge, i) => {
          const from = boxes.get(edge.fromPageId);
          if (!from) return null;
          const to = edge.toPageId ? boxes.get(edge.toPageId) : null;
          const sx = from.x + NODE_W;
          const sy = from.y + NODE_H / 2;
          const tx = to ? to.x : canvasW + UNMATCHED_X;
          const ty = to ? to.y + NODE_H / 2 : sy;
          const d = edgePath(sx, sy, tx, ty);
          return (
            <g key={`${edge.fromPageId}-${edge.eventId}-${edge.actionId}-${i}`} className="ec-route-graph__edge">
              <path d={d} className="ec-route-graph__line" fill="none" markerEnd="url(#ec-route-arrow)" />
              <path
                d={d}
                className="ec-route-graph__hit"
                fill="none"
                stroke="transparent"
                strokeWidth={10}
                style={{ cursor: 'pointer' }}
                onClick={() => setEditingEdge(edge)}
              >
                <title>{edge.label}</title>
              </path>
            </g>
          );
        })}
        {edges
          .filter((e) => e.toPageId === null)
          .map((edge, i) => (
            <g key={`unmatched-${i}`}>
              <rect
                x={canvasW + UNMATCHED_X - 6}
                y={boxes.get(edge.fromPageId)?.y ?? 0}
                width={NODE_W - 40}
                height={NODE_H}
                rx={6}
                className="ec-route-graph__unmatched"
              />
              <text x={canvasW + UNMATCHED_X} y={(boxes.get(edge.fromPageId)?.y ?? 0) + NODE_H / 2} className="ec-route-graph__unmatched-text">
                未匹配
              </text>
            </g>
          ))}
      </svg>

      {pages.map((page) => {
        const box = boxes.get(page.id);
        if (!box) return null;
        return (
          <div
            key={page.id}
            className="ec-route-graph__node"
            data-page-id={page.id}
            style={{ left: box.x, top: box.y, width: NODE_W, height: NODE_H }}
            title={`${page.name}（${page.route}）`}
          >
            <span className="ec-route-graph__node-name">{page.name}</span>
            <span className="ec-route-graph__node-route">{page.route}</span>
          </div>
        );
      })}

      {editingEdge && (
        <RouteEditor
          edge={editingEdge}
          pages={pages}
          onClose={() => setEditingEdge(null)}
          onSave={(patch) =>
            onUpdateAction(editingEdge.fromPageId, editingEdge.eventId, editingEdge.actionId, patch)
          }
        />
      )}
    </div>
  );
}
