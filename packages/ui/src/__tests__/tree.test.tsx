import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tree, type TreeNode } from '../index';

const bigData: TreeNode[] = Array.from({ length: 10000 }, (_, i) => ({ id: `n${i}`, label: `节点${i}` }));

describe('Tree 虚拟化', () => {
  it('1 万节点仅渲染窗口内少量节点', () => {
    const { container } = render(<Tree data={bigData} itemHeight={28} height={300} />);
    const rows = container.querySelectorAll('.ec-tree__row');
    expect(rows.length).toBeLessThan(60);
    expect(screen.getByText('节点0')).toBeInTheDocument();
    expect(screen.queryByText('节点9999')).toBeNull();
  });

  it('键盘 ↓ + Enter 选择节点', async () => {
    const onSelect = vi.fn();
    render(<Tree data={bigData} itemHeight={28} height={300} onSelect={onSelect} />);
    const tree = screen.getByRole('tree');
    tree.focus();
    await userEvent.keyboard('{ArrowDown}'); // 到索引 1
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('n1');
  });

  it('展开/收起子节点', async () => {
    const data: TreeNode[] = [{ id: 'p', label: '父', children: [{ id: 'c', label: '子' }] }];
    render(<Tree data={data} itemHeight={28} height={300} defaultExpanded={['p']} />);
    expect(screen.getByText('子')).toBeInTheDocument();
    // 收起
    const tree = screen.getByRole('tree');
    tree.focus();
    await userEvent.keyboard('{ArrowLeft}'); // 收起父
    expect(screen.queryByText('子')).toBeNull();
  });
});
