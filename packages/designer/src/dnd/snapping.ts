/**
 * 拖拽吸附（T3-03 要点 3）。
 *
 * 8px 栅格吸附 + 相邻元素对齐参考线（左/右/上/下/水平中心/垂直中心），吸附阈值 4px。
 * 全纯函数，可在 node 环境直接测试。
 */
import { GRID_SIZE, type AlignmentGuide } from '../canvas/GridOverlay';
import type { Rect } from '../canvas/coordinate';

/** 吸附阈值（画布坐标系 px） */
export const SNAP_THRESHOLD = 4;

/** 把值吸附到栅格 */
export function snapToGrid(
  value: number,
  size: number = GRID_SIZE,
  enabled: boolean = true,
): number {
  if (!enabled) return value;
  if (!Number.isFinite(value)) return value;
  return Math.round(value / size) * size;
}

export interface SnapOptions {
  /** 吸附阈值，默认 4px */
  threshold?: number;
  /** 栅格尺寸，默认 8px */
  gridSize?: number;
  /** 是否启用栅格吸附，默认 true */
  snapToGridEnabled?: boolean;
  /** 画布宽度（用于画布中心 / 边缘参考线） */
  canvasWidth?: number;
  /** 画布高度 */
  canvasHeight?: number;
}

export interface SnapResult {
  /** 吸附后的左上角 x */
  x: number;
  /** 吸附后的左上角 y */
  y: number;
  /** 相对候选框的横向偏移 dx = x - candidate.x */
  dx: number;
  /** 相对候选框的纵向偏移 dy = y - candidate.y */
  dy: number;
  /** 命中的对齐参考线 */
  guides: AlignmentGuide[];
}

/**
 * 计算候选框相对 peers（同级元素矩形）与画布边界的吸附结果。
 * 优先取偏移量最小的参考线（元素对齐优先于画布对齐）。
 */
export function computeSnap(candidate: Rect, peers: Rect[], options: SnapOptions = {}): SnapResult {
  const threshold = options.threshold ?? SNAP_THRESHOLD;
  const grid = options.gridSize ?? GRID_SIZE;
  const useGrid = options.snapToGridEnabled ?? true;

  let dx = 0;
  let dy = 0;
  const guides: AlignmentGuide[] = [];

  const cLeft = candidate.x;
  const cRight = candidate.x + candidate.width;
  const cCx = candidate.x + candidate.width / 2;
  const cTop = candidate.y;
  const cBottom = candidate.y + candidate.height;
  const cCy = candidate.y + candidate.height / 2;

  // 候选框可对齐的垂直线来源（x 轴）
  const verticalSources: { from: number; offset: number }[] = [
    { from: cLeft, offset: 0 },
    { from: cRight, offset: -candidate.width },
    { from: cCx, offset: -candidate.width / 2 },
  ];
  // 候选框可对齐的水平线来源（y 轴）
  const horizontalSources: { from: number; offset: number }[] = [
    { from: cTop, offset: 0 },
    { from: cBottom, offset: -candidate.height },
    { from: cCy, offset: -candidate.height / 2 },
  ];

  const peerLinesX: { value: number; kind: AlignmentGuide['kind'] }[] = [];
  const peerLinesY: { value: number; kind: AlignmentGuide['kind'] }[] = [];
  for (const peer of peers) {
    peerLinesX.push(
      { value: peer.x, kind: 'element' },
      { value: peer.x + peer.width, kind: 'element' },
      { value: peer.x + peer.width / 2, kind: 'element' },
    );
    peerLinesY.push(
      { value: peer.y, kind: 'element' },
      { value: peer.y + peer.height, kind: 'element' },
      { value: peer.y + peer.height / 2, kind: 'element' },
    );
  }
  if (options.canvasWidth !== undefined) {
    peerLinesX.push(
      { value: 0, kind: 'canvas' },
      { value: options.canvasWidth, kind: 'canvas' },
      { value: options.canvasWidth / 2, kind: 'canvas' },
    );
  }
  if (options.canvasHeight !== undefined) {
    peerLinesY.push(
      { value: 0, kind: 'canvas' },
      { value: options.canvasHeight, kind: 'canvas' },
      { value: options.canvasHeight / 2, kind: 'canvas' },
    );
  }

  let bestX: { offset: number; guide: number; kind: AlignmentGuide['kind'] } | null = null;
  for (const source of verticalSources) {
    for (const line of peerLinesX) {
      const diff = line.value - source.from;
      if (
        Math.abs(diff) <= threshold &&
        (bestX === null || Math.abs(diff) < Math.abs(bestX.offset))
      ) {
        bestX = { offset: diff, guide: line.value, kind: line.kind };
      }
    }
  }
  if (bestX) {
    dx = bestX.offset;
    guides.push({ axis: 'x', position: bestX.guide, kind: bestX.kind });
  }

  let bestY: { offset: number; guide: number; kind: AlignmentGuide['kind'] } | null = null;
  for (const source of horizontalSources) {
    for (const line of peerLinesY) {
      const diff = line.value - source.from;
      if (
        Math.abs(diff) <= threshold &&
        (bestY === null || Math.abs(diff) < Math.abs(bestY.offset))
      ) {
        bestY = { offset: diff, guide: line.value, kind: line.kind };
      }
    }
  }
  if (bestY) {
    dy = bestY.offset;
    guides.push({ axis: 'y', position: bestY.guide, kind: bestY.kind });
  }

  let x = candidate.x + dx;
  let y = candidate.y + dy;
  if (useGrid) {
    x = snapToGrid(x, grid, true);
    y = snapToGrid(y, grid, true);
  }
  return { x, y, dx: x - candidate.x, dy: y - candidate.y, guides };
}
