import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  List,
  Resizable,
  SplitPane,
  Table,
  Tabs,
  Tree,
  type TreeNodeData,
} from '../components/layout';

describe('Tabs', () => {
  const items = [
    { key: 'design', label: '设计器', content: <div>设计器面板</div> },
    { key: 'memory', label: '记忆中心', content: <div>记忆面板</div> },
    { key: 'git', label: 'Git', content: <div>Git 面板</div> },
  ];

  it('点击切换并带 aria-selected', async () => {
    render(<Tabs items={items} initialKey="design" />);
    await userEvent.click(screen.getByRole('tab', { name: 'Git' }));
    expect(screen.getByRole('tab', { name: 'Git' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Git 面板');
  });

  it('方向键循环切换（roving tabindex）', async () => {
    render(<Tabs items={items} initialKey="design" />);
    const first = screen.getByRole('tab', { name: '设计器' });
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '记忆中心' })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '记忆中心' }));
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: '设计器' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('List', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: `row-${index}`,
    label: `条目 ${index}`,
    meta: `${index}`,
  }));

  it('点击选中并带 aria-selected', async () => {
    const onSelect = vi.fn();
    const { rerender } = render(<List rows={rows} onSelect={onSelect} selectedId={null} />);
    await userEvent.click(screen.getByText('条目 3'));
    expect(onSelect).toHaveBeenCalledWith(rows[3]);

    rerender(<List rows={rows} onSelect={onSelect} selectedId="row-3" />);
    expect(screen.getByRole('option', { name: /条目 3/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowDown 移动选择', async () => {
    const onSelect = vi.fn();
    render(<List rows={rows} onSelect={onSelect} selectedId="row-0" />);
    screen.getByRole('option', { name: /条目 0/ }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenCalledWith(rows[1]);
  });
});

describe('Tree', () => {
  const data: TreeNodeData[] = [
    {
      id: 'login',
      label: '登录功能',
      children: [
        { id: 'login-page', label: '登录页' },
        { id: 'login-api', label: '登录接口' },
      ],
    },
    { id: 'dashboard', label: '工作台' },
  ];

  it('默认展开 defaultExpanded 并可选中子节点', async () => {
    const onSelect = vi.fn();
    render(<Tree data={data} defaultExpanded={['login']} onSelect={onSelect} />);
    await userEvent.click(screen.getByText('登录页'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'login-page' }));
  });

  it('ArrowRight 展开节点', async () => {
    const onSelect = vi.fn();
    render(<Tree data={data} selectedId="login" onSelect={onSelect} />);
    expect(screen.queryByText('登录页')).not.toBeInTheDocument();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });

  it('ArrowDown 在可见节点间移动', async () => {
    const onSelect = vi.fn();
    render(<Tree data={data} defaultExpanded={['login']} selectedId="login" onSelect={onSelect} />);
    await userEvent.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'login-page' }));
  });
});

describe('Table', () => {
  it('渲染表头与行', () => {
    render(
      <Table
        rows={[
          { id: '1', name: '登录页', status: '已生成' },
          { id: '2', name: '工作台', status: '待生成' },
        ]}
        rowKey={(row) => row.id}
        columns={[
          { key: 'name', header: '页面', render: (row) => row.name },
          { key: 'status', header: '状态', render: (row) => row.status },
        ]}
      />,
    );
    expect(screen.getByRole('columnheader', { name: '页面' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '登录页' })).toBeInTheDocument();
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(3);
  });
});

describe('SplitPane', () => {
  it('键盘方向键微调分栏比例', async () => {
    render(
      <SplitPane
        initialRatio={0.5}
        first={<div>左</div>}
        second={<div>右</div>}
        dividerLabel="调整分栏"
      />,
    );
    const divider = screen.getByRole('separator', { name: '调整分栏' });
    divider.focus();
    expect(divider).toHaveAttribute('aria-valuenow', '50');
    await userEvent.keyboard('{ArrowRight}');
    expect(divider).toHaveAttribute('aria-valuenow', '52');
    await userEvent.keyboard('{ArrowLeft}');
    expect(divider).toHaveAttribute('aria-valuenow', '50');
  });
});

describe('Resizable', () => {
  it('键盘放大并回调 onResize', async () => {
    const onResize = vi.fn();
    function Demo() {
      const [size, setSize] = useState({ width: 200, height: 120 });
      return (
        <Resizable
          width={size.width}
          height={size.height}
          onResize={(next) => {
            setSize(next);
            onResize(next);
          }}
        >
          <div>内容</div>
        </Resizable>
      );
    }
    render(<Demo />);
    const handle = screen.getByRole('separator', { name: '拖拽调整大小' });
    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onResize).toHaveBeenCalledWith(expect.objectContaining({ width: 216 }));
  });
});
