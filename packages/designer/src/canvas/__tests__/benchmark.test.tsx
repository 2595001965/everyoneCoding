import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { computeSnap } from '../../dnd/snapping';
import { createLoginPageDsl } from '../../dsl/factory';
import type { ElementNode, PageDsl } from '../../dsl/types';
import type { Rect } from '../coordinate';
import { Canvas, getElementRenderCount, resetElementRenderCount } from '../Canvas';

/**
 * T3-02 性能基准（500 元素页面）。
 *
 * jsdom 无法测真实帧率，因此采用两个**可复现**的量化口径：
 * 1. 单帧几何计算耗时（命中测试邻域 + 8px 吸附 + 六向对齐参考线），
 *    以 16.6ms（60FPS 预算）判定是否达标，并据此换算「可用帧率上限」；
 * 2. 拖拽 / 选中交互期间的**元素重渲染节点数**——优化目标是只重渲染受影响节点，
 *    而不是整棵树（500 个）。
 */

const FRAME_BUDGET_MS = 1000 / 60;

function buildLargePage(count = 500): PageDsl {
  const base = createLoginPageDsl();
  const children: ElementNode[] = [];
  // 根节点 + (count - 1) 个子节点 = count 个元素
  for (let index = 0; index < count - 1; index += 1) {
    children.push({
      id: `n-${index}`,
      type: 'Text',
      name: `节点 ${index}`,
      style: { position: 'absolute', left: (index % 25) * 40, top: Math.floor(index / 25) * 24, width: 36, height: 20 },
    });
  }
  const tree: ElementNode = { id: 'root', type: 'Container', name: '页面', children };
  return { ...base, id: 'perf', name: '性能页', tree };
}

function rectsOf(dsl: PageDsl): Rect[] {
  const out: Rect[] = [];
  const walk = (node: ElementNode): void => {
    const style = (node.style ?? {}) as Record<string, number | undefined>;
    out.push({ x: style.left ?? 0, y: style.top ?? 0, width: style.width ?? 100, height: style.height ?? 40 });
    for (const child of node.children ?? []) walk(child);
  };
  walk(dsl.tree);
  return out;
}

describe('T3-02 性能基准：500 元素页面', () => {
  it('首次渲染 500 个元素；选中变化只重渲染受影响节点', () => {
    const dsl = buildLargePage(500);
    resetElementRenderCount();
    const { rerender } = render(<Canvas dsl={dsl} selectedIds={[]} />);
    const mountRenders = getElementRenderCount();
    expect(mountRenders).toBe(500);

    // 切换选中：目标节点 + 原选中节点
    resetElementRenderCount();
    rerender(<Canvas dsl={dsl} selectedIds={['n-10']} />);
    const selectRenders = getElementRenderCount();

    resetElementRenderCount();
    rerender(<Canvas dsl={dsl} selectedIds={['n-10', 'n-300']} />);
    const addSelectRenders = getElementRenderCount();

    // hover 切换（属于"拖拽期间每帧都在变"的那一类交互）
    resetElementRenderCount();
    rerender(<Canvas dsl={dsl} selectedIds={['n-10', 'n-300']} hoveredId="n-77" />);
    const hoverRenders = getElementRenderCount();

    // eslint-disable-next-line no-console
    console.log(
      `[T3-02 基准] 500 元素：首屏重渲染 ${mountRenders}；单选增量 ${selectRenders}；加选增量 ${addSelectRenders}；hover 增量 ${hoverRenders}`,
    );

    // 根节点因 childrenContent 引用变化重渲染 1 次，其余只为「自身选中态变化」的节点
    expect(selectRenders).toBeLessThanOrEqual(2);
    expect(addSelectRenders).toBeLessThanOrEqual(2);
    expect(hoverRenders).toBeLessThanOrEqual(2);
    // 关键结论：交互增量远小于整树 500，未发生整树重渲染
    expect(hoverRenders).toBeLessThan(500);
  });

  it('单帧几何计算（吸附 + 参考线，500 邻域）在 60FPS 预算内', () => {
    const dsl = buildLargePage(500);
    const peers = rectsOf(dsl);
    const candidate: Rect = { x: 137, y: 251, width: 120, height: 48 };

    const iterations = 200;
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      computeSnap({ ...candidate, x: candidate.x + (index % 3) }, peers, {
        canvasWidth: 1440,
        canvasHeight: 900,
        snapToGridEnabled: true,
      });
    }
    const elapsed = performance.now() - start;
    const perFrame = elapsed / iterations;
    const derivedFps = 1000 / perFrame;

    // eslint-disable-next-line no-console
    console.log(
      `[T3-03 基准] 500 邻域吸附计算：${iterations} 次共 ${elapsed.toFixed(2)}ms，单帧均值 ${perFrame.toFixed(3)}ms，` +
        `按 16.6ms 预算换算可用帧率上限 ≈ ${Math.round(derivedFps)} FPS（jsdom 不含真实合成与绘制）`,
    );

    expect(perFrame).toBeLessThan(FRAME_BUDGET_MS);
  });

  it('8 层嵌套下的吸附计算仍为常数级耗时', () => {
    // 8 层嵌套链（最大允许深度）
    let node: ElementNode = { id: 'deep-7', type: 'Text', style: { left: 0, top: 0, width: 40, height: 20 } };
    for (let level = 6; level >= 0; level -= 1) {
      node = {
        id: `deep-${level}`,
        type: 'Container',
        style: { display: 'flex', flexDirection: 'column' },
        children: [node],
      };
    }
    const dsl: PageDsl = { ...createLoginPageDsl(), tree: node };
    const peers = rectsOf(dsl);
    expect(peers).toHaveLength(8);

    const iterations = 500;
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      computeSnap({ x: index % 10, y: index % 10, width: 40, height: 20 }, peers, { canvasWidth: 360, canvasHeight: 780 });
    }
    const perFrame = (performance.now() - start) / iterations;
    // eslint-disable-next-line no-console
    console.log(`[T3-03 基准] 8 层嵌套吸附：单帧均值 ${perFrame.toFixed(3)}ms`);
    expect(perFrame).toBeLessThan(FRAME_BUDGET_MS);
  });
});
