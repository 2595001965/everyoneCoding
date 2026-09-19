import type {
  ReactElement,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';
import { useId, useRef, useState } from 'react';
import type { SplitModel, SplitNodeData } from '@ec/pipeline';

export interface SplitGraphProps {
  /** 拆分模型（可变的图模型，渲染时直接读取 graphRef） */
  model: SplitModel;
  /** 高亮的节点 id（如影响面评估命中节点） */
  highlightedIds?: string[] | undefined;
  /** 节点点击回调 */
  onNodeClick?: ((id: string) => void) | undefined;
}

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  kind: SplitNodeData['kind'];
  name: string;
}

interface LayoutEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const NODE_W = 150;
const NODE_H = 46;
const GAP_X = 28;
const LAYER_GAP = 110;
const PAD = 36;

/** 文本截断（避免长名称溢出节点） */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 按拓扑序松弛计算层（最长路径深度），兼容有环图（限迭代次数防死循环） */
function buildLayout(model: SplitModel): {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
} {
  const graph = model.graphRef();
  const ids = graph.nodeIds();
  const edgesRaw = graph.edges();

  const depth = new Map<string, number>();
  for (const id of ids) depth.set(id, 0);
  for (let iter = 0; iter < ids.length + 1; iter++) {
    for (const e of edgesRaw) {
      const dTo = depth.get(e.to) ?? 0;
      const dFrom = depth.get(e.from) ?? 0;
      if (dFrom < dTo + 1) depth.set(e.from, dTo + 1);
    }
  }

  const layers = new Map<number, string[]>();
  let maxLayer = 0;
  for (const id of ids) {
    const d = depth.get(id) ?? 0;
    if (d > maxLayer) maxLayer = d;
    const arr = layers.get(d) ?? [];
    arr.push(id);
    layers.set(d, arr);
  }

  const layerCount = maxLayer + 1;
  let maxPerLayer = 1;
  for (const arr of layers.values()) maxPerLayer = Math.max(maxPerLayer, arr.length);
  const widthPerLayer = maxPerLayer * NODE_W + (maxPerLayer - 1) * GAP_X;

  const coords = new Map<string, { x: number; y: number }>();
  for (let layer = 0; layer <= maxLayer; layer++) {
    const arr = layers.get(layer) ?? [];
    const layerWidth = arr.length * NODE_W + (arr.length - 1) * GAP_X;
    const offsetX = (widthPerLayer - layerWidth) / 2;
    arr.forEach((id, idx) => {
      coords.set(id, { x: PAD + offsetX + idx * (NODE_W + GAP_X), y: PAD + layer * LAYER_GAP });
    });
  }

  const nodes: LayoutNode[] = ids.map((id) => {
    const c = coords.get(id) ?? { x: PAD, y: PAD };
    const data = graph.nodeData(id);
    return { id, x: c.x, y: c.y, kind: data?.kind ?? 'page', name: data?.name ?? id };
  });

  const edges: LayoutEdge[] = edgesRaw.map((e) => {
    const f = coords.get(e.from) ?? { x: PAD, y: PAD };
    const t = coords.get(e.to) ?? { x: PAD, y: PAD };
    return {
      from: e.from,
      to: e.to,
      x1: f.x + NODE_W / 2,
      y1: f.y,
      x2: t.x + NODE_W / 2,
      y2: t.y + NODE_H,
    };
  });

  return {
    nodes,
    edges,
    width: widthPerLayer + PAD * 2,
    height: layerCount * LAYER_GAP + PAD * 2,
  };
}

/** S4 拆分 DAG 自绘可视化（分层布局 + 缩放/平移 + 环高亮） */
export function SplitGraph({ model, highlightedIds, onNodeClick }: SplitGraphProps): ReactElement {
  const [transform, setTransform] = useState<{ x: number; y: number; scale: number }>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );
  const rawId = useId();
  const arrowId = `ec-split-arrow${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const { nodes, edges, width, height } = buildLayout(model);
  const cycleIds = new Set(model.detectCycles().flat());
  const hiSet = highlightedIds !== undefined ? new Set(highlightedIds) : null;

  const handleWheel = (e: ReactWheelEvent<SVGSVGElement>): void => {
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setTransform((t) => ({ ...t, scale: Math.min(3, Math.max(0.2, t.scale * factor)) }));
  };

  const handlePointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: transform.x,
      baseY: transform.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    setTransform((t) => ({
      ...t,
      x: drag.baseX + (e.clientX - drag.startX),
      y: drag.baseY + (e.clientY - drag.startY),
    }));
  };

  const handlePointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    dragRef.current = null;
    if (typeof e.currentTarget.releasePointerCapture === 'function') {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const zoomBy = (factor: number): void => {
    setTransform((t) => ({ ...t, scale: Math.min(3, Math.max(0.2, t.scale * factor)) }));
  };

  const resetView = (): void => setTransform({ x: 0, y: 0, scale: 1 });

  return (
    <div className="ec-pipe-split" style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', right: 8, top: 8, zIndex: 1, display: 'flex', gap: 4 }}>
        <button
          type="button"
          className="ec-pipe-split__zoom"
          onClick={() => zoomBy(1.2)}
          aria-label="放大"
        >
          ＋
        </button>
        <button
          type="button"
          className="ec-pipe-split__zoom"
          onClick={() => zoomBy(0.8)}
          aria-label="缩小"
        >
          －
        </button>
        <button
          type="button"
          className="ec-pipe-split__zoom"
          onClick={resetView}
          aria-label="重置视图"
        >
          ⟲
        </button>
      </div>
      <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
        <svg
          width={width}
          height={height}
          className="ec-pipe-split__svg"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          style={{
            cursor: dragRef.current !== null ? 'grabbing' : 'grab',
            display: 'block',
            userSelect: 'none',
          }}
        >
          <defs>
            <marker
              id={arrowId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
            </marker>
          </defs>
          <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
            {edges.map((e, i) => (
              <line
                key={`${e.from}->${e.to}-${i}`}
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke="#94a3b8"
                strokeWidth={1.5}
                markerEnd={`url(#${arrowId})`}
              />
            ))}
            {nodes.map((n) => {
              const isCycle = cycleIds.has(n.id);
              const isHi = hiSet !== null && hiSet.has(n.id);
              const fill = n.kind === 'feature' ? '#2563eb' : '#0891b2';
              const stroke = isCycle ? '#dc2626' : isHi ? '#f59e0b' : 'transparent';
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x}, ${n.y})`}
                  onClick={() => onNodeClick?.(n.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={6}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isCycle || isHi ? 3 : 0}
                  />
                  <text x={10} y={20} fill="#fff" fontSize={12} fontWeight={600}>
                    {truncate(n.name, 16)}
                  </text>
                  <text x={10} y={36} fill="rgba(255,255,255,0.85)" fontSize={10}>
                    {n.kind === 'feature' ? '功能' : '页面'}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
