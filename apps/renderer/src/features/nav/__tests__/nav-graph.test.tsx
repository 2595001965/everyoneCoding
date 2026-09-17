/**
 * T6-07 渲染层测试：关系图谱（缩放 / 筛选 / 路径高亮 / 分层布局）。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { NavApiProvider } from '../nav-api';
import { RelationGraphView } from '../RelationGraphView';
import { createFakeNavApi } from './fake-nav';

function renderGraph(api: ReturnType<typeof createFakeNavApi>): { container: HTMLElement } {
  return render(
    <NavApiProvider api={api}>
      <RelationGraphView width={800} height={600} />
    </NavApiProvider>,
  );
}

describe('RelationGraphView（T6-07 关系图谱）', () => {
  it('渲染 5 类节点与 6 类边，统计口径一致', async () => {
    const api = createFakeNavApi();
    const { container } = renderGraph(api);

    await screen.findByTestId('relation-graph-svg');

    const nodeTypes = new Set(
      [...container.querySelectorAll('[data-testid="relation-node"]')].map((node) => node.getAttribute('data-type')),
    );
    expect(nodeTypes).toEqual(new Set(['page', 'element', 'api', 'module', 'table']));

    expect(container.querySelectorAll('[data-testid="relation-edge"]')).toHaveLength(6);
    expect(screen.getByTestId('graph-counts')).toHaveTextContent('7 个节点 / 6 条边');
  });

  it('同类型节点 y 相同、组内 x 递增', async () => {
    const api = createFakeNavApi();
    const { container } = renderGraph(api);
    await screen.findByTestId('relation-graph-svg');

    const m1 = container.querySelector('[data-node="m1"]');
    const m2 = container.querySelector('[data-node="m2"]');
    expect(m1?.getAttribute('data-y')).toBe(m2?.getAttribute('data-y'));
    expect(Number(m1?.getAttribute('data-x'))).toBeLessThan(Number(m2?.getAttribute('data-x')));

    // 坐标落在画布内（领域层 layoutGraph 的落界保证）
    for (const node of container.querySelectorAll('[data-testid="relation-node"]')) {
      const x = Number(node.getAttribute('data-x'));
      const y = Number(node.getAttribute('data-y'));
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(800);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(600);
    }
  });

  it('缩放按钮改变 viewBox，且不改变节点坐标', async () => {
    const user = userEvent.setup();
    const api = createFakeNavApi();
    const { container } = renderGraph(api);
    const svg = await screen.findByTestId('relation-graph-svg');

    const before = svg.getAttribute('viewBox');
    const xBefore = container.querySelector('[data-node="m1"]')?.getAttribute('data-x');

    await user.click(screen.getByTestId('graph-zoom-in'));
    const after = svg.getAttribute('viewBox');
    expect(after).not.toBe(before);
    expect(screen.getByTestId('graph-zoom-value')).toHaveTextContent('1.25');

    await user.click(screen.getByTestId('graph-zoom-out'));
    expect(svg.getAttribute('viewBox')).toBe(before);
    // 缩放走 viewBox，不重算布局
    expect(container.querySelector('[data-node="m1"]')?.getAttribute('data-x')).toBe(xBefore);
  });

  it('缩放有上下限（0.50 ~ 3.00）', async () => {
    const user = userEvent.setup();
    const api = createFakeNavApi();
    renderGraph(api);
    await screen.findByTestId('relation-graph-svg');

    for (let index = 0; index < 12; index += 1) await user.click(screen.getByTestId('graph-zoom-out'));
    expect(screen.getByTestId('graph-zoom-value')).toHaveTextContent('0.50');

    for (let index = 0; index < 20; index += 1) await user.click(screen.getByTestId('graph-zoom-in'));
    expect(screen.getByTestId('graph-zoom-value')).toHaveTextContent('3.00');
  });

  it('按类型筛选后节点与「两端都在」的边同步减少', async () => {
    const user = userEvent.setup();
    const api = createFakeNavApi();
    const { container } = renderGraph(api);
    await screen.findByTestId('relation-graph-svg');

    await user.click(screen.getByTestId('graph-filter-table'));

    await waitFor(() => expect(screen.getByTestId('graph-counts')).toHaveTextContent('5 个节点 / 4 条边'));
    // 读取 / 写入两条边因端点被筛掉而消失
    const remaining = [...container.querySelectorAll('[data-testid="relation-edge"]')].map((edge) =>
      edge.getAttribute('data-edge'),
    );
    expect(remaining).not.toContain('x4');
    expect(remaining).not.toContain('x5');
  });

  it('全部取消勾选时给出空状态而不是空白画布', async () => {
    const user = userEvent.setup();
    const api = createFakeNavApi();
    renderGraph(api);
    await screen.findByTestId('relation-graph-svg');

    for (const type of ['page', 'element', 'api', 'module', 'table']) {
      await user.click(screen.getByTestId(`graph-filter-${type}`));
    }

    expect(await screen.findByText('当前筛选下没有节点')).toBeInTheDocument();
  });

  it('选中节点后按上下游高亮，节点与边都带上高亮类', async () => {
    const api = createFakeNavApi();
    const { container } = renderGraph(api);
    await screen.findByTestId('relation-graph-svg');

    // a1 的下游：m1 → t1 / t2；上游：e1 → p1，以及 m2（tests 边）
    fireEvent.click(container.querySelector('[data-node="a1"]') as Element);

    const summary = await screen.findByTestId('graph-highlight');
    // 自身 + 上游 3 + 下游 3
    expect(summary).toHaveTextContent('已高亮 7 个节点');
    expect(summary).toHaveTextContent('上游 3 个，下游 3 个');

    expect(container.querySelector('[data-node="a1"]')).toHaveClass('ec-relation-graph__node--hl');
    expect(container.querySelector('[data-node="t1"]')).toHaveClass('ec-relation-graph__node--hl');
    expect(container.querySelector('[data-node="m2"]')).toHaveClass('ec-relation-graph__node--hl');

    const highlightedEdges = container.querySelectorAll('.ec-relation-graph__edge--hl');
    expect(highlightedEdges.length).toBeGreaterThan(0);
  });
});
