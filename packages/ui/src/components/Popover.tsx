/**
 * Popover：气泡卡片。点击触发，Portal 定位，焦点陷阱 + Esc + 外部点击关闭。
 */
import * as React from 'react';
import { cx } from '../cx';
import { Portal, useFocusTrap, useStableId } from '../_internal';
import { useDisclosure } from '../hooks/useDisclosure';

export type PopoverPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface PopoverProps {
  trigger: React.ReactElement;
  children: React.ReactNode;
  placement?: PopoverPlacement;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function Popover({
  trigger,
  children,
  placement = 'bottom',
  open,
  defaultOpen,
  onOpenChange,
  className,
}: PopoverProps): React.ReactElement {
  const { open: isOpen, setOpen } = useDisclosure({ open, defaultOpen, onOpenChange });
  const triggerRef = React.useRef<HTMLElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const popId = useStableId('ec-popover');

  useFocusTrap(panelRef, isOpen, () => setOpen(false));

  React.useEffect(() => {
    if (!isOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [isOpen, setOpen]);

  const style = React.useMemo<React.CSSProperties>(() => {
    const el = triggerRef.current;
    if (!el) return { position: 'fixed', top: 0, left: 0 };
    const r = el.getBoundingClientRect();
    const top = placement === 'top' ? r.top - 8 : placement === 'bottom' ? r.bottom + 8 : (r.top + r.height) / 2;
    const left = placement === 'left' ? r.left - 8 : placement === 'right' ? r.right + 8 : (r.left + r.width) / 2;
    return { position: 'fixed', top, left, transform: placementTransform(placement) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement, isOpen]);

  const renderedTrigger = React.cloneElement(trigger, {
    ref: triggerRef,
    'aria-expanded': isOpen,
    'aria-controls': popId,
    onClick: (e: React.MouseEvent) => {
      (trigger.props.onClick as ((e: React.MouseEvent) => void) | undefined)?.(e);
      setOpen(!isOpen);
    },
  } as Partial<unknown>);

  return (
    <>
      {renderedTrigger}
      {isOpen && (
        <Portal>
          <div
            ref={panelRef}
            id={popId}
            role="dialog"
            className={cx('ec-popover', `ec-popover--${placement}`, className)}
            style={style}
          >
            {children}
          </div>
        </Portal>
      )}
    </>
  );
}

function placementTransform(p: PopoverPlacement): string {
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
