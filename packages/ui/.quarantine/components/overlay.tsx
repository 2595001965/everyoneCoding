import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../cx';
import { useVirtualList } from '../hooks/useVirtualList';

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** 指定初始焦点选择器 */
  initialFocusSelector?: string;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** 简易焦点陷阱 */
export function useFocusTrap(active: boolean, initialFocusSelector?: string) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    const initial =
      (initialFocusSelector !== undefined ? container.querySelector<HTMLElement>(initialFocusSelector) : null) ??
      focusables()[0];
    initial?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0] as HTMLElement;
      const last = list[list.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [active, initialFocusSelector]);

  return containerRef;
}

export function Modal({ open, title, onClose, children, footer, initialFocusSelector }: ModalProps) {
  const titleId = useId();
  const trapRef = useFocusTrap(open, initialFocusSelector);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  const host = typeof document !== 'undefined' ? document.body : null;
  if (host === null) return null;

  return createPortal(
    <div className="ec-modal__backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="ec-modal">
        <header className="ec-modal__header">
          <h2 id={titleId} className="ec-modal__title">
            {title}
          </h2>
          <button type="button" className="ec-modal__close" aria-label="关闭对话框" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="ec-modal__body">{children}</div>
        {footer !== undefined ? <footer className="ec-modal__footer">{footer}</footer> : null}
      </div>
    </div>,
    host,
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  side?: 'left' | 'right';
}

export function Drawer({ open, title, onClose, children, side = 'right' }: DrawerProps) {
  const titleId = useId();
  const trapRef = useFocusTrap(open);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  const host = typeof document !== 'undefined' ? document.body : null;
  if (host === null) return null;

  return createPortal(
    <div className="ec-drawer__backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx('ec-drawer', `ec-drawer--${side}`)}
      >
        <header className="ec-drawer__header">
          <h2 id={titleId} className="ec-drawer__title">
            {title}
          </h2>
          <button type="button" className="ec-drawer__close" aria-label="关闭侧栏" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="ec-drawer__body">{children}</div>
      </aside>
    </div>,
    host,
  );
}

// ---------------------------------------------------------------------------
// Tooltip / Popover
// ---------------------------------------------------------------------------

export interface TooltipProps {
  content: string;
  children: React.ReactElement;
  side?: 'top' | 'bottom';
}

export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const child = children as React.ReactElement<Record<string, unknown>>;

  return (
    <span
      className="ec-tooltip__anchor"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {hovered || visible ? (
        <span role="tooltip" className={cx('ec-tooltip', `ec-tooltip--${side}`)}>
          {content}
        </span>
      ) : null}
      {child}
    </span>
  );
}

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}

