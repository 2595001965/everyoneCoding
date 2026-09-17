/**
 * 组件渲染共享工具（T3-04）。
 *
 * 设计器内组件为**纯受控展示**：设计态用 props 字面量，预览态按 `bindings` 走
 * `resolveExpression` 解析 `scope` 变量表。所有取值均带默认值，避免 undefined 落到 DOM。
 */

import type * as React from 'react';

import type { ElementNode } from '../dsl/types';
import { resolveExpression } from '../shared/expression';

/** 选项类属性（options / 列定义数据源） */
export interface OptionItem {
  label: string;
  value: string;
}

/** 列定义（columns 类型） */
export interface ColumnDef {
  key: string;
  title: string;
  width?: number | string;
  align?: 'left' | 'center' | 'right';
}

function raw(node: ElementNode, key: string): unknown {
  return node.props?.[key];
}

export function propString(node: ElementNode, key: string, fallback = ''): string {
  const value = raw(node, key);
  return typeof value === 'string' ? value : fallback;
}

export function propBoolean(node: ElementNode, key: string, fallback = false): boolean {
  const value = raw(node, key);
  return typeof value === 'boolean' ? value : fallback;
}

export function propNumber(node: ElementNode, key: string, fallback = 0): number {
  const value = raw(node, key);
  return typeof value === 'number' ? value : fallback;
}

export function propOptions(node: ElementNode, key: string): OptionItem[] {
  const value = raw(node, key);
  return Array.isArray(value) ? (value as OptionItem[]) : [];
}

export function propColumns(node: ElementNode, key: string): ColumnDef[] {
  const value = raw(node, key);
  return Array.isArray(value) ? (value as ColumnDef[]) : [];
}

/** 预览态：若属性绑定了 scope 路径，则解析该路径，否则回退到字面量 */
export function previewString(node: ElementNode, key: string, scope: Record<string, unknown> | undefined, fallback = ''): string {
  const binding = node.bindings?.[key];
  if (binding !== undefined && scope !== undefined) {
    const value = resolveExpression(binding, scope);
    return value == null ? fallback : String(value);
  }
  return propString(node, key, fallback);
}

export function previewBoolean(node: ElementNode, key: string, scope: Record<string, unknown> | undefined, fallback = false): boolean {
  const binding = node.bindings?.[key];
  if (binding !== undefined && scope !== undefined) {
    const value = resolveExpression(binding, scope);
    return typeof value === 'boolean' ? value : fallback;
  }
  return propBoolean(node, key, fallback);
}

export function previewNumber(node: ElementNode, key: string, scope: Record<string, unknown> | undefined, fallback = 0): number {
  const binding = node.bindings?.[key];
  if (binding !== undefined && scope !== undefined) {
    const value = resolveExpression(binding, scope);
    return typeof value === 'number' ? value : fallback;
  }
  return propNumber(node, key, fallback);
}

export function previewOptions(node: ElementNode, key: string, scope: Record<string, unknown> | undefined): OptionItem[] {
  const binding = node.bindings?.[key];
  if (binding !== undefined && scope !== undefined) {
    const value = resolveExpression(binding, scope);
    return Array.isArray(value) ? (value as OptionItem[]) : [];
  }
  return propOptions(node, key);
}

/** 解析绑定的数据数组（Table / List / ListPage 预览用） */
export function resolveBoundRows(node: ElementNode, scope: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const binding = node.bindings?.data;
  if (binding === undefined || scope === undefined) return [];
  const value = resolveExpression(binding, scope);
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** 把节点的自定义 style 覆盖合并到基础样式上（node.style 为用户设置的样式） */
export function withNodeStyle(base: React.CSSProperties, node: ElementNode): React.CSSProperties {
  const merged = { ...base };
  if (node.style !== undefined) {
    Object.assign(merged, node.style);
  }
  return merged;
}
