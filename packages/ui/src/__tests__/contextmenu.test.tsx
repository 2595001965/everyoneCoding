import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextMenu } from '../index';

const items = [
  { key: 'rename', label: '重命名' },
  { key: 'delete', label: '删除' },
];

describe('ContextMenu', () => {
  it('右键打开菜单并点击项触发 onSelect', async () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu items={items} onSelect={onSelect}>
        <div>区域</div>
      </ContextMenu>,
    );
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    const area = screen.getByText('区域');
    area.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    await userEvent.click(screen.getByText('删除'));
    expect(onSelect).toHaveBeenCalledWith('delete');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('Esc 关闭菜单', async () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu items={items} onSelect={onSelect}>
        <div>区域</div>
      </ContextMenu>,
    );
    const area = screen.getByText('区域');
    area.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});
