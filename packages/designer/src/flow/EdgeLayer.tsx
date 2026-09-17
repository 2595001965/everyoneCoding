/**
 * 连线层（T3-09）：自绘 SVG 连线，不引第三方图库。
 * - next：实线；
 * - branchTrue：绿色虚线并标注「真」；
 * - branchFalse：红色虚线并标注「假」。
 */

import type * as React from 'react';

import type { FlowNode } from './flow-schema';

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 64;

export type OutPort = 'next' | 'true' | 'false';

export interface Point {
  x: number;
  y: number;
}

export type NodePositions = Record<string, Point>;

/** 计算某节点的端口坐标（输入口在左中，输出口在右中 / 分支上下分布） */
export function portPoint(id: string, port: 'in' | OutPort, positions: NodePositions): Point | null {
  const pos = positions[id];
  if (!pos) return null;
  switch (port) {
    case 'in':
      return { x: pos.x, y: pos.y + NODE_HEIGHT / 2 };
    case 'next':
      return { x: pos.x + NODE_WIDTH, y: pos.y + NODE_HEIGHT / 2 };
    case 'true':
      return { x: pos.x + NODE_WIDTH, y: pos.y + NODE_HEIGHT * 0.34 };
    case 'false':
      return { x: pos.x + NODE_WIDTH, y: pos.y + NODE_HEIGHT * 0.66 };
  }
}

interface EdgeSpec {
  from: string;
  to: string;
  port: OutPort;
}

function collectEdges(nodes: readonly FlowNode[]): EdgeSpec[] {
  const edges: EdgeSpec[] = [];
  for (const node of nodes) {
    if (node.next) edges.push({ from: node.id, to: node.next, port: 'next' });
    if (node.branchTrue) edges.push({ from: node.id, to: node.branchTrue, port: 'true' });
    if (node.branchFalse) edges.push({ from: node.id, to: node.branchFalse, port: 'false' });
  }
  return edges;
}

export interface EdgeLayerProps {
  nodes: readonly FlowNode[];
  positions: NodePositions;
  width: number;
  height: number;
  /** 连线中的临时落点（拖拽连接时绘制） */
  tempEnd?: Point | null;
  /** 连线起点（拖拽连接时绘制） */
  tempStart?: Point | null;
}

export function EdgeLayer(props: EdgeLayerProps): React.ReactElement {
  const { nodes, positions, width, height, tempEnd, tempStart } = props;
  const edges = collectEdges(nodes);

  const renderEdge = (edge: EdgeSpec, key: string): React.ReactNode => {
    const start = portPoint(edge.from, edge.port, positions);
    const end = portPoint(edge.to, 'in', positions);
    if (!start || !end) return null;
    const midX = (start.x + end.x) / 2;
    const path = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}`;
    const isBranch = edge.port !== 'next';
    const color = edge.port === 'true' ? '#2f9e44' : edge.port === 'false' ? '#e03131' : '#868e96';
    const label = edge.port === 'true' ? '真' : edge.port === 'false' ? '假' : '';
    return (
      <g key={key}>
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeDasharray={isBranch ? '6 4' : undefined}
          data-testid={`edge-${edge.from}-${edge.port}`}
        />
        {label && (
          <text x={midX} y={(start.y + end.y) / 2 - 4} fill={color} fontSize={12} textAnchor="middle">
            {label}
          </text>
        )}
      </g>
    );
  };

  return (
    <svg
      width={width}
      height={height}
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' }}
      aria-hidden="true"
    >
      {edges.map((edge, index) => renderEdge(edge, `e-${index}`))}
      {tempStart && tempEnd && (
        <path
          d={`M ${tempStart.x} ${tempStart.y} L ${tempEnd.x} ${tempEnd.y}`}
          fill="none"
          stroke="#1971c2"
          strokeWidth={2}
          strokeDasharray="4 4"
        />
      )}
    </svg>
  );
}
