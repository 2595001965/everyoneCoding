import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast } from '../index';

function Demo() {
  const { toast } = useToast();
  return (
    <button onClick={() => toast({ title: '已保存', description: '操作成功', duration: 0 })}>
      触发
    </button>
  );
}

describe('Toast', () => {
  it('调用 toast 后渲染通知', async () => {
    render(
      <ToastProvider>
        <Demo />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: '触发' }));
    expect(screen.getByText('已保存')).toBeInTheDocument();
    expect(screen.getByText('操作成功')).toBeInTheDocument();
  });

  it('键盘可达：关闭按钮回车移除通知', async () => {
    render(
      <ToastProvider>
        <Demo />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: '触发' }));
    const closeBtn = screen.getByRole('button', { name: '关闭通知' });
    closeBtn.focus();
    expect(closeBtn).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByText('已保存')).toBeNull();
  });

  it('未在 Provider 内使用抛错', () => {
    function Bad() {
      useToast();
      return null;
    }
    // 渲染 Bad 会抛错，但 React 渲染错误需被捕获；用 expect 断言渲染抛错
    expect(() => render(<Bad />)).toThrow();
    void vi;
  });
});
