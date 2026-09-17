import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createLoginPageDsl } from '../../dsl/factory';
import { findById } from '../../dsl/traverse';
import type { Breakpoint } from '../../dsl/types';
import { BreakpointBar } from '../BreakpointBar';
import {
  RESPONSIVE_BREAKPOINTS,
  breakpointKey,
  overridesOf,
  pruneOverrides,
  resolveAllBreakpoints,
  resolveStyleForBreakpoint,
  responsiveStats,
  setBreakpointOverride,
} from '../responsive-rules';

describe('T3-11 响应式断点（只存差异属性）', () => {
  it('断点集合为 1920 / 1440 / 768 / 375', () => {
    expect([...RESPONSIVE_BREAKPOINTS]).toEqual([1920, 1440, 768, 375]);
    expect(RESPONSIVE_BREAKPOINTS.map((item) => breakpointKey(item))).toEqual(['1920', '1440', '768', '375']);
  });

  it('只写入与基线不同的属性', () => {
    const dsl = createLoginPageDsl();
    // el-5 基线 style 里 width 是 400
    const same = setBreakpointOverride(dsl, 'el-5', 768, { width: 400 });
    expect(findById(same.tree, 'el-5')?.responsive).toBeUndefined(); // 与基线相同 → 不产生覆盖

    const diff = setBreakpointOverride(dsl, 'el-5', 768, { width: 320, padding: 16 });
    expect(findById(diff.tree, 'el-5')?.responsive).toEqual({ '768': { width: 320, padding: 16 } });
    // 原对象未被修改
    expect(findById(dsl.tree, 'el-5')?.responsive).toBeUndefined();
  });

  it('传 null 清除该断点覆盖；覆盖清空后移除 responsive 字段', () => {
    const dsl = createLoginPageDsl();
    const one = setBreakpointOverride(dsl, 'el-5', 375, { width: 300 });
    const cleared = setBreakpointOverride(one, 'el-5', 375, null);
    expect(findById(cleared.tree, 'el-5')?.responsive).toBeUndefined();

    const two = setBreakpointOverride(setBreakpointOverride(dsl, 'el-5', 375, { width: 300 }), 'el-5', 768, { width: 320 });
    expect(Object.keys(nodeOf(two, 'el-5').responsive ?? {})).toEqual(['375', '768']);
    const clearedOne = setBreakpointOverride(two, 'el-5', 375, null);
    expect(Object.keys(nodeOf(clearedOne, 'el-5').responsive ?? {})).toEqual(['768']);
  });

  it('合并基线 + 覆盖得到断点样式', () => {
    const dsl = setBreakpointOverride(createLoginPageDsl(), 'el-5', 768, { width: 320 });
    const node = nodeOf(dsl, 'el-5');
    expect(resolveStyleForBreakpoint(node, 1440)).toMatchObject({ width: 400 });
    expect(resolveStyleForBreakpoint(node, 768)).toMatchObject({ width: 320, padding: 32 });
    expect(overridesOf(node, 375)).toEqual({});
  });

  it('resolveAllBreakpoints 输出四个断点的样式表', () => {
    const dsl = setBreakpointOverride(createLoginPageDsl(), 'el-5', 375, { width: 280 });
    const table = resolveAllBreakpoints(nodeOf(dsl, 'el-5'));
    expect(table.map((item) => item.breakpoint)).toEqual([1920, 1440, 768, 375]);
    expect(table.find((item) => item.breakpoint === 375)?.style['width']).toBe(280);
    expect(table.find((item) => item.breakpoint === 1440)?.style['width']).toBe(400);
  });

  it('DSL 体积不随断点数量线性增长（差异存储 vs 全量副本）', () => {
    let dsl = createLoginPageDsl();
    for (const breakpoint of RESPONSIVE_BREAKPOINTS) {
      dsl = setBreakpointOverride(dsl, 'el-5', breakpoint, { width: 300 + breakpoint / 10 });
    }
    const stats = responsiveStats(dsl);

    // eslint-disable-next-line no-console
    console.log(
      `[T3-11 基准] 四个断点全覆盖：实际 DSL ${stats.dslBytes} B；若每断点复制全量元素树需 ${stats.fullCopyBytes} B；` +
        `节省 ${(stats.savingRatio * 100).toFixed(1)}%（覆盖 ${stats.overrideCount} 处 / 差异字段 ${stats.diffFieldCount} 个）`,
    );

    expect(stats.overrideCount).toBe(4);
    expect(stats.diffFieldCount).toBe(4);
    expect(stats.dslBytes).toBeLessThan(stats.fullCopyBytes);
    expect(stats.savingRatio).toBeGreaterThan(0.5);
    // 关键断言：加入 4 个断点后，元素数量没有增加（不产生全量副本）
    const count = (value: typeof dsl): number => {
      let total = 0;
      const walk = (node: typeof dsl.tree): void => {
        total += 1;
        for (const child of node.children ?? []) walk(child);
      };
      walk(value.tree);
      return total;
    };
    expect(count(dsl)).toBe(20);
  });

  it('pruneOverrides 清理空覆盖（导入外部 DSL 后自愈）', () => {
    const dsl = createLoginPageDsl();
    const dirty = {
      ...dsl,
      tree: { ...dsl.tree, responsive: { '768': {}, '375': { width: 200 } } },
    };
    const cleaned = pruneOverrides(dirty);
    expect(findById(cleaned.tree, 'el-1')?.responsive).toEqual({ '375': { width: 200 } });
  });
});

describe('T3-11 断点切换条', () => {
  it('切换断点并通过 radio 语义暴露当前选择', () => {
    const seen: Breakpoint[] = [];
    render(<BreakpointBar value={1440} onChange={(next) => seen.push(next)} />);
    expect(screen.getByTestId('breakpoint-1440')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('breakpoint-375'));
    expect(seen).toEqual([375]);
  });

  it('展示当前元素的断点差异数量并可清除', () => {
    const withOverride = setBreakpointOverride(createLoginPageDsl(), 'el-5', 768, { width: 320 });
    const onChangePage = vi.fn();
    const { rerender } = render(
      <BreakpointBar value={768} onChange={() => undefined} page={withOverride} elementId="el-5" onChangePage={onChangePage} />,
    );
    expect(screen.getByText(/本断点差异 1 项/)).toBeInTheDocument();
    expect(screen.getByTestId('responsive-stats')).toHaveTextContent('差异存储');

    fireEvent.click(screen.getByTestId('clear-breakpoint-override'));
    expect(onChangePage).toHaveBeenCalledTimes(1);
    const next = onChangePage.mock.calls[0]?.[0] as ReturnType<typeof createLoginPageDsl>;
    expect(findById(next.tree, 'el-5')?.responsive).toBeUndefined();

    rerender(<BreakpointBar value={768} onChange={() => undefined} page={next} elementId="el-5" onChangePage={onChangePage} />);
    expect(screen.getByText(/本断点差异 0 项/)).toBeInTheDocument();
  });

  it('没有选中元素时不显示清除按钮', () => {
    render(<BreakpointBar value={1920} onChange={() => undefined} page={createLoginPageDsl()} elementId={null} />);
    expect(screen.queryByTestId('clear-breakpoint-override')).toBeNull();
  });
});

function nodeOf(dsl: ReturnType<typeof createLoginPageDsl>, id: string) {
  const node = findById(dsl.tree, id);
  if (node === null) throw new Error(`元素不存在：${id}`);
  return node;
}
