import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../index';

describe('Button', () => {
  it('点击触发 onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>确定</Button>);
    await userEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('键盘 Enter/Space 可达并触发', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>确定</Button>);
    const btn = screen.getByRole('button', { name: '确定' });
    btn.focus();
    expect(btn).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('loading 时禁用且 aria-busy', () => {
    render(<Button loading>提交</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });
});