export function Popover({ open, onClose, anchor, children }: PopoverProps) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchor]);

  if (!open || anchor.current === null) return null;

  const rect = anchor.current.getBoundingClientRect();
  return createPortal(
    <div
      role="dialog"
      className="ec-popover"
      style={{
        position: 'fixed',
        top: rect.bottom + 6,
        left: rect.left,
        zIndex: 'var(--ec-z-popover)' as unknown as number,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Menu / ContextMenu
// ---------------------------------------------------------------------------

export interface MenuItem {
  key: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
  separatorBefore?: boolean;
}

export function Menu({
  items,
  activeIndex,
  onHover,
  className,
}: {
  items: MenuItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  className?: string;
}) {
  return (
    <ul role="menu" className={cx('ec-menu', className)}>
      {items.map((item, index) => (
        <li key={item.key} role="none" className={item.separatorBefore ? 'ec-menu__sep' : undefined}>
          {item.separatorBefore ? null : null}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            aria-disabled={item.disabled}
            className={cx('ec-menu__item', activeIndex === index && 'ec-menu__item--active', item.danger && 'ec-menu__item--danger')}
            onMouseEnter={() => onHover(index)}
            onClick={() => !item.disabled && item.onSelect?.()}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 键盘导航：上下移动 / Enter 执行 / Esc 关闭 */
export function useMenuKeyboard(items: MenuItem[], onClose: () => void) {
  const [activeIndex, setActiveIndex] = useState(0);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const selectable = items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0);
      const position = selectable.indexOf(activeIndex);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = selectable[(Math.max(0, position) + 1) % selectable.length] ?? 0;
        setActiveIndex(next);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const prev = selectable[(Math.max(0, position) - 1 + selectable.length) % selectable.length] ?? 0;
        setActiveIndex(prev);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const item = items[activeIndex];
        if (item && !item.disabled) {
          item.onSelect?.();
          onClose();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    },
    [items, activeIndex, onClose],
  );

  return { activeIndex, setActiveIndex, onKeyDown };
}

export interface DropdownMenuProps {
  trigger: (props: { ref: React.RefObject<HTMLButtonElement | null>; onClick: () => void; 'aria-expanded': boolean }) => React.ReactElement;
  items: MenuItem[];
}

export function DropdownMenu({ trigger, items }: DropdownMenuProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const { activeIndex, setActiveIndex, onKeyDown } = useMenuKeyboard(items, () => setOpen(false));

  return (
    <>
      {trigger({
        ref: buttonRef,
        onClick: () => setOpen((value) => !value),
        'aria-expanded': open,
      })}
      {open ? (
        <div onKeyDown={onKeyDown} className="ec-dropdown" style={{ position: 'relative' }}>
          <Menu
            items={items}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
          />
        </div>
      ) : null}
    </>
  );
}

export interface ContextMenuProps {
  /** 受控坐标；null 表示关闭 */
  at: { x: number; y: number } | null;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ at, items, onClose }: ContextMenuProps) {
  const { activeIndex, setActiveIndex, onKeyDown } = useMenuKeyboard(items, onClose);

  useEffect(() => {
    if (at === null) return;
    const onDown = () => onClose();
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [at, onClose]);

  if (at === null) return null;
  return (
    <div
      className="ec-contextmenu"
      style={{ position: 'fixed', left: at.x, top: at.y, zIndex: 'var(--ec-z-popover)' as unknown as number }}
      onKeyDown={onKeyDown}
    >
      <Menu items={items} activeIndex={activeIndex} onHover={setActiveIndex} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

export interface ToastItem {
  id: number;
  tone: 'info' | 'success' | 'warning' | 'danger';
  message: string;
}

export interface ToastApi {
  show(message: string, tone?: ToastItem['tone']): void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = React.useContext(ToastContext);
  if (!api) throw new Error('useToast 必须在 ToastProvider 内使用');
  return api;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show: (message, tone = 'info') => {
        seq.current += 1;
        const id = seq.current;
        setItems((current) => [...current, { id, tone, message }]);
        setTimeout(() => remove(id), 4000);
      },
    }),
    [remove],
  );

  const host = typeof document !== 'undefined' ? document.body : null;

  return (
    <ToastContext.Provider value={api}>
      {children}
      {host !== null
        ? createPortal(
            <div className="ec-toast-region" aria-live="polite" aria-atomic="false">
              {items.map((item) => (
                <div key={item.id} role="status" className={cx('ec-toast', `ec-toast--${item.tone}`)}>
                  <span className="ec-toast__message">{item.message}</span>
                  <button
                    type="button"
                    className="ec-toast__close"
                    aria-label="关闭通知"
                    onClick={() => remove(item.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>,
            host,
          )
        : null}
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// CommandPalette
// ---------------------------------------------------------------------------

export interface CommandItem {
  id: string;
  title: string;
  group?: string;
  shortcut?: string;
  run: () => void;
}

/** 子序列模糊匹配打分 */
function score(query: string, target: string): number {
  if (target.includes(query)) return 100 - target.indexOf(query);
  let index = 0;
  for (const char of target) {
    if (char === query[index]) index += 1;
    if (index === query.length) return 50;
  }
  return index === query.length ? 50 : 0;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
  placeholder?: string;
}

export function CommandPalette({ open, onClose, commands, placeholder = '搜索命令…' }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return commands;
    return commands
      .map((command) => ({
        command,
        s: Math.max(score(q, command.title.toLowerCase()), (command.group ?? '').toLowerCase().includes(q) ? 40 : 0),
      }))
      .filter((item) => item.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((item) => item.command);
  }, [commands, query]);

  const listRef = useVirtualList({
    count: filtered.length,
    itemHeight: 32,
  });

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;
  const host = typeof document !== 'undefined' ? document.body : null;
  if (host === null) return null;

  return createPortal(
    <div className="ec-cmdk__backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        className="ec-cmdk"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
            listRef.scrollToIndex(Math.min(activeIndex + 1, filtered.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
            listRef.scrollToIndex(Math.max(activeIndex - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const item = filtered[activeIndex];
            if (item) {
              item.run();
              onClose();
            }
          }
        }}
      >
        <input
          ref={inputRef}
          className="ec-cmdk__input"
          role="combobox"
          aria-expanded
          aria-controls="ec-cmdk-list"
          aria-activedescendant={`ec-cmdk-option-${activeIndex}`}
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
        />
        <div ref={listRef.containerRef} id="ec-cmdk-list" role="listbox" className="ec-cmdk__list">
          <div {...listRef.innerProps}>
            {filtered.slice(listRef.range.start, listRef.range.end).map((item, offset) => {
              const index = listRef.range.start + offset;
              return (
                <div
                  key={item.id}
                  id={`ec-cmdk-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={cx('ec-cmdk__option', index === activeIndex && 'ec-cmdk__option--active')}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    item.run();
                    onClose();
                  }}
                >
                  <span className="ec-cmdk__title">{item.title}</span>
                  {item.group !== undefined ? <span className="ec-cmdk__group">{item.group}</span> : null}
                  {item.shortcut !== undefined ? <kbd className="ec-cmdk__kbd">{item.shortcut}</kbd> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    host,
  );
}
