/**
 * Text 文本组件（T3-04）。纯展示文本，不接受 children。
 */
import type * as React from 'react';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import { propString, previewString, withNodeStyle } from './render-utils';

function buildStyle(node: Parameters<typeof withNodeStyle>[1]): React.CSSProperties {
  const style: React.CSSProperties = {
    color: propString(node, 'color', ''),
    fontSize: propString(node, 'fontSize', ''),
    textAlign: propString(node, 'align', 'left') as React.CSSProperties['textAlign'],
    fontWeight: propString(node, 'fontWeight', 'normal') as React.CSSProperties['fontWeight'],
  };
  return style;
}

export function TextRenderer({ node, mode, scope }: ComponentRenderProps): JSX.Element {
  const as = propString(node, 'as', 'p') as keyof JSX.IntrinsicElements;
  const text = mode === 'preview' ? previewString(node, 'text', scope, '') : propString(node, 'text', '');
  const style = withNodeStyle(buildStyle(node), node);
  const Tag = as;
  return (
    <Tag className="ecd-text" style={style} data-component="Text" data-mode={mode}>
      {text || <span className="ecd-placeholder">请输入文本</span>}
    </Tag>
  );
}

export const TextMeta: ComponentMeta = {
  type: 'Text',
  displayName: '文本',
  group: '基础',
  description: '展示一段静态或绑定文本',
  icon: 'text',
  defaultProps: { text: '文本内容', as: 'p', align: 'left', color: '', fontSize: '', fontWeight: 'normal' },
  defaultStyle: {},
  acceptsChildren: false,
  propSchema: {
    fields: [
      { key: 'text', label: '文本内容', type: 'textarea', group: '内容', default: '文本内容' },
      { key: 'as', label: '标签', type: 'enum', group: '外观', default: 'p', options: [
        { value: 'p', label: '段落' },
        { value: 'span', label: '行内' },
        { value: 'h1', label: '标题1' },
        { value: 'h2', label: '标题2' },
        { value: 'h3', label: '标题3' },
      ] },
      { key: 'align', label: '对齐', type: 'enum', group: '外观', default: 'left', options: [
        { value: 'left', label: '左' },
        { value: 'center', label: '中' },
        { value: 'right', label: '右' },
      ] },
      { key: 'color', label: '文字颜色', type: 'color', group: '外观', default: '' },
      { key: 'fontSize', label: '字号', type: 'size', group: '外观', default: '' },
      { key: 'fontWeight', label: '字重', type: 'enum', group: '外观', default: 'normal', options: [
        { value: 'normal', label: '常规' },
        { value: 'medium', label: '中等' },
        { value: 'bold', label: '加粗' },
      ] },
    ],
  },
};
