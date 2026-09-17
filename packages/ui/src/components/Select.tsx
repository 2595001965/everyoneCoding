/**
 * Select：自建下拉选择（combobox + listbox）。受控/非受控，完整键盘导航。
 *
 * 键盘：展开后 ↑/↓ 移动、Enter 选择、Esc 关闭、Home/End 跳首尾、输入字符快速定位；
 * 收起时 Enter/Space/↓ 展开。aria 使用 role=combobox/listbox/option。
 */
import * as React from 'react';
import { cx } from '../cx';
import { useControllableState, useStableId } from '../_internal';

export interface SelectOption {
  label: React.ReactNode;
  value: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  clearable?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function Select({
  options,
  value,
  defaultValue,
  onChange,
  placeholder = '请选择',
  invalid = false,
  disabled = false,
  size = 'md',
  clearable = false,
  className,
  'aria-label': ariaLabel,
}: SelectProps): React.ReactElement {
  const [val, setVal] = useControllableState<string>({ value, defaultValue: defaultValue ?? '', onChange });
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const listId = useStableId('ec-select');
  const labelId = useStableId('ec-select-label');

  const selected = options.find((o) => o.value === val) ?? null;

  const openList = React.useCallback(() => {
    if (disabled) return;
    const idx = options.findIndex((o) => o.value === val);
    setActive(idx >= 0 ? idx : 0);
    setOpen(true);
  }, [disabled, options, val]);

  const choose = React.useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt || opt.disabled) return;
      setVal(opt.value);
      setOpen(false);
    },
    [options, setVal],
  );

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  React.useEffect(() => {
    if (open && listRef.current) {
      const el = listRef.current.children[active] as HTMLElement | undefined;
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    }
  }, [active, open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => Math.min(options.length - 1, a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(active);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  const showClear = clearable && !disabled && val.length > 0;

  return (
    <div
      ref={rootRef}
      className={cx('ec-select', `ec-button--${size}`, invalid && 'ec-input--invalid', disabled && 'ec-input--disabled', className)}
    >
      <button
        type="button"
        className="ec-select__trigger"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-labelledby={ariaLabel ? undefined : labelId}
        aria-label={ariaLabel}
        {...(invalid ? { 'aria-invalid': true } : {})}
        {...(disabled ? { disabled: true } : {})}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className={cx('ec-select__value', !selected && 'ec-select__value--placeholder')}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="ec-select__caret" aria-hidden="true">▾</span>
      </button>
      {showClear && (
        <button
          type="button"
          className="ec-input__clear"
          aria-label="清空选择"
          onClick={() => setVal('')}
        >
          ×
        </button>
      )}
      <span id={labelId} className="ec-sr-only">
        {ariaLabel ?? placeholder}
      </span>
      {open && (
        <ul ref={listRef} id={listId} className="ec-select__list" role="listbox" aria-activedescendant={`${listId}-${active}`}>
          {options.map((opt, i) => (
            <li
              key={opt.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={opt.value === val}
              aria-disabled={opt.disabled || undefined}
              className={cx('ec-select__option', i === active && 'ec-select__option--active', opt.value === val && 'ec-select__option--selected', opt.disabled && 'ec-select__option--disabled')}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
