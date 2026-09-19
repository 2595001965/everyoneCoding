import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Resizable } from '../index';

describe('Resizable', () => {
  it('渲染内容并提供尺寸手柄', () => {
    const { container } = render(
      <Resizable defaultWidth={200} defaultHeight={120}>
        内容
      </Resizable>,
    );
    expect(container.querySelector('.ec-resizable__content')).toBeTruthy();
    expect(container.querySelector('.ec-resizable__handle--corner')).toBeTruthy();
  });

  it('键盘方向键调整宽度（右手柄 role=separator）', async () => {
    const { container } = render(
      <Resizable defaultWidth={200} defaultHeight={120}>
        内容
      </Resizable>,
    );
    const handle = container.querySelector('.ec-resizable__handle--right') as HTMLElement;
    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    const root = container.querySelector('.ec-resizable') as HTMLElement;
    expect(root.style.width).toBe('216px');
  });

  it('尺寸变化回调', async () => {
    const onResize = vi.fn();
    const { container } = render(
      <Resizable defaultWidth={200} defaultHeight={120} onResize={onResize}>
        内容
      </Resizable>,
    );
    const handle = container.querySelector('.ec-resizable__handle--right') as HTMLElement;
    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onResize).toHaveBeenCalledWith({ width: 216, height: 120 });
  });
});
