/**
 * Resizable：可调整尺寸的单面板。提供右/下/右下角拖拽手柄；聚焦手柄后用方向键微调。
 * 尺寸受控/非受控（width/height 可选）。不拦截内容焦点。
 */
import * as React from 'react';
import { cx } from '../cx';

export type ResizeHandle = 'right' | 'bottom' | 'corner';

export interface ResizableProps {
  width?: number;
  height?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  onResize?: (size: { width: number; height: number }) => void;
  minWidth?: number;
  minHeight?: number;
  step?: number;
  className?: string;
  children?: React.ReactNode;
  handles?: ResizeHandle[];
}

export function Resizable(props: ResizableProps): React.ReactElement {
  const {
    width,
    height,
    defaultWidth = 240,
    defaultHeight = 160,
    onResize,
    minWidth = 80,
    minHeight = 60,
    step = 16,
    className,
    children,
    handles = ['right', 'bottom', 'corner'],
  } = props;

  const isControlledW = width !== undefined;
  const isControlledH = height !== undefined;
  const [w, setW] = React.useState(defaultWidth);
  const [h, setH] = React.useState(defaultHeight);
  const curW = isControlledW ? (width as number) : w;
  const curH = isControlledH ? (height as number) : h;

  const apply = (nextW: number, nextH: number) => {
    const nw = Math.max(minWidth, nextW);
    const nh = Math.max(minHeight, nextH);
    if (!isControlledW) setW(nw);
    if (!isControlledH) setH(nh);
    onResize?.({ width: nw, height: nh });
  };

  const startDrag = (e: React.PointerEvent, axis: 'x' | 'y' | 'both') => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const baseW = curW;
    const baseH = curH;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      apply(axis === 'y' ? baseW : baseW + dx, axis === 'x' ? baseH : baseH + dy);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onHandleKey = (e: React.KeyboardEvent, axis: 'x' | 'y' | 'both') => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      apply(axis === 'y' ? curW : curW + step, axis === 'x' ? curH : curH + step);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      apply(axis === 'y' ? curW : curW - step, axis === 'x' ? curH : curH - step);
    }
  };

  return (
    <div
      className={cx('ec-resizable', className)}
      style={{ position: 'relative', width: curW, height: curH }}
    >
      <div className="ec-resizable__content" style={{ width: '100%', height: '100%' }}>
        {children}
      </div>
      {handles.includes('right') && (
        <span
          className="ec-resizable__handle ec-resizable__handle--right"
          role="separator"
          tabIndex={0}
          aria-label="调整宽度"
          aria-orientation="vertical"
          onPointerDown={(e) => startDrag(e, 'x')}
          onKeyDown={(e) => onHandleKey(e, 'x')}
        />
      )}
      {handles.includes('bottom') && (
        <span
          className="ec-resizable__handle ec-resizable__handle--bottom"
          role="separator"
          tabIndex={0}
          aria-label="调整高度"
          aria-orientation="horizontal"
          onPointerDown={(e) => startDrag(e, 'y')}
          onKeyDown={(e) => onHandleKey(e, 'y')}
        />
      )}
      {handles.includes('corner') && (
        <span
          className="ec-resizable__handle ec-resizable__handle--corner"
          role="separator"
          tabIndex={0}
          aria-label="调整大小"
          onPointerDown={(e) => startDrag(e, 'both')}
          onKeyDown={(e) => onHandleKey(e, 'both')}
        />
      )}
    </div>
  );
}
