import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SplitPane } from '../index';

describe('SplitPane', () => {
  it('固定右栏时键盘方向正确，尺寸变化通知外层持久化', () => {
    const onResize = vi.fn();
    render(<SplitPane first="左" second="右" fixed="second" initial={320} onResize={onResize} />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(304);
  });

  it('拖动期间卸载会清理全局指针事件，不提交已卸载的尺寸', () => {
    const onResize = vi.fn();
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<SplitPane first="左" second="右" onResize={onResize} />);
    fireEvent.pointerDown(screen.getByRole('separator'));
    unmount();
    expect(remove).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('pointercancel', expect.any(Function));
    fireEvent.pointerUp(window);
    expect(onResize).not.toHaveBeenCalled();
  });
  it('渲染左右两栏', () => {
    render(<SplitPane first={<div>左</div>} second={<div>右</div>} />);
    expect(screen.getByText('左')).toBeInTheDocument();
    expect(screen.getByText('右')).toBeInTheDocument();
  });

  it('键盘方向键调整分隔（role=separator）', async () => {
    const { container } = render(
      <SplitPane first={<div>左</div>} second={<div>右</div>} initial={240} />,
    );
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    sep.focus();
    await userEvent.keyboard('{ArrowRight}');
    const pane = container.querySelector('.ec-split-pane__pane') as HTMLElement;
    expect(pane.style.flex).toContain('256px');
  });
});
