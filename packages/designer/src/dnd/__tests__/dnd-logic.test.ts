import { describe, expect, it } from 'vitest';

import type { Rect } from '../../canvas/coordinate';
import { INSIDE_MARGIN, computeInsertion, type CollisionTarget } from '../collision';
import { LAYOUT_MODES, convertLayout, insertIndexFor, layoutModeOf } from '../layout-modes';
import { SNAP_THRESHOLD, computeSnap, snapToGrid } from '../snapping';
import { createElement } from '../../dsl/factory';

const target = (over: Partial<CollisionTarget> = {}): CollisionTarget => ({
  id: 'card',
  rect: { x: 100, y: 100, width: 200, height: 100 },
  acceptsChildren: true,
  parentId: 'root',
  indexInParent: 1,
  ...over,
});

describe('T3-03 碰撞与插入位置判定', () => {
  it('指针落在中央 20% 区域且容器接受子节点 → 嵌套插入（inside）', () => {
    const result = computeInsertion({ pointer: { x: 200, y: 150 }, target: target() });
    expect(result).toEqual({ kind: 'insert', parentId: 'card', index: undefined, position: 'inside' });
  });

  it('指针落在上方 40% 边距带 → 同级前插入（before）', () => {
    const result = computeInsertion({ pointer: { x: 200, y: 110 }, target: target() });
    expect(result).toEqual({ kind: 'insert', parentId: 'root', index: 1, position: 'before' });
  });

  it('指针落在下方 40% 边距带 → 同级后插入（after）', () => {
    const result = computeInsertion({ pointer: { x: 200, y: 190 }, target: target() });
    expect(result).toEqual({ kind: 'insert', parentId: 'root', index: 2, position: 'after' });
  });

  it('不接受子节点的组件即使指针在中央也退化为同级插入', () => {
    const result = computeInsertion({ pointer: { x: 200, y: 150 }, target: target({ acceptsChildren: false }) });
    expect(result.kind).toBe('insert');
    if (result.kind === 'insert') expect(result.position).not.toBe('inside');
  });

  it('横向流容器按 x 轴判定', () => {
    const row = target({ axis: 'x' });
    expect(computeInsertion({ pointer: { x: 110, y: 150 }, target: row })).toMatchObject({ position: 'before' });
    expect(computeInsertion({ pointer: { x: 290, y: 150 }, target: row })).toMatchObject({ position: 'after' });
    expect(computeInsertion({ pointer: { x: 200, y: 150 }, target: row })).toMatchObject({ position: 'inside' });
  });

  it('指针超出画布 → 拖出删除', () => {
    const canvasRect: Rect = { x: 0, y: 0, width: 500, height: 400 };
    const inside = computeInsertion({ pointer: { x: 200, y: 150 }, target: target(), canvasRect });
    expect(inside.kind).toBe('insert');
    const outside = computeInsertion({ pointer: { x: 900, y: 150 }, target: target(), canvasRect });
    expect(outside).toEqual({ kind: 'delete' });
  });

  it('拒绝拖入自身与自身子树（循环防护）', () => {
    const tree = {
      card: ['box', 'leaf'],
      box: ['leaf'],
      leaf: [],
    } as const;
    const isDescendant = (a: string, d: string): boolean =>
      a === d || (tree[a as keyof typeof tree] ?? []).some((child) => isDescendant(child, d));

    // 自身
    expect(
      computeInsertion({ pointer: { x: 200, y: 150 }, target: target({ id: 'card' }), draggedId: 'card', isDescendant }),
    ).toEqual({ kind: 'none' });
    // 自身子树
    expect(
      computeInsertion({ pointer: { x: 200, y: 150 }, target: target({ id: 'box' }), draggedId: 'card', isDescendant }),
    ).toEqual({ kind: 'none' });
    // 同级插入也不允许把祖先塞进自己的后代里
    expect(
      computeInsertion({ pointer: { x: 200, y: 110 }, target: target({ id: 'leaf' }), draggedId: 'card', isDescendant }),
    ).toEqual({ kind: 'none' });
    // 正常拖拽不受影响
    expect(
      computeInsertion({ pointer: { x: 200, y: 110 }, target: target({ id: 'leaf' }), draggedId: 'other', isDescendant }),
    ).toMatchObject({ kind: 'insert' });
  });

  it('边距带占比常量符合任务卡（每侧 40%）', () => {
    expect(INSIDE_MARGIN).toBe(0.4);
  });
});

