import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Badge, Breadcrumb, Button, EmptyState, IconButton, Progress, SearchInput, Spinner, Tag } from '../components/primitives';

describe('Button', () => {
  it('点击触发 onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>保存</Button>);
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('键盘 Enter 与 Space 都能触发', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>提交</Button>);
    const button = screen.getByRole('button', { name: '提交' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('loading 态禁用并标记 aria-busy', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        生成中
      </Button>,
    );
    const button = screen.getByRole('button', { name: /生成中/ });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('type 默认为 button（避免意外提交）', () => {
    render(<Button>默认</Button>);
    expect(screen.getByRole('button', { name: '默认' })).toHaveAttribute('type', 'button');
  });
});

describe('IconButton / Badge / Tag', () => {
  it('IconButton 必须有中文 aria-label', () => {
    render(
      <IconButton label="折叠侧栏">
        <span>«</span>
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: '折叠侧栏' })).toBeInTheDocument();
  });

  it('Badge 支持 tone 与圆点', () => {
    render(<Badge tone="success" dot>已连接</Badge>);
    const badge = screen.getByText('已连接');
    expect(badge.className).toContain('ec-badge--success');
    expect(badge.querySelector('.ec-badge__dot')).not.toBeNull();
  });

  it('Tag 可关闭且关闭按钮可键盘触达', async () => {
    const onClose = vi.fn();
    render(<Tag closable onClose={onClose}>React</Tag>);
    await userEvent.click(screen.getByRole('button', { name: /移除标签/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Progress / Spinner / EmptyState', () => {
  it('Progress 暴露 aria-valuenow 并裁剪到 0–100', () => {
    render(<Progress value={150} label="导出进度" />);
    const bar = screen.getByRole('progressbar', { name: '导出进度' });
    expect(bar).toHaveAttribute('aria-valuenow', '100');
  });

  it('Spinner 带 role=status', () => {
    render(<Spinner label="加载中" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '加载中');
  });

  it('EmptyState 展示标题与操作', () => {
    render(
      <EmptyState title="还没有项目" description="点击新建开始" action={<Button>新建项目</Button>} />,
    );
    expect(screen.getByText('还没有项目')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
  });
});

describe('Breadcrumb', () => {
  it('末级为当前页，前级可点击', async () => {
    const onHome = vi.fn();
    render(
      <Breadcrumb
        items={[
          { label: '工作台', onClick: onHome },
          { label: '演示项目' },
        ]}
      />,
    );
    expect(screen.getByText('演示项目')).toHaveAttribute('aria-current', 'page');
    await userEvent.click(screen.getByRole('button', { name: '工作台' }));
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});

describe('SearchInput', () => {
  it('输入触发 onValueChange，Esc 清空', async () => {
    const onValueChange = vi.fn();
    const onClear = vi.fn();
    const { rerender } = render(
      <SearchInput value="" onValueChange={onValueChange} onClear={onClear} />,
    );
    const input = screen.getByRole('searchbox');
    await userEvent.type(input, '登录');
    expect(onValueChange).toHaveBeenCalled();

    rerender(<SearchInput value="登录" onValueChange={onValueChange} onClear={onClear} />);
    input.focus();
    await userEvent.keyboard('{Escape}');
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('有值时显示清空按钮', async () => {
    const onValueChange = vi.fn();
    render(<SearchInput value="abc" onValueChange={onValueChange} />);
    await userEvent.click(screen.getByRole('button', { name: '清空搜索' }));
    expect(onValueChange).toHaveBeenCalledWith('');
  });
});
