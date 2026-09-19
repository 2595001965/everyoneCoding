/**
 * ListPageTemplate 列表页模板（T3-04 业务组件）。工具栏 + 表格 + 分页，接受 children。
 */
import { EmptyState, Input } from '@ec/ui';

import type { ComponentMeta, ComponentRenderProps } from '../../registry/component-registry';
import { propBoolean, propColumns, propString, previewString } from '../render-utils';
import { BoundTable } from '../table-preview';

export function ListPageTemplateRenderer({
  node,
  mode,
  scope,
  children,
}: ComponentRenderProps): JSX.Element {
  const title =
    mode === 'preview'
      ? previewString(node, 'title', scope, '列表页')
      : propString(node, 'title', '列表页');
  const columns = propColumns(node, 'columns');
  const searchable = propBoolean(node, 'searchable', true);
  const filterable = propBoolean(node, 'filterable', false);
  const pagination = propBoolean(node, 'pagination', true);

  return (
    <section className="ecd-list-page" data-component="ListPageTemplate" data-mode={mode}>
      <header className="ecd-list-page__header">
        <h2 className="ecd-list-page__title">{title || '列表页'}</h2>
      </header>
      <div className="ecd-list-page__toolbar">
        {searchable ? (
          <Input
            placeholder="搜索"
            disabled={mode === 'design'}
            className="ecd-list-page__search"
          />
        ) : null}
        {filterable ? <span className="ecd-tag">筛选</span> : null}
      </div>
      <div className="ecd-list-page__table">
        {mode === 'design' ? (
          <div className="ecd-table ecd-table--preview">
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
                  <td colSpan={Math.max(1, columns.length)}>
                    <EmptyState title="暂无数据" description="预览时绑定数据源" />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <BoundTable node={node} scope={scope} columns={columns} />
        )}
      </div>
      {pagination ? (
        <div className="ecd-list-page__pagination">
          <span className="ecd-pagination">分页</span>
        </div>
      ) : null}
      {children}
    </section>
  );
}

export const ListPageTemplateMeta: ComponentMeta = {
  type: 'ListPageTemplate',
  displayName: '列表页模板',
  group: '业务组件',
  description: '内置搜索、筛选、分页的数据列表页模板',
  icon: 'list-page-template',
  defaultProps: {
    title: '列表页',
    columns: [],
    searchable: true,
    filterable: false,
    pagination: true,
  },
  defaultStyle: {},
  acceptsChildren: true,
  propSchema: {
    fields: [
      { key: 'title', label: '标题', type: 'text', group: '内容', default: '列表页' },
      { key: 'columns', label: '列定义', type: 'columns', group: '数据', default: [] },
      { key: 'searchable', label: '显示搜索', type: 'boolean', group: '交互', default: true },
      { key: 'filterable', label: '显示筛选', type: 'boolean', group: '交互', default: false },
      { key: 'pagination', label: '显示分页', type: 'boolean', group: '交互', default: true },
    ],
  },
};