describe('T3-03 吸附与对齐参考线', () => {
  it('8px 栅格吸附默认开启，可关闭', () => {
    expect(snapToGrid(13)).toBe(16);
    expect(snapToGrid(11)).toBe(8);
    expect(snapToGrid(13, 8, false)).toBe(13);
    expect(snapToGrid(Number.NaN)).toBeNaN();
  });

  it('吸附阈值常量为 4px', () => {
    expect(SNAP_THRESHOLD).toBe(4);
  });

  it('相邻元素六向对齐：左 / 右 / 水平中心 / 上 / 下 / 垂直中心', () => {
    const peers: Rect[] = [{ x: 100, y: 200, width: 80, height: 40 }];

    // 左对齐（候选左边缘 2px 内 → 吸附到 100）
    const left = computeSnap({ x: 102, y: 0, width: 50, height: 20 }, peers, { snapToGridEnabled: false });
    expect(left.dx).toBe(-2);
    expect(left.guides).toContainEqual({ axis: 'x', position: 100, kind: 'element' });

    // 右对齐（候选右边缘贴近 180）
    const right = computeSnap({ x: 132, y: 0, width: 50, height: 20 }, peers, { snapToGridEnabled: false });
    expect(right.x + 50).toBe(180);

    // 水平中心对齐（候选中心贴近 140）
    const centerX = computeSnap({ x: 113, y: 0, width: 50, height: 20 }, peers, { snapToGridEnabled: false });
    expect(centerX.x + 25).toBe(140);

    // 顶部对齐 / 底部对齐 / 垂直中心
    const top = computeSnap({ x: 0, y: 202, width: 20, height: 20 }, peers, { snapToGridEnabled: false });
    expect(top.y).toBe(200);
    const bottom = computeSnap({ x: 0, y: 218, width: 20, height: 20 }, peers, { snapToGridEnabled: false });
    expect(bottom.y + 20).toBe(240);
    const centerY = computeSnap({ x: 0, y: 208, width: 20, height: 20 }, peers, { snapToGridEnabled: false });
    expect(centerY.y + 10).toBe(220);
  });

  it('超过阈值不吸附，但栅格吸附仍生效（默认开启）', () => {
    const peers: Rect[] = [{ x: 100, y: 200, width: 80, height: 40 }];
    const result = computeSnap({ x: 300, y: 17, width: 20, height: 20 }, peers, { snapToGridEnabled: true });
    expect(result.guides).toHaveLength(0);
    expect(result.x).toBe(304); // 300 → 8px 栅格
    expect(result.y).toBe(16);
  });

  it('画布边界与中心可作为参考线来源', () => {
    const result = computeSnap({ x: 2, y: 2, width: 40, height: 40 }, [], {
      canvasWidth: 360,
      canvasHeight: 800,
      snapToGridEnabled: false,
    });
    expect(result.guides.some((guide) => guide.kind === 'canvas')).toBe(true);
  });

  it('返回的 dx/dy 与吸附后坐标自洽', () => {
    const peers: Rect[] = [{ x: 100, y: 100, width: 50, height: 50 }];
    const candidate: Rect = { x: 101, y: 99, width: 30, height: 30 };
    const result = computeSnap(candidate, peers, { snapToGridEnabled: false });
    expect(result.dx).toBeCloseTo(result.x - candidate.x, 9);
    expect(result.dy).toBeCloseTo(result.y - candidate.y, 9);
  });
});

describe('T3-03 布局模式', () => {
  it('支持绝对定位与流式两种模式，可从 style 推断', () => {
    expect(LAYOUT_MODES).toEqual(['absolute', 'flow']);
    expect(layoutModeOf(createElement({ id: 'a', type: 'Container' }))).toBe('absolute');
    expect(layoutModeOf(createElement({ id: 'b', type: 'Container', style: { display: 'flex' } }))).toBe('flow');
    expect(layoutModeOf(createElement({ id: 'c', type: 'Container', style: { display: 'grid' } }))).toBe('flow');
  });

  it('插入位置 → children 下标换算', () => {
    expect(insertIndexFor('before', { siblingCount: 3, referenceIndex: 1 })).toBe(1);
    expect(insertIndexFor('after', { siblingCount: 3, referenceIndex: 1 })).toBe(2);
    expect(insertIndexFor('inside', { siblingCount: 3 })).toBe(3);
    expect(insertIndexFor('before', { siblingCount: 3 })).toBe(0);
    expect(insertIndexFor('after', { siblingCount: 3 })).toBe(3);
  });

  it('absolute → flow：容器转 flex、清除子节点定位，且不修改入参', () => {
    const node = createElement({
      id: 'box',
      type: 'Container',
      style: { position: 'absolute', left: 10, top: 20 },
      children: [createElement({ id: 'child', type: 'Text', style: { position: 'absolute', left: 5, top: 6 } })],
    });
    const converted = convertLayout(node, 'absolute', 'flow');
    expect(converted.style).toMatchObject({ display: 'flex', flexDirection: 'column' });
    expect(converted.style?.['position']).toBeUndefined();
    expect(converted.children?.[0]?.style).not.toHaveProperty('position');
    expect(converted.children?.[0]?.style).not.toHaveProperty('left');
    // 原节点未被改动
    expect(node.style).toMatchObject({ position: 'absolute', left: 10 });
    expect(node.children?.[0]?.style).toMatchObject({ position: 'absolute', left: 5 });
  });

  it('flow → absolute：子节点改为绝对定位并保留原有 left/top', () => {
    const node = createElement({
      id: 'box',
      type: 'Container',
      style: { display: 'flex', flexDirection: 'row' },
      children: [
        createElement({ id: 'a', type: 'Text', style: { left: 12, top: 8 } }),
        createElement({ id: 'b', type: 'Text' }),
      ],
    });
    const converted = convertLayout(node, 'flow', 'absolute');
    expect(converted.style?.['display']).toBeUndefined();
    expect(converted.style?.['position']).toBe('relative');
    expect(converted.children?.[0]?.style).toMatchObject({ position: 'absolute', left: 12, top: 8 });
    expect(converted.children?.[1]?.style).toMatchObject({ position: 'absolute', left: 0, top: 0 });
  });

  it('同模式切换为无操作（返回原引用）', () => {
    const node = createElement({ id: 'box', type: 'Container' });
    expect(convertLayout(node, 'flow', 'flow')).toBe(node);
  });
});
