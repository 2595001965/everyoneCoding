/**
 * Modal：模态对话框。Portal 挂载、焦点陷阱、Esc/遮罩关闭、role=dialog + aria-modal。
 */
import * as React from 'react';
import { cx } from '../cx';
import { Portal, useFocusTrap, useStableId } from '../_internal';
import { useDisclosure } from '../hooks/useDisclosure';
import { IconButton } from './IconButton';

export interface ModalProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  closeOnOverlay?: boolean;
  className?: string;
}

export function Modal(props: ModalProps): React.ReactElement | null {
  const { open, defaultOpen, onOpenChange, title, children, footer, size = 'md', closeOnOverlay = true, className } =
    props;
  const { open: isOpen, setOpen } = useDisclosure({ open, defaultOpen, onOpenChange });
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = useStableId('ec-modal-title');

  useFocusTrap(panelRef, isOpen, () => setOpen(false));

  if (!isOpen) return null;

  return (
    <Portal>
      <div
        className="ec-overlay"
        data-ec-overlay=""
        onMouseDown={(e) => {
          if (closeOnOverlay && e.target === e.currentTarget) setOpen(false);
        }}
      >
        <div
          ref={panelRef}
          className={cx('ec-modal', `ec-modal--${size}`, className)}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
        >
          {title != null && (
            <header className="ec-modal__header">
              <h2 id={titleId} className="ec-modal__title">
                {title}
              </h2>
              <IconButton aria-label="关闭" size="sm" onClick={() => setOpen(false)}>
                ×
              </IconButton>
            </header>
          )}
          <div className="ec-modal__body">{children}</div>
          {footer != null && <footer className="ec-modal__footer">{footer}</footer>}
        </div>
      </div>
    </Portal>
  );
}
