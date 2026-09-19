/**
 * Menu：菜单列表（role=menu）。完整键盘导航：↑/↓ 移动、Enter/Space 选择、Esc 关闭、Home/End。
 * 设计为可被 Popover / ContextMenu 包裹使用；选中或 Esc 时回调 onClose。
 */
import * as React from 'react';
import { cx } from '../cx';

export interface MenuOption {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

export interface MenuProps {
  items: MenuOption[];
  onSelect?: (key: string) => void;
  onClose?: () => void;
  className?: string;
  'aria-label'?: string;
  autoFocus?: boolean;
}

export const Menu = React.forwardRef<HTMLUListElement, MenuProps>(function Menu(props, ref) {
  const {
    items,
    onSelect,
    onClose,
    className,
    'aria-label': ariaLabel = '菜单',
    autoFocus = true,
  } = props;
  const [active, setActive] = React.useState(() =>
    Math.max(
      0,
      items.findIndex((i) => !i.disabled && !i.separator),
    ),
  );
  const itemRefs = React.useRef<(HTMLLIElement | null)[]>([]);
  const localRef = React.useRef<HTMLUListElement | null>(null);
  React.useImperativeHandle(ref, () => localRef.current as HTMLUListElement);

  React.useEffect(() => {
    if (autoFocus && localRef.current) localRef.current.focus();
  }, [autoFocus]);

  const move = (dir: 1 | -1) => {
    setActive((cur) => {
      let next = cur;
      for (let i = 0; i < items.length; i++) {
        next = (next + dir + items.length) % items.length;
        const it = items[next];
        if (it && !it.disabled && !it.separator) break;
      }
      return next;
    });
  };

  React.useEffect(() => {
    itemRefs.current[active]?.focus();
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        setActive(
          Math.max(
            0,
            items.findIndex((i) => !i.disabled && !i.separator),
          ),
        );
        break;
      case 'End':
        e.preventDefault();
        setActive(lastEnabled(items));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        selectAt(active);
        break;
      case 'Escape':
        e.preventDefault();
        onClose?.();
        break;
    }
  };

  const selectAt = (idx: number) => {
    const it = items[idx];
    if (!it || it.disabled || it.separator) return;
    onSelect?.(it.key);
    onClose?.();
  };

  return (
    <ul
      ref={localRef}
      className={cx('ec-menu', className)}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {items.map((it, i) => {
        const isActive = i === active;
        if (it.separator) {
          return <li key={it.key} className="ec-menu__separator" role="separator" />;
        }
        return (
          <li
            key={it.key}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            tabIndex={isActive ? 0 : -1}
            className={cx(
              'ec-menu__item',
              it.danger && 'ec-menu__item--danger',
              it.disabled && 'ec-menu__item--disabled',
              isActive && 'ec-menu__item--active',
            )}
            onClick={() => selectAt(i)}
            onMouseEnter={() => !it.disabled && setActive(i)}
          >
            {it.icon && (
              <span className="ec-menu__icon" aria-hidden="true">
                {it.icon}
              </span>
            )}
            <span className="ec-menu__label">{it.label}</span>
          </li>
        );
      })}
    </ul>
  );
});

function lastEnabled(items: MenuOption[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it && !it.disabled && !it.separator) return i;
  }
  return 0;
}
