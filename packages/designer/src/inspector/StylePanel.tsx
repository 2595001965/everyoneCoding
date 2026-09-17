import type * as React from 'react';

import type { ElementNode } from '../dsl/types';
import { defineSchema, type PropSchema } from '../registry/prop-schema';
import { SchemaForm } from './SchemaForm';

/**
 * 样式分区（T3-05）：尺寸 / 间距 / 颜色 / 字体 / 圆角 / 阴影 / 边框 / 布局。
 *
 * 与内容分区共同使用 `SchemaForm` 自动生成表单；样式值统一写入 `ElementNode.style`。
 * 布局相关的 `x/y` 在绝对定位模式下即 `left/top`，与画布拖拽共用同一份数据。
 */

export const STYLE_SCHEMA: PropSchema = defineSchema([
  // 尺寸
  { key: 'width', label: '宽度', type: 'size', group: '布局', placeholder: '如 320 或 100%' },
  { key: 'height', label: '高度', type: 'size', group: '布局', placeholder: '如 48 或 auto' },
  { key: 'minHeight', label: '最小高度', type: 'size', group: '布局' },
  { key: 'position', label: '定位方式', type: 'enum', group: '布局', default: 'absolute', options: [
    { value: 'absolute', label: '绝对定位' },
    { value: 'relative', label: '相对定位' },
    { value: 'static', label: '文档流' },
  ] },
  { key: 'left', label: 'X 坐标', type: 'size', group: '布局', visibleWhen: { field: 'position', equals: 'absolute' } },
  { key: 'top', label: 'Y 坐标', type: 'size', group: '布局', visibleWhen: { field: 'position', equals: 'absolute' } },
  { key: 'display', label: '显示方式', type: 'enum', group: '布局', options: [
    { value: 'block', label: '块级' },
    { value: 'flex', label: '弹性' },
    { value: 'inline-flex', label: '行内弹性' },
    { value: 'none', label: '不显示' },
  ] },
  { key: 'flexDirection', label: '主轴方向', type: 'enum', group: '布局', options: [
    { value: 'row', label: '横向' },
    { value: 'column', label: '纵向' },
  ], visibleWhen: { field: 'display', in: ['flex', 'inline-flex'] } },
  { key: 'alignItems', label: '交叉轴对齐', type: 'enum', group: '布局', options: [
    { value: 'flex-start', label: '起始' },
    { value: 'center', label: '居中' },
    { value: 'flex-end', label: '末尾' },
    { value: 'stretch', label: '拉伸' },
  ] },
  { key: 'justifyContent', label: '主轴对齐', type: 'enum', group: '布局', options: [
    { value: 'flex-start', label: '起始' },
    { value: 'center', label: '居中' },
    { value: 'space-between', label: '两端对齐' },
    { value: 'flex-end', label: '末尾' },
  ] },
  { key: 'gap', label: '子项间距', type: 'spacing', group: '布局', unit: 'px' },

  // 间距
  { key: 'margin', label: '外边距', type: 'spacing', group: '间距', unit: 'px', placeholder: '如 8 或 8 16' },
  { key: 'padding', label: '内边距', type: 'spacing', group: '间距', unit: 'px', placeholder: '如 16 或 12 24' },

  // 颜色
  { key: 'backgroundColor', label: '背景色', type: 'color', group: '外观', placeholder: '如 #ffffff 或 transparent' },
  { key: 'color', label: '文字颜色', type: 'color', group: '外观', placeholder: '如 #1f2937' },
  { key: 'opacity', label: '不透明度', type: 'number', group: '外观', min: 0, max: 1, step: 0.05 },

  // 字体
  { key: 'fontSize', label: '字号', type: 'size', group: '文字', unit: 'px' },
  { key: 'fontWeight', label: '字重', type: 'enum', group: '文字', options: [
    { value: '400', label: '常规' },
    { value: '500', label: '中等' },
    { value: '600', label: '半粗' },
    { value: '700', label: '加粗' },
  ] },
  { key: 'lineHeight', label: '行高', type: 'size', group: '文字' },
  { key: 'textAlign', label: '水平对齐', type: 'enum', group: '文字', options: [
    { value: 'left', label: '左' },
    { value: 'center', label: '居中' },
    { value: 'right', label: '右' },
  ] },
  { key: 'fontFamily', label: '字体', type: 'text', group: '文字' },

  // 圆角 / 阴影 / 边框
  { key: 'borderRadius', label: '圆角', type: 'size', group: '边框', unit: 'px' },
  { key: 'border', label: '边框', type: 'border', group: '边框', placeholder: '如 1px solid #e5e7eb' },
  { key: 'boxShadow', label: '阴影', type: 'shadow', group: '边框', placeholder: '如 0 2px 8px rgba(0,0,0,.08)' },
  { key: 'overflow', label: '溢出处理', type: 'enum', group: '边框', options: [
    { value: 'visible', label: '可见' },
    { value: 'hidden', label: '裁剪' },
    { value: 'auto', label: '滚动' },
  ] },
]);

export interface StylePanelProps {
  /** 选中的唯一元素（多选时由 Inspector 传入公共值映射） */
  element: ElementNode;
  /** 防抖毫秒（测试可传 0） */
  debounceMs?: number;
  /** 覆盖写入实现（批量修改时由 Inspector 传入） */
  onStyleChange: (key: string, value: unknown, options?: { coalesceKey?: string }) => void;
  /** 仅展示这些字段（多选公共属性） */
  onlyKeys?: readonly string[];
}

export function StylePanel({ element, debounceMs, onStyleChange, onlyKeys }: StylePanelProps): React.ReactElement {
  return (
    <SchemaForm
      schema={STYLE_SCHEMA}
      values={element.style ?? {}}
      onChange={onStyleChange}
      {...(debounceMs !== undefined ? { debounceMs } : {})}
      {...(onlyKeys !== undefined ? { onlyKeys } : {})}
    />
  );
}
