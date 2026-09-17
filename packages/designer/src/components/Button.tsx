/**
 * Button 按钮组件（T3-04）。复用 @ec/ui 的 Button，纯展示，不接受 children。
 */
import { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from '@ec/ui';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import { getIcon } from '../registry/icon-set';
import { propBoolean, propString, previewBoolean, previewString } from './render-utils';

const ICON_OPTIONS = [
  { value: '', label: '无' },
  { value: 'search', label: '搜索' },
  { value: 'plus', label: '加' },
  { value: 'close', label: '关闭' },
  { value: 'eye', label: '眼睛' },
  { value: 'lock', label: '锁' },
  { value: 'trash', label: '删除' },
  { value: 'copy', label: '复制' },
  { value: 'drag', label: '拖拽' },
];

export function ButtonRenderer({ node, mode, scope }: ComponentRenderProps): JSX.Element {
  const text = mode === 'preview' ? previewString(node, 'text', scope, '按钮') : propString(node, 'text', '按钮');
  const variant = propString(node, 'variant', 'primary') as ButtonVariant;
  const size = propString(node, 'size', 'md') as ButtonSize;
  const block = propBoolean(node, 'block', false);
  const disabled = mode === 'preview' ? previewBoolean(node, 'disabled', scope, false) : propBoolean(node, 'disabled', false);
  const iconName = propString(node, 'icon', '');
  const iconNode = iconName ? getIcon(iconName) : null;

  const props: ButtonProps = {
    variant,
    size,
    fullWidth: block,
    disabled,
  };
  if (iconNode) props.leftIcon = iconNode;

  return (
    <span data-component="Button" data-mode={mode}>
      <Button {...props}>{text || '按钮'}</Button>
    </span>
  );
}

export const ButtonMeta: ComponentMeta = {
  type: 'Button',
  displayName: '按钮',
  group: '基础',
  description: '触发动作的主要交互元素',
  icon: 'button',
  defaultProps: { text: '按钮', variant: 'primary', size: 'md', block: false, disabled: false, icon: '' },
  defaultStyle: {},
  acceptsChildren: false,
  propSchema: {
    fields: [
      { key: 'text', label: '按钮文字', type: 'text', group: '内容', default: '按钮' },
      { key: 'variant', label: '变体', type: 'enum', group: '外观', default: 'primary', options: [
        { value: 'primary', label: '主要' },
        { value: 'secondary', label: '次要' },
        { value: 'ghost', label: '幽灵' },
        { value: 'danger', label: '危险' },
      ] },
      { key: 'size', label: '尺寸', type: 'enum', group: '外观', default: 'md', options: [
        { value: 'sm', label: '小' },
        { value: 'md', label: '中' },
        { value: 'lg', label: '大' },
      ] },
      {
        key: 'block',
        label: '块级宽度',
        type: 'boolean',
        group: '外观',
        default: false,
        visibleWhen: { field: 'variant', equals: 'primary' },
      },
      { key: 'disabled', label: '禁用', type: 'boolean', group: '交互', default: false },
      { key: 'icon', label: '图标', type: 'enum', group: '内容', default: '', options: ICON_OPTIONS },
    ],
  },
};
