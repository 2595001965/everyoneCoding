import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '../index';

describe('EmptyState', () => {
  it('渲染中文标题与 role=status', () => {
    render(<EmptyState title="暂无数据" description="请先创建项目" />);
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    expect(screen.getByText('请先创建项目')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
