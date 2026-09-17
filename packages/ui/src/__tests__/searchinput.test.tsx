import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchInput } from '../index';

describe('SearchInput', () => {
  it('输入触发 onChange', async () => {
    const onChange = vi.fn();
    render(<SearchInput onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('搜索'), 'abc');
    expect(onChange).toHaveBeenLastCalledWith('abc');
  });

  it('键盘可达：搜索框可聚焦并输入', async () => {
    const onChange = vi.fn();
    render(<SearchInput defaultValue="" onChange={onChange} />);
    const input = screen.getByLabelText('搜索');
    input.focus();
    expect(input).toHaveFocus();
    await userEvent.keyboard('x');
    expect(onChange).toHaveBeenLastCalledWith('x');
  });
});
