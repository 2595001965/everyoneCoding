/**
 * 选中框 / 框选（T3-02 要点 6）。
 *
 * - 单选：高亮选中元素边框
 * - 框选：拖出矩形选择区域内元素
 * - 多选：Shift / Ctrl 累加（由调用方维护 selectedIds）
 * - hover 高亮
 * 锁定元素在 ElementView 侧已禁用命中测试，此处只负责绘制。
 *
 * 另导出纯函数 `rectsIntersect` / `selectInRect` 供框选几何计算（可单测）。
 */
import type * as React from 'react';
import { cx } from '@ec/ui';
import type { Rect } from './coordinate';

export type SelectionVariant = 'selected' | 'hover' | 'marquee';

export interface SelectionBoxProps {
  rect: Rect;
  variant?: SelectionVariant;
  /** 测试 id 后缀，便于断言 */
  testId?: string;
  className?: string;
}

/** 两个矩形是否相交（边接触算相交） */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 归一化可能为负的宽高（框选拖向负方向） */
export function normalizeRect(rect: Rect): Rect {
  return {
    x: rect.width < 0 ? rect.x + rect.width : rect.x,
    y: rect.height < 0 ? rect.y + rect.height : rect.y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

/**
 * 返回落在框选矩形内的元素 id 列表。
 * @param elements 元素 id 与画布坐标矩形
 * @param marquee 框选矩形（画布坐标）
 */
export function selectInRect(elements: { id: string; rect: Rect }[], marquee: Rect): string[] {
  const m = normalizeRect(marquee);
  return elements.filter((el) => rectsIntersect(el.rect, m)).map((el) => el.id);
}

const COLORS: Record<SelectionVariant, string> = {
  selected: 'var(--ec-accent, #2f6bff)',
  hover: 'var(--ec-accent-soft, #7aa2ff)',
  marquee: 'var(--ec-accent, #2f6bff)',
};

/** 绘制一个矩形框（绝对定位，不影响布局） */
export function SelectionBox({ rect, variant = 'selected', testId, className }: SelectionBoxProps): React.ReactElement {
  const color = COLORS[variant];
  const isMarquee = variant === 'marquee';
  return (
    <div
      data-testid={testId ?? `selection-box-${variant}`}
      aria-hidden="true"
      className={cx('ec-selection-box', `ec-selection-box--${variant}`, className)}
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        border: isMarquee ? `1px solid ${color}` : `2px solid ${color}`,
        background: isMarquee ? 'rgba(47,107,255,0.10)' : 'transparent',
        pointerEvents: 'none',
        zIndex: 10,
      }}
    />
  );
}
