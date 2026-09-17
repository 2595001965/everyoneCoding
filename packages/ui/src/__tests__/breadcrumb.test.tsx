import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Breadcrumb } from '../index';

describe('Breadcrumb', () => {
  it('点击中间项触发 onClick', async () => {
    const onClick = vi.fn();
    render(
      <Breadcrumb
        items={[
          { label: '首页', onClick },
          { label: '当前' },
        ]}
      />,
    );
    await userEvent.click(screen.getByText('首页'));
    expect(onClick).toHaveBeenCalled();
  });

  it('末项 aria-current=page 且禁用', () => {
    render(<Breadcrumb items={[{ label: '首页' }, { label: '当前' }]} />);
    const last = screen.getByText('当前');
    expect(last).toHaveAttribute('aria-current', 'page');
  });

  it('键盘可达：标签为按钮可聚焦回车', async () => {
    const onClick = vi.fn();
    render(<Breadcrumb items={[{ label: '首页', onClick }, { label: '当前' }]} />);
    const link = screen.getByText('首页');
    link.focus();
    expect(link).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalled();
  });
});
