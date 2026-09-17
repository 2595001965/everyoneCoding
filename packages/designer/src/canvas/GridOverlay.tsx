/**
 * 栅格覆盖层（T3-02 要点 5）。
 *
 * 渲染 8px 栅格（默认开启，可关闭）。同时定义对齐参考线类型 `AlignmentGuide`，
 * 供拖拽吸附（T3-03 snapping）消费并绘制。
 */
import type * as React from 'react';
import { cx } from '@ec/ui';

/** 对齐参考线（供 T3-03 拖拽吸附消费） */
export interface AlignmentGuide {
  axis: 'x' | 'y';
  /** 参考线在画布坐标系中的位置（px） */
  position: number;
  kind: 'element' | 'canvas' | 'spacing';
}

/** 栅格尺寸（px），全局常量 */
export const GRID_SIZE = 8;

export interface GridOverlayProps {
  /** 是否显示栅格，默认 true */
  visible?: boolean;
  /** 缩放比例，用于让栅格线在缩放下保持视觉密度 */
  zoom?: number;
  /** 画布逻辑尺寸（设计稿像素，未缩放） */
  width: number;
  height: number;
  className?: string;
}

/**
 * 栅格覆盖层：以 GRID_SIZE 为步长绘制背景网格。
 * 使用 CSS 背景渐变，不随元素数量增长而变重。
 */
export function GridOverlay({ visible = true, zoom = 1, width, height, className }: GridOverlayProps): React.ReactElement {
  const size = GRID_SIZE * zoom;
  return (
    <div
      data-testid="grid-overlay"
      aria-hidden="true"
      className={cx('ec-grid-overlay', !visible && 'ec-grid-overlay--hidden', className)}
      style={{
        position: 'absolute',
        inset: 0,
        width,
        height,
        pointerEvents: 'none',
        backgroundImage: visible
          ? `linear-gradient(to right, var(--ec-grid-line, rgba(0,0,0,0.06)) 1px, transparent 1px), linear-gradient(to bottom, var(--ec-grid-line, rgba(0,0,0,0.06)) 1px, transparent 1px)`
          : 'none',
        backgroundSize: visible ? `${size}px ${size}px` : undefined,
      }}
    />
  );
}
