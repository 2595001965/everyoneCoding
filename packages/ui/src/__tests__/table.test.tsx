import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Table, type Column } from '../index';

interface Row {
  id: number;
  name: string;
}

const columns: Column<Row>[] = [
  { key: 'id', title: 'ID' },
  { key: 'name', title: '名称' },
];
const rows: Row[] = Array.from({ length: 10000 }, (_, i) => ({ id: i, name: `项${i}` }));

describe('Table 虚拟化', () => {
  it('1 万行仅渲染窗口内少量行', () => {
    const { container } = render(
      <Table columns={columns} rows={rows} rowKey={(r) => r.id} rowHeight={32} height={300} />,
    );
    const bodyRows = container.querySelectorAll('.ec-table__body .ec-table__row');
    expect(bodyRows.length).toBeLessThan(60);
    expect(screen.getByText('项0')).toBeInTheDocument();
    expect(screen.queryByText('项9999')).toBeNull();
  });

  it('点击行触发 onRowSelect', async () => {
    const onSelect = vi.fn();
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowHeight={32}
        height={300}
        onRowSelect={onSelect}
      />,
    );
    const firstRow = screen.getByText('项0').closest('[role="row"]') as HTMLElement;
    await userEvent.click(firstRow);
    expect(onSelect).toHaveBeenCalledWith(0, rows[0]);
  });

  it('键盘 ↓ + Enter 选择行', async () => {
    const onSelect = vi.fn();
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowHeight={32}
        height={300}
        onRowSelect={onSelect}
      />,
    );
    const body = screen.getAllByRole('rowgroup')[1] as HTMLElement;
    body.focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(1, rows[1]);
  });
});
