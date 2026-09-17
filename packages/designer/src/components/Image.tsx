/**
 * Image 图片组件（T3-04）。纯展示，不接受 children。
 */
import type * as React from 'react';
import { EmptyState } from '@ec/ui';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import { propString, previewString, withNodeStyle } from './render-utils';

function buildStyle(node: Parameters<typeof withNodeStyle>[1]): React.CSSProperties {
  return {
    objectFit: propString(node, 'fit', 'cover') as React.CSSProperties['objectFit'],
    borderRadius: propString(node, 'radius', ''),
    width: '100%',
  };
}

export function ImageRenderer({ node, mode, scope }: ComponentRenderProps): JSX.Element {
  const src = mode === 'preview' ? previewString(node, 'src', scope, '') : propString(node, 'src', '');
  const alt = propString(node, 'alt', '');
  const style = withNodeStyle(buildStyle(node), node);
  if (!src) {
    return (
      <div className="ecd-image ecd-image--placeholder" style={{ borderRadius: propString(node, 'radius', '') }} data-component="Image" data-mode={mode}>
        <EmptyState title="暂无图片" description="请在属性面板设置图片地址" />
      </div>
    );
  }
  return <img className="ecd-image" src={src} alt={alt} style={style} data-component="Image" data-mode={mode} />;
}

export const ImageMeta: ComponentMeta = {
  type: 'Image',
  displayName: '图片',
  group: '基础',
  description: '展示一张图片，未设置地址时显示占位框',
  icon: 'image',
  defaultProps: { src: '', alt: '', fit: 'cover', radius: '' },
  defaultStyle: {},
  acceptsChildren: false,
  propSchema: {
    fields: [
      { key: 'src', label: '图片地址', type: 'image', group: '内容', default: '' },
      { key: 'alt', label: '替代文字', type: 'text', group: '内容', default: '' },
      { key: 'fit', label: '填充方式', type: 'enum', group: '外观', default: 'cover', options: [
        { value: 'cover', label: '裁剪填充' },
        { value: 'contain', label: '完整显示' },
        { value: 'fill', label: '拉伸' },
      ] },
      { key: 'radius', label: '圆角', type: 'size', group: '外观', default: '' },
    ],
  },
};
