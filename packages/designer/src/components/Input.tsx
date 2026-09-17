/**
 * Input 输入框组件（T3-04）。复用 @ec/ui 的 Input，纯展示，不接受 children。
 */
import { Input, type InputProps } from '@ec/ui';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import { getIcon } from '../registry/icon-set';
import { propBoolean, propString, previewString } from './render-utils';

const ICON_OPTIONS = [
  { value: '', label: '无' },
  { value: 'search', label: '搜索' },
  { value: 'lock', label: '锁' },
  { value: 'eye', label: '眼睛' },
  { value: 'close', label: '关闭' },
];

export function InputRenderer({ node, mode, scope }: ComponentRenderProps): JSX.Element {
  const placeholder = mode === 'preview' ? previewString(node, 'placeholder', scope, '') : propString(node, 'placeholder', '');
  const inputType = propString(node, 'inputType', 'text');
  const disabled = mode === 'design';
  const clearable = propBoolean(node, 'clearable', false);
  const prefixIconName = propString(node, 'prefixIcon', '');
  const prefixNode = prefixIconName ? getIcon(prefixIconName) : null;
  const boundValue = mode === 'preview' ? previewString(node, 'value', scope, '') : '';

  const props: InputProps = {
    type: inputType as InputProps['type'],
    placeholder: placeholder || undefined,
    clearable,
    disabled,
  };
  if (prefixNode) props.prefix = prefixNode;
  if (mode === 'preview' && boundValue) props.defaultValue = boundValue;

  return (
    <span data-component="Input" data-mode={mode}>
      <Input {...props} />
    </span>
  );
}

export const InputMeta: ComponentMeta = {
  type: 'Input',
  displayName: '输入框',
  group: '表单',
  description: '单行文本输入，支持多种类型与清空',
  icon: 'input',
  defaultProps: { placeholder: '请输入', inputType: 'text', required: false, maxLength: 0, clearable: false, prefixIcon: '' },
  defaultStyle: {},
  acceptsChildren: false,
  propSchema: {
    fields: [
      { key: 'placeholder', label: '占位提示', type: 'text', group: '内容', default: '请输入' },
      { key: 'inputType', label: '输入类型', type: 'enum', group: '内容', default: 'text', options: [
        { value: 'text', label: '文本' },
        { value: 'password', label: '密码' },
        { value: 'tel', label: '电话' },
        { value: 'email', label: '邮箱' },
        { value: 'number', label: '数字' },
      ] },
      { key: 'required', label: '必填', type: 'boolean', group: '交互', default: false },
      { key: 'maxLength', label: '最大长度', type: 'number', group: '高级', default: 0, min: 0, max: 500 },
      { key: 'clearable', label: '可清空', type: 'boolean', group: '交互', default: false },
      { key: 'prefixIcon', label: '前缀图标', type: 'enum', group: '内容', default: '', options: ICON_OPTIONS },
    ],
  },
};
