import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Popover } from '../index';

describe('Popover', () => {
  it('点击触发显示弹出内容', async () => {
    render(
      <Popover trigger={<button>打开</button>}>
        <div>弹出内容</div>
      </Popover>,
    );
    expect(screen.queryByText('弹出内容')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(screen.getByText('弹出内容')).toBeInTheDocument();
  });

  it('Esc 关闭弹出', async () => {
    render(
      <Popover trigger={<button>打开</button>}>
        <div>弹出内容</div>
      </Popover>,
    );
    await userEvent.click(screen.getByRole('button', { name: '打开' }));
    const trigger = screen.getByRole('button', { name: '打开' });
    trigger.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('弹出内容')).toBeNull();
  });
});
