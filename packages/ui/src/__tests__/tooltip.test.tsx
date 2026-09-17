import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tag, Tooltip } from '../index';

describe('Tooltip', () => {
  it('hover 显示 role=tooltip', async () => {
    render(
      <Tooltip content="帮助提示">
        <button>悬停</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
    const trigger = screen.getByText('悬停');
    trigger.focus(); // onFocus 显示（hover 与 focus 等价可达性）
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('帮助提示'));
  });

  it('Esc 隐藏', async () => {
    render(
      <Tooltip content="帮助提示">
        <button>悬停</button>
      </Tooltip>,
    );
    const trigger = screen.getByText('悬停');
    trigger.focus();
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('支持用复合组件作为触发元素并正确转发定位 ref', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <Tooltip content="统计说明" delay={0}>
        <Tag>差异统计</Tag>
      </Tooltip>,
    );

    await userEvent.hover(screen.getByText('差异统计'));
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('统计说明'));
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('cannot be given refs');
  });
});
