import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from '../index';

describe('Input', () => {
  it('非受控输入触发 onChange 并更新值', async () => {
    const onChange = vi.fn();
    render(<Input defaultValue="" onChange={onChange} placeholder="名称" />);
    const input = screen.getByPlaceholderText('名称') as HTMLInputElement;
    await userEvent.type(input, 'abc');
    expect(onChange).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith('abc');
    expect(input.value).toBe('abc');
  });

  it('受控输入可被清空', async () => {
    function Wrapper() {
      const [v, setV] = React.useState('hello');
      return <Input value={v} onChange={setV} clearable />;
    }
    render(<Wrapper />);
    const input = screen.getByDisplayValue('hello') as HTMLInputElement;
    expect(input.value).toBe('hello');
    await userEvent.click(screen.getByRole('button', { name: '清空输入' }));
    expect((screen.getByDisplayValue('') as HTMLInputElement).value).toBe('');
  });

  it('invalid 时 aria-invalid', () => {
    render(<Input invalid placeholder="错误" />);
    expect(screen.getByPlaceholderText('错误')).toHaveAttribute('aria-invalid', 'true');
  });
});
