/**
 * 插入指示线（T3-03 要点 3）。
 *
 * 三种形态：水平线（before/after，纵向流）、垂直线（before/after，横向流）、容器内框（inside）。
 * 坐标均为画布坐标系（在已缩放的表面层内绘制，随 zoom 自动缩放）。
 */
import type * as React from 'react';
import { cx } from '@ec/ui';
import type { DragResolution } from './collision';
import type { Rect } from '../canvas/coordinate';

export interface InsertionIndicatorProps {
  /** 解析结果（仅 insert 可绘制） */
  resolution: Extract<DragResolution, { kind: 'insert' }>;
  /** 被悬停元素在画布坐标系下的矩形 */
  targetRect: Rect;
  /** 主排序轴：flow 列→'y'，行→'x' */
  axis?: 'x' | 'y';
  className?: string;
}

const ACCENT = 'var(--ec-accent, #2f6bff)';

/** 拖拽插入指示 */
export function InsertionIndicator({
  resolution,
  targetRect,
  axis = 'y',
  className,
}: InsertionIndicatorProps): React.ReactElement | null {
  if (resolution.kind !== 'insert') return null;

  if (resolution.position === 'inside') {
    return (
      <div
        data-testid="insertion-indicator"
        data-position="inside"
        aria-hidden="true"
        className={cx('ec-insertion', 'ec-insertion--inside', className)}
        style={{
          position: 'absolute',
          left: targetRect.x,
          top: targetRect.y,
          width: targetRect.width,
          height: targetRect.height,
          border: `2px solid ${ACCENT}`,
          borderRadius: 2,
          pointerEvents: 'none',
          zIndex: 12,
        }}
      />
    );
  }

  const isVertical = axis === 'y';
  // before：上/左边缘；after：下/右边缘
  const lineStyle: React.CSSProperties = isVertical
    ? {
        position: 'absolute',
        left: targetRect.x,
        width: targetRect.width,
        height: 2,
        top: resolution.position === 'before' ? targetRect.y : targetRect.y + targetRect.height,
        background: ACCENT,
      }
    : {
        position: 'absolute',
        top: targetRect.y,
        height: targetRect.height,
        width: 2,
        left: resolution.position === 'before' ? targetRect.x : targetRect.x + targetRect.width,
        background: ACCENT,
      };

  return (
    <div
      data-testid="insertion-indicator"
      data-position={resolution.position}
      aria-hidden="true"
      className={cx('ec-insertion', `ec-insertion--${resolution.position}`, className)}
      style={{ ...lineStyle, pointerEvents: 'none', zIndex: 12 }}
    />
  );
}
