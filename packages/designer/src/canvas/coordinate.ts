/**
 * 画布坐标系（T3-02 要点 2）。
 *
 * 屏幕坐标（viewport / 屏幕像素）与画布坐标（设计稿像素，未缩放）的双向转换。
 * 变换链：screen = canvas * zoom + origin + pan；canvas = (screen - origin - pan) / zoom。
 *
 * 纯函数 + 工厂，不依赖 React / DOM，可在 node 环境测试。
 */

/** 缩放范围：25% ~ 400% */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CoordinateSpaceConfig {
  zoom: number;
  /** 平移量（屏幕像素） */
  panX: number;
  panY: number;
  /** 画布原点在屏幕中的偏移（屏幕像素），默认 0 */
  originX?: number;
  originY?: number;
}

export interface CoordinateSpace {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
  readonly originX: number;
  readonly originY: number;
  /** 屏幕坐标 → 画布坐标 */
  toCanvas(point: Point): Point;
  /** 画布坐标 → 屏幕坐标 */
  toScreen(point: Point): Point;
  /** 屏幕矩形 → 画布矩形（含宽高，已按 zoom 还原） */
  toCanvasRect(rect: Rect): Rect;
  /** 屏幕位移（px）→ 画布位移（已除 zoom） */
  scaleDelta(delta: number): number;
}

/** 将缩放钳制在 [25%, 400%] */
export function clampZoom(zoom: number): number {
  if (Number.isNaN(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * 以屏幕指针为锚点缩放：缩放后指针下方的画布点保持不动。
 * 返回新的 pan，调用方据此更新 transform。保证 zoom 在 [25%,400%]，无错位。
 */
export function zoomAtPoint(
  zoom: number,
  nextZoom: number,
  pointer: Point,
  pan: Point,
  origin: Point = { x: 0, y: 0 },
): Point {
  const safeNext = clampZoom(nextZoom);
  const canvasX = (pointer.x - pan.x - origin.x) / zoom;
  const canvasY = (pointer.y - pan.y - origin.y) / zoom;
  return {
    x: pointer.x - origin.x - canvasX * safeNext,
    y: pointer.y - origin.y - canvasY * safeNext,
  };
}

/** 创建坐标空间（不可变快照，调用方持有最新配置以重算） */
export function createCoordinateSpace(config: CoordinateSpaceConfig): CoordinateSpace {
  const zoom = clampZoom(config.zoom);
  const originX = config.originX ?? 0;
  const originY = config.originY ?? 0;
  return {
    zoom,
    panX: config.panX,
    panY: config.panY,
    originX,
    originY,
    toCanvas(point) {
      return {
        x: (point.x - this.panX - originX) / zoom,
        y: (point.y - this.panY - originY) / zoom,
      };
    },
    toScreen(point) {
      return {
        x: point.x * zoom + originX + this.panX,
        y: point.y * zoom + originY + this.panY,
      };
    },
    toCanvasRect(rect) {
      return {
        x: (rect.x - this.panX - originX) / zoom,
        y: (rect.y - this.panY - originY) / zoom,
        width: rect.width / zoom,
        height: rect.height / zoom,
      };
    },
    scaleDelta(delta) {
      return delta / zoom;
    },
  };
}
