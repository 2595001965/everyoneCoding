import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandPalette } from '../index';

const commands = [
  { id: 'new', title: '新建文件' },
  { id: 'open', title: '打开文件' },
  { id: 'save', title: '保存' },
];

describe('CommandPalette', () => {
  it('模糊检索过滤结果', async () => {
    render(<CommandPalette open commands={commands} onSelect={vi.fn()} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, '保存');
    expect(screen.getByText('保存')).toBeInTheDocument();
    expect(screen.queryByText('新建文件')).toBeNull();
  });

  it('↑/↓ + Enter 执行命令', async () => {
    const onSelect = vi.fn();
    render(<CommandPalette defaultOpen commands={commands} onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    input.focus();
    await userEvent.keyboard('{ArrowDown}'); // 默认激活第 0 项；下移选中“打开文件”
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('open');
  });

  it('Esc 关闭', async () => {
    const onSelect = vi.fn();
    render(<CommandPalette defaultOpen commands={commands} onSelect={onSelect} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
