import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../index';

describe('Modal', () => {
  it('打开时渲染 role=dialog 与标题', () => {
    render(<Modal defaultOpen title="编辑">内容</Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('编辑')).toBeInTheDocument();
  });

  it('Esc 关闭并回调 onOpenChange(false)', async () => {
    const onOpenChange = vi.fn();
    render(
      <Modal defaultOpen title="编辑" onOpenChange={onOpenChange}>
        内容
      </Modal>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('点击遮罩关闭', async () => {
    const onOpenChange = vi.fn();
    render(
      <Modal defaultOpen onOpenChange={onOpenChange}>
        内容
      </Modal>,
    );
    const overlay = document.body.querySelector('.ec-overlay') as HTMLElement;
    await userEvent.click(overlay);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('焦点陷阱只在打开时聚焦一次：第二个输入框可持续输入（回归：每次渲染都抢焦点）', async () => {
    const user = userEvent.setup();
    function Form(): JSX.Element {
      const [first, setFirst] = React.useState('');
      const [second, setSecond] = React.useState('');
      return (
        <Modal defaultOpen title="表单" onOpenChange={() => undefined}>
          <input aria-label="第一个" value={first} onChange={(e) => setFirst(e.target.value)} />
          <input aria-label="第二个" value={second} onChange={(e) => setSecond(e.target.value)} />
        </Modal>
      );
    }
    render(<Form />);

    await user.type(screen.getByLabelText('第二个'), 'abc');
    // 若焦点被反复抢回第一个输入框，这里只会收到 'a'
    expect(screen.getByLabelText('第二个')).toHaveValue('abc');
    expect(screen.getByLabelText('第一个')).toHaveValue('');
  });
});
