import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from '../index';

const items = [
  { key: 'a', label: '常规' },
  { key: 'b', label: '高级' },
];

describe('Tabs', () => {
  it('点击切换激活标签', async () => {
    const onChange = vi.fn();
    render(<Tabs items={items} onChange={onChange} />);
    await userEvent.click(screen.getByRole('tab', { name: '高级' }));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.getByRole('tab', { name: '高级' })).toHaveAttribute('aria-selected', 'true');
  });

  it('键盘 ←/→ 在标签间移动并切换', async () => {
    const onChange = vi.fn();
    render(<Tabs items={items} defaultValue="a" onChange={onChange} />);
    const first = screen.getByRole('tab', { name: '常规' });
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.getByRole('tab', { name: '高级' })).toHaveAttribute('aria-selected', 'true');
  });
});
