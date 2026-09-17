import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Select } from '../index';

const options = [
  { label: '苹果', value: 'apple' },
  { label: '香蕉', value: 'banana' },
  { label: '橙子', value: 'orange' },
];

describe('Select', () => {
  it('点击选项触发 onChange', async () => {
    const onChange = vi.fn();
    render(<Select options={options} onChange={onChange} placeholder="请选择" />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByText('香蕉'));
    expect(onChange).toHaveBeenCalledWith('banana');
  });

  it('键盘 ↑/↓ 移动 + Enter 选择', async () => {
    const onChange = vi.fn();
    render(<Select options={options} onChange={onChange} />);
    const trigger = screen.getByRole('combobox');
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}'); // 展开
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowDown}'); // 移动到索引 1
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('banana');
  });

  it('Esc 关闭弹层', async () => {
    render(<Select options={options} />);
    const trigger = screen.getByRole('combobox');
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});
