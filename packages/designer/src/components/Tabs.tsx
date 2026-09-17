/**
 * Tabs 选项卡组件（T3-04）。复用 @ec/ui 的 Tabs，面板内容由 children 承载。
 */
import type * as React from 'react';
import { Tabs } from '@ec/ui';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import { propBoolean, propOptions, propString, previewOptions } from './render-utils';

export function TabsRenderer({ node, mode, scope, children }: ComponentRenderProps): JSX.Element {
  const options = mode === 'preview' ? previewOptions(node, 'items', scope) : propOptions(node, 'items');
  const position = propString(node, 'position', 'top');
  const animated = propBoolean(node, 'animated', true);
  const items: Array<{ key: string; label: React.ReactNode }> = options.map((option) => ({ key: option.value, label: option.label }));

  return (
    <div className="ecd-tabs" data-position={position} data-animated={animated} data-component="Tabs" data-mode={mode}>
      <Tabs items={items} className={position !== 'top' ? `ecd-tabs--${position}` : ''}>
        {() => children ?? <span className="ecd-placeholder">选项卡内容</span>}
      </Tabs>
    </div>
  );
}

export const TabsMeta: ComponentMeta = {
  type: 'Tabs',
  displayName: '选项卡',
  group: '基础',
  description: '在同一区域切换多组内容',
  icon: 'tabs',
  defaultProps: { items: [], position: 'top', animated: true },
  defaultStyle: {},
  acceptsChildren: true,
  propSchema: {
    fields: [
      { key: 'items', label: '选项', type: 'options', group: '数据', default: [] },
      { key: 'position', label: '位置', type: 'enum', group: '布局', default: 'top', options: [
        { value: 'top', label: '上' },
        { value: 'bottom', label: '下' },
        { value: 'left', label: '左' },
        { value: 'right', label: '右' },
      ] },
      { key: 'animated', label: '切换动画', type: 'boolean', group: '交互', default: true },
    ],
  },
};
