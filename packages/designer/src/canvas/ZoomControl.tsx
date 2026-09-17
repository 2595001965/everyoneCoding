/**
 * 缩放控制条（T3-02 要点 7）。
 *
 * 显示缩放百分比、加减、适应窗口、100%、缩放菜单。缩放值经 clampZoom 钳制在 [25%,400%]。
 */
import type * as React from 'react';
import { Button, IconButton, Select, Tooltip, cx } from '@ec/ui';
import { ZOOM_MIN, ZOOM_MAX, clampZoom } from './coordinate';

export interface ZoomControlProps {
  /** 当前缩放（小数，1 = 100%） */
  zoom: number;
  /** 缩放变化回调（传入已钳制的值） */
  onZoomChange: (zoom: number) => void;
  /** 适应窗口 */
  onFit?: () => void;
  /** 重置为 100% */
  onReset?: () => void;
  className?: string;
}

const MENU_OPTIONS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4].map((z) => ({ value: String(z), label: `${Math.round(z * 100)}%` }));

/** 缩放控制条 */
export function ZoomControl({ zoom, onZoomChange, onFit, onReset, className }: ZoomControlProps): React.ReactElement {
  const clamped = clampZoom(zoom);
  const percent = Math.round(clamped * 100);

  const step = (delta: number): void => onZoomChange(clampZoom(clamped + delta));

  return (
    <div
      data-testid="zoom-control"
      role="group"
      aria-label="缩放控制"
      className={cx('ec-zoom-control', className)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <Tooltip content="缩小">
        <IconButton aria-label="缩小" onClick={() => step(-0.1)}>
          −
        </IconButton>
      </Tooltip>
      <Select
        aria-label="缩放比例"
        options={MENU_OPTIONS}
        value={String(clamped)}
        onChange={(value) => onZoomChange(clampZoom(Number(value)))}
      />
      <Tooltip content="放大">
        <IconButton aria-label="放大" onClick={() => step(0.1)}>
          +
        </IconButton>
      </Tooltip>
      <Tooltip content="适应窗口">
        <Button aria-label="适应窗口" variant="ghost" size="sm" onClick={() => onFit?.()}>
          适应
        </Button>
      </Tooltip>
      <Tooltip content="实际大小（100%）">
        <Button aria-label="实际大小" variant="ghost" size="sm" onClick={() => (onReset ?? (() => onZoomChange(1)))()}>
          100%
        </Button>
      </Tooltip>
      <span data-testid="zoom-percent" aria-live="polite" style={{ minWidth: 44, textAlign: 'center' }}>
        {percent}%
      </span>
      <span data-testid="zoom-range" className="ec-sr-only">
        {`缩放范围 ${Math.round(ZOOM_MIN * 100)}% 至 ${Math.round(ZOOM_MAX * 100)}%`}
      </span>
    </div>
  );
}
