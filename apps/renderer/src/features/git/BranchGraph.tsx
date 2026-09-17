/**
 * 提交图（T6-03 要点 2）：用 `buildBranchGraph` 的输出内联画 SVG。
 *
 * 布局规则（纯计算，便于测试断言）：
 * - 列 x 由 `node.lane` 决定：x = left + lane * laneWidth；
 * - 行 y 由节点在 `graph.nodes` 中的顺序决定：y = top + index * rowHeight；
 * - 每个父提交画一条边（`data-testid="graph-edge"`），合并提交因此有 2+ 条；
 * - HEAD 标记、分支标签、tag 用 `<text>` 就近绘制，不引任何图表库。
 */
import type { BranchGraph as BranchGraphModel, BranchNode } from '@ec/git';

export interface BranchGraphProps {
  graph: BranchGraphModel;
  /** 行高（px），默认 28 */
  rowHeight?: number;
  /** 泳道宽（px），默认 36 */
  laneWidth?: number;
  /** 选中提交（高亮） */
  selectedSha?: string | null;
  onSelect?: (sha: string) => void;
}

const DEFAULT_ROW = 28;
const DEFAULT_LANE = 36;
const LEFT = 24;
const TOP = 16;

export function BranchGraph({
  graph,
  rowHeight = DEFAULT_ROW,
  laneWidth = DEFAULT_LANE,
  selectedSha = null,
  onSelect,
}: BranchGraphProps): JSX.Element {
  const rowCount = Math.max(1, graph.nodes.length);
  const laneCount = Math.max(1, graph.lanes);

  const width = LEFT * 2 + laneCount * laneWidth + 220;
  const height = TOP * 2 + rowCount * rowHeight;

  const indexBySha = new Map(graph.nodes.map((node, index) => [node.sha, index]));
  const xOf = (lane: number): number => LEFT + lane * laneWidth;
  const yOf = (index: number): number => TOP + index * rowHeight;

  return (
    <div className="ec-branch-graph" style={{ overflow: 'auto', maxHeight: 520 }}>
      {graph.nodes.length === 0 ? (
        <span role="status">暂无提交。</span>
      ) : (
        <svg
          className="ec-branch-graph__svg"
          data-testid="branch-graph"
          role="img"
          aria-label={`提交图（${graph.nodes.length} 个提交，${graph.lanes} 条泳道）`}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
        >
          {/* 泳道参考线：一条竖线代表一条泳道 */}
          {Array.from({ length: laneCount }, (_, lane) => (
            <line
              key={`lane-${lane}`}
              data-testid="graph-lane"
              x1={xOf(lane)}
              y1={TOP}
              x2={xOf(lane)}
              y2={height - TOP}
              stroke="var(--ec-color-border)"
              strokeWidth={1}
            />
          ))}

          {/* 父边：先画边后画点，点压在线上 */}
          {graph.nodes.flatMap((node, index) =>
            node.parents.flatMap((parent) => {
              const parentIndex = indexBySha.get(parent.sha);
              if (parentIndex === undefined) return [];
              const x1 = xOf(node.lane);
              const y1 = yOf(index);
              const x2 = xOf(parent.lane);
              const y2 = yOf(parentIndex);
              const midY = (y1 + y2) / 2;
              return [
                <path
                  key={`edge-${node.sha}-${parent.sha}`}
                  data-testid="graph-edge"
                  data-from={node.sha}
                  data-to={parent.sha}
                  d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                  fill="none"
                  stroke={node.isMerge ? 'var(--ec-color-warning)' : 'var(--ec-color-info)'}
                  strokeWidth={node.isMerge ? 2 : 1.5}
                />,
              ];
            }),
          )}

          {/* 提交点 + 标签 */}
          {graph.nodes.map((node, index) => (
            <CommitMark
              key={node.sha}
              node={node}
              cx={xOf(node.lane)}
              cy={yOf(index)}
              selected={selectedSha === node.sha}
              {...(onSelect !== undefined ? { onSelect } : {})}
            />
          ))}
        </svg>
      )}
    </div>
  );
}

function CommitMark({
  node,
  cx,
  cy,
  selected,
  onSelect,
}: {
  node: BranchNode;
  cx: number;
  cy: number;
  selected: boolean;
  onSelect?: (sha: string) => void;
}): JSX.Element {
  const fill = node.isHead ? 'var(--ec-color-primary)' : node.isMerge ? 'var(--ec-color-warning)' : 'var(--ec-color-info)';
  return (
    <g
      className="ec-branch-graph__node"
      data-testid="graph-node"
      data-sha={node.sha}
      data-lane={node.lane}
      onClick={onSelect !== undefined ? () => onSelect(node.sha) : undefined}
      style={{ cursor: onSelect !== undefined ? 'pointer' : 'default' }}
    >
      {/* 点击热区，避免只点中 4px 的小圆 */}
      <circle cx={cx} cy={cy} r={12} fill="transparent" />
      <circle
        cx={cx}
        cy={cy}
        r={selected ? 7 : 5}
        fill={fill}
        stroke={selected ? 'var(--ec-color-text)' : 'none'}
        strokeWidth={selected ? 2 : 0}
      />

      {node.isHead && (
        <text
          x={cx - 12}
          y={cy + 4}
          textAnchor="end"
          fontSize={10}
          fontWeight={700}
          fill="var(--ec-color-primary)"
          data-testid="graph-head"
        >
          HEAD
        </text>
      )}

      {node.branches.map((branch, branchIndex) => (
        <text
          key={`b-${branch}`}
          x={cx + 14}
          y={cy + 4 - branchIndex * 12}
          fontSize={11}
          fill="var(--ec-color-text)"
          data-testid="graph-branch-label"
        >
          {branch}
        </text>
      ))}

      {node.tags.map((tag) => (
        <text
          key={`t-${tag}`}
          x={cx + 14}
          y={cy - 8}
          fontSize={10}
          fill="var(--ec-color-warning)"
          data-testid="graph-tag"
        >
          #{tag}
        </text>
      ))}

      <text x={cx + 120} y={cy + 4} fontSize={11} fill="var(--ec-color-text-secondary)" data-testid="graph-subject">
        {truncate(node.subject, 32)}
      </text>
    </g>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 导出内部几何常量，便于测试按同一口径断言坐标 */
export const BRANCH_GRAPH_GEOMETRY = {
  rowHeight: DEFAULT_ROW,
  laneWidth: DEFAULT_LANE,
  left: LEFT,
  top: TOP,
} as const;
