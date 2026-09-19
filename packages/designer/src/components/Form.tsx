/**
 * Form 表单组件（T3-04）。布局型容器，包裹表单项，接受 children。
 */
import type * as React from 'react';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import { propBoolean, propString, withNodeStyle } from './render-utils';

export function FormRenderer({ node, mode, children }: ComponentRenderProps): JSX.Element {
  const layout = propString(node, 'layout', 'vertical');
  const colon = propBoolean(node, 'colon', true);
  const style: React.CSSProperties = withNodeStyle(
    {
      display: 'flex',
      flexDirection: layout === 'horizontal' ? 'row' : 'column',
      gap: 12,
    },
    node,
  );
  const isEmpty = children === undefined || children === null;
  return (
    <form
      className="ecd-form"
      style={style}
      data-layout={layout}
      data-colon={colon}
      data-component="Form"
      data-mode={mode}
    >
      {isEmpty ? <span className="ecd-placeholder">拖入表单字段</span> : children}
    </form>
  );
}

export const FormMeta: ComponentMeta = {
  type: 'Form',
  displayName: '表单',
  group: '表单',
  description: '组织多个输入项并提交',
  icon: 'form',
  defaultProps: { layout: 'vertical', labelWidth: '80px', colon: true },
  defaultStyle: {},
  acceptsChildren: true,
  propSchema: {
    fields: [
      {
        key: 'layout',
        label: '布局',
        type: 'enum',
        group: '布局',
        default: 'vertical',
        options: [
          { value: 'vertical', label: '纵向' },
          { value: 'horizontal', label: '横向' },
          { value: 'inline', label: '行内' },
        ],
      },
      { key: 'labelWidth', label: '标签宽度', type: 'size', group: '布局', default: '80px' },
      { key: 'colon', label: '标签冒号', type: 'boolean', group: '布局', default: true },
    ],
  },
};
