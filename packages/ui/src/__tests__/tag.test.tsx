import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tag } from '../index';

describe('Tag', () => {
  it('点击关闭按钮触发 onClose', async () => {
    const onClose = vi.fn();
    render(
      <Tag closable onClose={onClose}>
        标签
      </Tag>,
    );
    await userEvent.click(screen.getByRole('button', { name: '移除标签' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('键盘聚焦关闭按钮并回车移除', async () => {
    const onClose = vi.fn();
    render(
      <Tag closable onClose={onClose}>
        标签
      </Tag>,
    );
    const btn = screen.getByRole('button', { name: '移除标签' });
    btn.focus();
    expect(btn).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalled();
  });
});
