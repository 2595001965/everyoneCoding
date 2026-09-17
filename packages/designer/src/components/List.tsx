/**
 * List 列表组件（T3-04）。设计态显示空态或 children；预览态走 @ec/ui 虚拟化 List。
 */
import { EmptyState, List } from '@ec/ui';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import { propBoolean, propString, resolveBoundRows } from './render-utils';

export function ListRenderer({ node, mode, scope, children }: ComponentRenderProps): JSX.Element {
  const layout = propString(node, 'itemLayout', 'vertical');
  const split = propBoolean(node, 'split', true);
  const isEmpty = children === undefined || children === null;

  if (mode === 'design') {
    return (
      <div className="ecd-list" data-layout={layout} data-split={split} data-component="List" data-mode={mode}>
        {isEmpty ? <EmptyState title="暂无数据" description="预览时绑定数据源" /> : children}
      </div>
    );
  }

  const items = resolveBoundRows(node, scope);
  const height = Math.min(320, Math.max(120, items.length * 44));
  return (
    <div className="ecd-list" data-layout={layout} data-split={split} data-component="List" data-mode={mode}>
      <List
        items={items}
        itemHeight={44}
        height={height}
        renderItem={(item) => (
          <div className="ecd-list__item">
            {typeof item === 'string' ? item : JSON.stringify(item)}
          </div>
        )}
      />
    </div>
  );
}

export const ListMeta: ComponentMeta = {
  type: 'List',
  displayName: '列表',
  group: '数据展示',
  description: '纵向列表，可绑定数据源或承载子项',
  icon: 'list',
  defaultProps: { dataSource: '', itemLayout: 'vertical', split: true },
  defaultStyle: {},
  acceptsChildren: true,
  propSchema: {
    fields: [
      { key: 'dataSource', label: '数据源', type: 'text', group: '数据', default: '' },
      { key: 'itemLayout', label: '排布', type: 'enum', group: '布局', default: 'vertical', options: [
        { value: 'horizontal', label: '横向' },
        { value: 'vertical', label: '纵向' },
      ] },
      { key: 'split', label: '分割线', type: 'boolean', group: '外观', default: true },
    ],
  },
};
