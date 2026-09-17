import { describe, expect, it } from 'vitest';

import { ZOOM_MAX, ZOOM_MIN, clampZoom, createCoordinateSpace, zoomAtPoint } from '../coordinate';

describe('T3-02 坐标系统', () => {
  it('屏幕坐标 ↔ 画布坐标双向转换（含缩放与平移）', () => {
    const space = createCoordinateSpace({ zoom: 2, panX: 100, panY: 50 });
    expect(space.toScreen({ x: 10, y: 10 })).toEqual({ x: 120, y: 70 });
    expect(space.toCanvas({ x: 120, y: 70 })).toEqual({ x: 10, y: 10 });
  });

  it('含原点偏移时变换仍自洽', () => {
    const space = createCoordinateSpace({ zoom: 1.5, panX: -40, panY: 20, originX: 18, originY: 18 });
    const screen = space.toScreen({ x: 200, y: 300 });
    expect(space.toCanvas(screen)).toEqual({ x: 200, y: 300 });
  });

  it('25% ~ 400% 全量程往返无错位', () => {
    for (const zoom of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]) {
      const space = createCoordinateSpace({ zoom, panX: 37, panY: -19 });
      for (const point of [{ x: 0, y: 0 }, { x: 640, y: 480 }, { x: 1919, y: 1079 }]) {
        const back = space.toCanvas(space.toScreen(point));
        expect(back.x).toBeCloseTo(point.x, 9);
        expect(back.y).toBeCloseTo(point.y, 9);
      }
    }
  });

  it('矩形转换按缩放还原宽高', () => {
    const space = createCoordinateSpace({ zoom: 2, panX: 0, panY: 0 });
    expect(space.toCanvasRect({ x: 20, y: 40, width: 100, height: 50 })).toEqual({ x: 10, y: 20, width: 50, height: 25 });
  });

  it('scaleDelta 把屏幕位移换算为画布位移', () => {
    const space = createCoordinateSpace({ zoom: 2, panX: 0, panY: 0 });
    expect(space.scaleDelta(30)).toBe(15);
  });

  it('缩放钳制在 25%~400%', () => {
    expect(ZOOM_MIN).toBe(0.25);
    expect(ZOOM_MAX).toBe(4);
    expect(clampZoom(0.01)).toBe(0.25);
    expect(clampZoom(10)).toBe(4);
    expect(clampZoom(1.75)).toBe(1.75);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('以指针为锚点缩放：指针下的画布点保持不动（25%~400% 无错位）', () => {
    for (const nextZoom of [0.25, 0.5, 1, 2, 4]) {
      const zoom = 1;
      const pan = { x: 120, y: 80 };
      const pointer = { x: 500, y: 320 };
      const before = createCoordinateSpace({ zoom, panX: pan.x, panY: pan.y }).toCanvas(pointer);
      const nextPan = zoomAtPoint(zoom, nextZoom, pointer, pan, { x: 0, y: 0 });
      const after = createCoordinateSpace({ zoom: nextZoom, panX: nextPan.x, panY: nextPan.y }).toCanvas(pointer);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });

  it('锚点缩放把超范围缩放钳制在 400%，且锚点仍不动', () => {
    const pointer = { x: 300, y: 200 };
    const nextPan = zoomAtPoint(1, 99, pointer, { x: 0, y: 0 });
    const space = createCoordinateSpace({ zoom: clampZoom(99), panX: nextPan.x, panY: nextPan.y });
    expect(space.zoom).toBe(ZOOM_MAX);
    const before = createCoordinateSpace({ zoom: 1, panX: 0, panY: 0 }).toCanvas(pointer);
    expect(space.toCanvas(pointer)).toEqual(before);
  });
});
