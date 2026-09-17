import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../index';

describe('Badge', () => {
  it('渲染文本与语义色', () => {
    const { container } = render(<Badge color="success">已完成</Badge>);
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(container.querySelector('.ec-badge--success')).toBeTruthy();
  });

  it('dot 变体提供状态指示', () => {
    const { container } = render(<Badge dot>在线</Badge>);
    expect(container.querySelector('.ec-badge__dot')).toBeTruthy();
  });
});
