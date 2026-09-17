/**
 * 数据表格预览（T3-04）。Table / ListPageTemplate 在预览态共用。
 *
 * 复用 @ec/ui 的虚拟化 Table，但不持有其内部状态；数据全部来自 scope 绑定。
 */
import { Table, type Column } from '@ec/ui';

import type { ElementNode } from '../dsl/types';
import { resolveBoundRows, type ColumnDef } from './render-utils';

export interface BoundTableProps {
  node: ElementNode;
  /** 允许为 undefined（设计态或无绑定） */
  scope: Record<string, unknown> | undefined;
  columns: ColumnDef[];
  height?: number;
}

export function BoundTable({ node, scope, columns, height = 320 }: BoundTableProps): JSX.Element {
  const rows = resolveBoundRows(node, scope);
  const cols: Column<Record<string, unknown>>[] = columns.map((column) => {
    const col: Column<Record<string, unknown>> = { key: column.key, title: column.title };
    if (column.align !== undefined) col.align = column.align;
    if (column.width !== undefined) col.width = column.width;
    return col;
  });
  return (
    <Table
      columns={cols}
      rows={rows}
      height={height}
      rowKey={(row) => {
        const id = row.id;
        return typeof id === 'string' || typeof id === 'number' ? id : JSON.stringify(row);
      }}
      renderCell={(row, column) => {
        const value = (row as Record<string, unknown>)[column.key];
        return value == null ? '' : String(value);
      }}
    />
  );
}
