/**
 * CommandPalette：命令面板（模糊检索 + 上下键选择 + Enter 执行）。Portal 居中弹层。
 */
import * as React from 'react';
import { cx } from '../cx';
import { Portal, useFocusTrap, useStableId } from '../_internal';
import { useDisclosure } from '../hooks/useDisclosure';

export interface CommandItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  group?: string;
  keywords?: string[];
}

export interface CommandPaletteProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  commands: CommandItem[];
  onSelect: (id: string) => void;
  placeholder?: string;
  className?: string;
}

/** 子序列模糊匹配：query 的字符按顺序出现在 text 中即命中。 */
function fuzzy(query: string, text: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
}

export function CommandPalette(props: CommandPaletteProps): React.ReactElement | null {
  const {
    open,
    defaultOpen,
    onOpenChange,
    commands,
    onSelect,
    placeholder = '输入命令…',
    className,
  } = props;
  const { open: isOpen, setOpen } = useDisclosure({ open, defaultOpen, onOpenChange });
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = useStableId('ec-cmd');

  useFocusTrap(panelRef, isOpen, () => setOpen(false));

  const results = React.useMemo(() => {
    return commands.filter((c) =>
      fuzzy(
        query,
        `${c.title} ${c.subtitle ?? ''} ${c.group ?? ''} ${(c.keywords ?? []).join(' ')}`,
      ),
    );
  }, [commands, query]);

  React.useEffect(() => {
    setActive(0);
  }, [query]);

  React.useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  React.useEffect(() => {
    if (isOpen && listRef.current) {
      const el = listRef.current.children[active] as HTMLElement | undefined;
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    }
  }, [active, isOpen]);

  if (!isOpen) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = results[active];
      if (item) {
        onSelect(item.id);
        setOpen(false);
      }
    }
  };

  return (
    <Portal>
      <div className="ec-overlay ec-overlay--center">
        <div
          ref={panelRef}
          className={cx('ec-command-palette', className)}
          role="dialog"
          aria-modal="true"
          aria-label="命令面板"
        >
          <input
            ref={inputRef}
            className="ec-command-palette__input"
            value={query}
            placeholder={placeholder}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <ul ref={listRef} id={listId} className="ec-command-palette__list" role="listbox">
            {results.map((item, i) => (
              <li
                key={item.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={cx(
                  'ec-command-palette__item',
                  i === active && 'ec-command-palette__item--active',
                )}
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  onSelect(item.id);
                  setOpen(false);
                }}
              >
                {item.icon && (
                  <span className="ec-command-palette__icon" aria-hidden="true">
                    {item.icon}
                  </span>
                )}
                <span className="ec-command-palette__title">{item.title}</span>
                {item.subtitle && <span className="ec-command-palette__sub">{item.subtitle}</span>}
              </li>
            ))}
            {results.length === 0 && (
              <li className="ec-command-palette__empty" role="presentation">
                无匹配命令
              </li>
            )}
          </ul>
        </div>
      </div>
    </Portal>
  );
}
