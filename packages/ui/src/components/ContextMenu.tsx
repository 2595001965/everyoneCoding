/**
 * ContextMenu：右键菜单。在鼠标位置弹出 Portal 菜单，焦点陷阱 + Esc + 外部点击关闭。
 */
import * as React from 'react';
import { cx } from '../cx';
import { Portal, useFocusTrap } from '../_internal';
import { Menu, type MenuOption } from './Menu';

export interface ContextMenuProps {
  items: MenuOption[];
  children: React.ReactElement;
  onSelect?: (key: string) => void;
  className?: string;
}

export function ContextMenu({ items, children, onSelect, className }: ContextMenuProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const panelRef = React.useRef<HTMLDivElement>(null);

  useFocusTrap(panelRef, open, () => setOpen(false));

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setPos({ x: e.clientX, y: e.clientY });
    setOpen(true);
  };

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const trigger = React.cloneElement(children, { onContextMenu } as Partial<unknown>);

  return (
    <>
      {trigger}
      {open && (
        <Portal>
          <div
            ref={panelRef}
            className={cx('ec-context-menu', className)}
            style={{ position: 'fixed', top: pos.y, left: pos.x, zIndex: 'var(--ec-z-dropdown)' }}
            role="presentation"
          >
            <Menu
              items={items}
              onSelect={(k) => {
                onSelect?.(k);
                setOpen(false);
              }}
              onClose={() => setOpen(false)}
            />
          </div>
        </Portal>
      )}
    </>
  );
}
