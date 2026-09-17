import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Textarea } from '../index';

describe('Textarea', () => {
  it('输入触发 onChange', async () => {
    const onChange = vi.fn();
    render(<Textarea value="" onChange={onChange} placeholder="备注" />);
    await userEvent.type(screen.getByPlaceholderText('备注'), 'hi');
    expect(onChange).toHaveBeenCalled();
  });

  it('invalid 时 aria-invalid', () => {
    render(<Textarea invalid placeholder="备注" />);
    expect(screen.getByPlaceholderText('备注')).toHaveAttribute('aria-invalid', 'true');
  });
});
