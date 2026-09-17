import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox } from '../index';

describe('Checkbox', () => {
  it('点击切换选中', async () => {
    const onChange = vi.fn();
    render(<Checkbox label="启用" onChange={onChange} />);
    const cb = screen.getByRole('checkbox');
    await userEvent.click(cb);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(cb).toBeChecked();
  });

  it('键盘 Space 切换', async () => {
    const onChange = vi.fn();
    render(<Checkbox label="启用" onChange={onChange} />);
    const cb = screen.getByRole('checkbox');
    cb.focus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('indeterminate 渲染', () => {
    render(<Checkbox label="部分" indeterminate checked={false} readOnly />);
    const cb = screen.getByRole('checkbox') as HTMLInputElement;
    expect(cb.indeterminate).toBe(true);
  });
});
