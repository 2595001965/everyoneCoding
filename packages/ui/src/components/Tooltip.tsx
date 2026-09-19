/**
 * Tooltip：悬浮提示。hover/focus 显示，Esc/失焦隐藏。role=tooltip + aria-describedby。
 * 不拦截焦点（提示类），但支持 Esc 关闭以满足可达性约定。
 */
import * as React from 'react';
import { cx } from '../cx';
import { Portal, useStableId } from '../_internal';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  placement?: TooltipPlacement;
  delay?: number;
  className?: string;
}

export function Tooltip({
  content,
  children,
  placement = 'top',
  delay = 120,
  className,
}: TooltipProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [coords, setCoords] = React.useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const triggerRef = React.useRef<HTMLElement>(null);
  const tipId = useStableId('ec-tooltip');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const place = React.useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const top =
      placement === 'top'
        ? r.top - 8
        : placement === 'bottom'
          ? r.bottom + 8
          : (r.top + r.height) / 2;
    const left =
      placement === 'left'
        ? r.left - 8
        : placement === 'right'
          ? r.right + 8
          : (r.left + r.width) / 2;
    setCoords({ top, left });
  }, [placement]);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      place();
      setOpen(true);
    }, delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  const trigger = React.cloneElement(children, {
    ref: triggerRef,
    'aria-describedby': open ? tipId : undefined,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: () => {
      // 键盘聚焦立即显示（不走 hover 延迟）
      if (timer.current) clearTimeout(timer.current);
      place();
      setOpen(true);
    },
    onBlur: hide,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    },
  } as Partial<unknown>);

  if (!open) return trigger;

  const style: React.CSSProperties = {
    position: 'fixed',
    top: coords.top,
    left: coords.left,
    transform: placementTransform(placement),
  };

  return (
    <>
      {trigger}
      <Portal>
        <div
          id={tipId}
          role="tooltip"
          className={cx('ec-tooltip', `ec-tooltip--${placement}`, className)}
          style={style}
        >
          {content}
        </div>
      </Portal>
    </>
  );
}

function placementTransform(p: TooltipPlacement): string {
  switch (p) {
    case 'top':
      return 'translate(-50%, -100%)';
    case 'bottom':
      return 'translate(-50%, 0)';
    case 'left':
      return 'translate(-100%, -50%)';
    case 'right':
      return 'translate(0, -50%)';
  }
}
