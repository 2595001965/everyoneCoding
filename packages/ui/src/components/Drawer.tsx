/**
 * Drawer：抽屉面板。Portal + 焦点陷阱 + Esc/遮罩关闭，支持从左/右/上/下四个方向滑出。
 */
import * as React from 'react';
import { cx } from '../cx';
import { Portal, useFocusTrap, useStableId } from '../_internal';
import { useDisclosure } from '../hooks/useDisclosure';
import { IconButton } from './IconButton';

export type DrawerPlacement = 'left' | 'right' | 'top' | 'bottom';

export interface DrawerProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  placement?: DrawerPlacement;
  size?: number;
  closeOnOverlay?: boolean;
  className?: string;
}

export function Drawer(props: DrawerProps): React.ReactElement | null {
  const {
    open,
    defaultOpen,
    onOpenChange,
    title,
    children,
    footer,
    placement = 'right',
    size = 360,
    closeOnOverlay = true,
    className,
  } = props;
  const { open: isOpen, setOpen } = useDisclosure({ open, defaultOpen, onOpenChange });
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = useStableId('ec-drawer-title');

  useFocusTrap(panelRef, isOpen, () => setOpen(false));

  if (!isOpen) return null;

  const sizeStyle: React.CSSProperties =
    placement === 'left' || placement === 'right' ? { width: size } : { height: size };

  return (
    <Portal>
      <div
        className="ec-overlay"
        onMouseDown={(e) => {
          if (closeOnOverlay && e.target === e.currentTarget) setOpen(false);
        }}
      >
        <div
          ref={panelRef}
          className={cx('ec-drawer', `ec-drawer--${placement}`, className)}
          style={sizeStyle}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
        >
          {title != null && (
            <header className="ec-drawer__header">
              <h2 id={titleId} className="ec-drawer__title">
                {title}
              </h2>
              <IconButton aria-label="关闭" size="sm" onClick={() => setOpen(false)}>
                ×
              </IconButton>
            </header>
          )}
          <div className="ec-drawer__body">{children}</div>
          {footer != null && <footer className="ec-drawer__footer">{footer}</footer>}
        </div>
      </div>
    </Portal>
  );
}
