/**
 * Table 表格组件（T3-04）。设计态显示列头与空态；预览态走 @ec/ui 虚拟化 Table。
 */
import { EmptyState } from '@ec/ui';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import { propBoolean, propColumns, propNumber } from './render-utils';
import { BoundTable } from './table-preview';

export function TableRenderer({ node, mode, scope, children }: ComponentRenderProps): JSX.Element {
  const columns = propColumns(node, 'columns');
  const bordered = propBoolean(node, 'bordered', false);
  const striped = propBoolean(node, 'striped', false);
  const pageSize = propNumber(node, 'pageSize', 20);

  if (mode === 'design') {
    const colCount = Math.max(1, columns.length);
    return (
      <div
        className="ecd-table"
        data-bordered={bordered}
        data-striped={striped}
        data-component="Table"
        data-mode={mode}
      >
        <table className="ecd-table__preview">
          <thead>
            <tr>
              {columns.length > 0 ? (
                columns.map((column) => <th key={column.key}>{column.title}</th>)
              ) : (
                <th>列</th>
              )}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={colCount}>
                <EmptyState
                  title="暂无数据"
                  description={`每页 ${pageSize} 条，预览时绑定数据源`}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div
      className="ecd-table"
      data-bordered={bordered}
      data-striped={striped}
      data-component="Table"
      data-mode={mode}
    >
      <BoundTable node={node} scope={scope} columns={columns} />
      {children}
    </div>
  );
}

export const TableMeta: ComponentMeta = {
  type: 'Table',
  displayName: '表格',
  group: '数据展示',
  description: '展示结构化数据，支持分页与虚拟化',
  icon: 'table',
  defaultProps: { columns: [], bordered: false, striped: false, pageSize: 20 },
  defaultStyle: {},
  acceptsChildren: true,
  propSchema: {
    fields: [
      { key: 'columns', label: '列定义', type: 'columns', group: '数据', default: [] },
      { key: 'bordered', label: '边框', type: 'boolean', group: '外观', default: false },
      { key: 'striped', label: '斑马纹', type: 'boolean', group: '外观', default: false },
      {
        key: 'pageSize',
        label: '每页条数',
        type: 'number',
        group: '数据',
        default: 20,
        min: 5,
        max: 200,
      },
    ],
  },
};
