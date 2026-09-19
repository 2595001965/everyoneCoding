import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { List } from '../index';

describe('List 虚拟化', () => {
  const items = Array.from({ length: 10000 }, (_, i) => `行${i}`);
  const total = items.length * 30;

  it('1 万条仅渲染窗口内少量节点', () => {
    const { container } = render(
      <List items={items} itemHeight={30} height={300} renderItem={(it) => <span>{it}</span>} />,
    );
    const rows = container.querySelectorAll('.ec-list__row');
    expect(rows.length).toBeLessThan(60);
    expect(rows.length).toBeGreaterThan(0);
    const sizer = container.querySelector('.ec-list__sizer') as HTMLElement;
    expect(sizer.style.height).toBe(`${total}px`);
    expect(screen.getByText('行0')).toBeInTheDocument();
    expect(screen.queryByText('行9999')).toBeNull();
  });

  it('点击行触发回调（键盘可达：行为按钮可聚焦回车）', async () => {
    const onRow = vi.fn();
    render(
      <List
        items={items}
        itemHeight={30}
        height={300}
        renderItem={(it) => <button onClick={() => onRow(it)}>{it}</button>}
      />,
    );
    const btn = screen.getByText('行0');
    btn.focus();
    expect(btn).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onRow).toHaveBeenCalledWith('行0');
  });
});
