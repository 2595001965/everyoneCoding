import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Menu } from '../index';

const items = [
  { key: 'cut', label: '剪切' },
  { key: 'copy', label: '复制' },
  { key: 'paste', label: '粘贴' },
];

describe('Menu', () => {
  it('点击菜单项触发 onSelect', async () => {
    const onSelect = vi.fn();
    render(<Menu items={items} onSelect={onSelect} />);
    await userEvent.click(screen.getByText('复制'));
    expect(onSelect).toHaveBeenCalledWith('copy');
  });

  it('键盘 ↑/↓ 导航 + Enter 选择', async () => {
    const onSelect = vi.fn();
    render(<Menu items={items} onSelect={onSelect} />);
    const menu = screen.getByRole('menu');
    menu.focus();
    await userEvent.keyboard('{ArrowDown}'); // 到索引 1
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('copy');
  });
});
