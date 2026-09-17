import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IconButton } from '../index';

describe('IconButton', () => {
  it('点击触发 onClick', async () => {
    const onClick = vi.fn();
    render(
      <IconButton aria-label="关闭" onClick={onClick}>
        ×
      </IconButton>,
    );
    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('必须提供 aria-label 用于无障碍', () => {
    render(
      <IconButton aria-label="更多">
        ⋯
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: '更多' })).toBeInTheDocument();
  });

  it('键盘聚焦后可激活', async () => {
    const onClick = vi.fn();
    render(
      <IconButton aria-label="关闭" onClick={onClick}>
        ×
      </IconButton>,
    );
    const btn = screen.getByRole('button', { name: '关闭' });
    btn.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalled();
  });
});
