/**
 * Container 容器组件（T3-04）。布局型容器，接受 children。
 */
import type * as React from 'react';

import type { ComponentMeta, ComponentRenderProps } from '../registry/component-registry';
import { propString, withNodeStyle } from './render-utils';

const ALIGN_MAP: Record<string, React.CSSProperties['alignItems']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

const JUSTIFY_MAP: Record<string, React.CSSProperties['justifyContent']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
}

function buildStyle(node: Parameters<typeof withNodeStyle>[1]): React.CSSProperties {
  const direction = propString(node, 'direction', 'row') as 'row' | 'column';
  const align = propString(node, 'align', 'stretch');
  const justify = propString(node, 'justify', 'start');
  const style: React.CSSProperties = {
    display: 'flex',
    flexDirection: direction,
    alignItems: ALIGN_MAP[align] ?? 'stretch',
    justifyContent: JUSTIFY_MAP[justify] ?? 'flex-start',
    gap: propString(node, 'gap', '0'),
    padding: propString(node, 'padding', '0'),
    background: propString(node, 'background', ''),
    margin: propString(node, 'margin', ''),
    boxShadow: propString(node, 'boxShadow', ''),
    width: propString(node, 'width', ''),
    height: propString(node, 'height', ''),
    borderRadius: propString(node, 'radius', ''),
  };
  const border = propString(node, 'border', '');
  if (border) style.border = border;
  return style;
}

export function ContainerRenderer({ node, mode, children }: ComponentRenderProps): JSX.Element {
  const style = withNodeStyle(buildStyle(node), node);
  const isEmpty = children === undefined || children === null;
  return (
    <div className="ecd-container" style={style} data-component="Container" data-mode={mode}>
      {isEmpty ? <span className="ecd-placeholder">拖拽组件到此处</span> : children}
    </div>
  );
}

export const ContainerMeta: ComponentMeta = {
  type: 'Container',
  displayName: '容器',
  group: '布局',
  description: '弹性布局容器，可横向或纵向排列子组件',
  icon: 'container',
  defaultProps: { direction: 'row', gap: '8px', padding: '8px' },
  defaultStyle: { padding: '8px' },
  acceptsChildren: true,
  propSchema: {
    fields: [
      { key: 'direction', label: '排列方向', type: 'enum', group: '布局', default: 'row', options: [
        { value: 'row', label: '横向' },
        { value: 'column', label: '纵向' },
      ] },
      { key: 'gap', label: '间距', type: 'spacing', group: '布局', default: '8px' },
      { key: 'padding', label: '内边距', type: 'spacing', group: '布局', default: '8px' },
      { key: 'align', label: '交叉轴对齐', type: 'enum', group: '布局', default: 'stretch', options: [
        { value: 'start', label: '起始' },
        { value: 'center', label: '居中' },
        { value: 'end', label: '结束' },
        { value: 'stretch', label: '拉伸' },
      ] },
      { key: 'justify', label: '主轴对齐', type: 'enum', group: '布局', default: 'start', options: [
        { value: 'start', label: '起始' },
        { value: 'center', label: '居中' },
        { value: 'end', label: '结束' },
        { value: 'between', label: '两端' },
        { value: 'around', label: '环绕' },
      ] },
      { key: 'background', label: '背景色', type: 'color', group: '外观', default: '' },
      { key: 'border', label: '边框', type: 'border', group: '外观', default: '' },
      { key: 'radius', label: '圆角', type: 'size', group: '外观', default: '' },
      { key: 'width', label: '宽度', type: 'size', group: '布局', default: '' },
      { key: 'height', label: '高度', type: 'size', group: '布局', default: '' },
      { key: 'margin', label: '外边距', type: 'spacing', group: '布局', default: '' },
      { key: 'boxShadow', label: '阴影', type: 'shadow', group: '外观', default: '' },
    ],
  },
};
