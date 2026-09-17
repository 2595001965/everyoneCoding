/**
 * Select 下拉选择组件（T3-04）。复用 @ec/ui 的 Select，纯展示，不接受 children。
 */
import type * as React from 'react';

import { Select } from '@ec/ui';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import { propBoolean, propOptions, propString, previewOptions } from './render-utils';

interface SelectOptionItem {
  label: React.ReactNode;
  value: string;
}

export function SelectRenderer({ node, mode, scope }: ComponentRenderProps): JSX.Element {
  const placeholder = propString(node, 'placeholder', '请选择');
  const options = mode === 'preview' ? previewOptions(node, 'options', scope) : propOptions(node, 'options');
  const selectOptions: SelectOptionItem[] = options.map((option) => ({ label: option.label, value: option.value }));
  const multiple = propBoolean(node, 'multiple', false);
  const searchable = propBoolean(node, 'searchable', false);

  return (
    <span data-component="Select" data-mode={mode} data-multiple={multiple} data-searchable={searchable}>
      <Select options={selectOptions} placeholder={placeholder} />
    </span>
  );
}

export const SelectMeta: ComponentMeta = {
  type: 'Select',
  displayName: '下拉选择',
  group: '表单',
  description: '从选项列表中选择一项或多项的下拉框',
  icon: 'select',
  defaultProps: { placeholder: '请选择', options: [], multiple: false, searchable: false },
  defaultStyle: {},
  acceptsChildren: false,
  propSchema: {
    fields: [
      { key: 'placeholder', label: '占位提示', type: 'text', group: '内容', default: '请选择' },
      { key: 'options', label: '选项', type: 'options', group: '数据', default: [] },
      { key: 'multiple', label: '多选', type: 'boolean', group: '交互', default: false },
      { key: 'searchable', label: '可搜索', type: 'boolean', group: '交互', default: false },
    ],
  },
};
