/**
 * 虚拟化性能测试：1 万条数据只渲染可视窗口内的节点。
 * 对应验收标准：Tree / Table / List 在 1 万条数据下滚动流畅（不实例化 1 万个节点）。
 */
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { List, Table, Tree } from '../index';

const ROW_COUNT = 10_000;
const ITEM_HEIGHT = 32;

function bigRows() {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: `row-${index}`,
    label: `条目 ${index}`,
  }));
}

describe('虚拟化渲染', () => {
  it('List 1 万条只渲染窗口内节点', () => {
    const rows = bigRows();
    const { container } = render(
      <List
        items={rows}
        itemHeight={ITEM_HEIGHT}
        height={320}
        renderItem={(item) => <div>{(item as { label: string }).label}</div>}
        getItemKey={(item) => (item as { id: string }).id}
        aria-label="大列表"
      />,
    );
    const rendered = container.querySelectorAll('[role="listitem"]');
    expect(rendered.length).toBeGreaterThan(0);
    // 视口 320 / 行高 32 = 10 行 + overscan，绝不应渲染 1 万个
    expect(rendered.length).toBeLessThan(60);
  });

  it('Tree 1 万节点只渲染窗口内节点', () => {
    const data = Array.from({ length: 10 }, (_, group) => ({
      id: `group-${group}`,
      label: `分组 ${group}`,
      children: Array.from({ length: ROW_COUNT / 10 }, (_, index) => ({
        id: `group-${group}-item-${index}`,
        label: `节点 ${group}-${index}`,
      })),
    }));
    const { container } = render(
      <Tree data={data} defaultExpanded={['group-0']} height={320} aria-label="大索引树" />,
    );
    const rendered = container.querySelectorAll('[role="treeitem"]');
    expect(rendered.length).toBeGreaterThan(0);
    // 只展开第一组：可见 = 1 + 1000 中窗口内的部分
    expect(rendered.length).toBeLessThan(60);
  });

  it('Table 1 万行只渲染窗口内行', () => {
    const rows = Array.from({ length: ROW_COUNT }, (_, index) => ({
      id: `r${index}`,
      name: `页面 ${index}`,
    }));
    const { container } = render(
      <Table
        rows={rows}
        rowKey={(row) => row.id}
        height={360}
        aria-label="大表格"
        columns={[{ key: 'name', title: '页面' }]}
        renderCell={(row) => (row as { name: string }).name}
      />,
    );
    const rendered = container.querySelectorAll('[role="row"]');
    expect(rendered.length).toBeGreaterThan(1);
    expect(rendered.length).toBeLessThan(60);
  });

  it('List 滚动后窗口随之更新（滚动模拟）', () => {
    const rows = bigRows();
    const { container } = render(
      <List
        items={rows}
        itemHeight={ITEM_HEIGHT}
        height={320}
        renderItem={(item) => <div>{(item as { label: string }).label}</div>}
        getItemKey={(item) => (item as { id: string }).id}
        aria-label="滚动列表"
      />,
    );
    const scroller = container.querySelector('[role="list"]') as HTMLElement;
    expect(scroller).not.toBeNull();

    const indexesBefore = Array.from(container.querySelectorAll('[role="listitem"] > div')).map(
      (node) => Number(node.textContent?.replace('条目 ', '')),
    );
    expect(indexesBefore[0]).toBeLessThan(20);

    act(() => {
      scroller.scrollTop = 320 * 10; // 向下滚 10 屏 ≈ 索引 100
      scroller.dispatchEvent(new Event('scroll'));
    });

    const indexesAfter = Array.from(container.querySelectorAll('[role="listitem"] > div')).map(
      (node) => Number(node.textContent?.replace('条目 ', '')),
    );
    // 滚动 10 屏后窗口起点应接近 100
    expect(indexesAfter[0]).toBeGreaterThan(80);
    expect(indexesAfter[0]).toBeLessThan(120);
  });
});
