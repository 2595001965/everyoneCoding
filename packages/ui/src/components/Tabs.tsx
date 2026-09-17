/**
 * Tabs：选项卡。role=tablist/tab/tabpanel，支持 ←/→ 切换、Home/End，自动关联 aria。
 * 受控/非受控。键盘：← → 在标签间移动并切换（跟随焦点），Home/End 跳首尾。
 */
import * as React from 'react';
import { cx } from '../cx';
import { useControllableState } from '../_internal';

export interface TabItem {
  key: string;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (key: string) => void;
  children?: (active: string) => React.ReactNode;
  className?: string;
}

export function Tabs({ items, value, defaultValue, onChange, children, className }: TabsProps): React.ReactElement {
  const firstKey = items[0]?.key ?? '';
  const [active, setActive] = useControllableState<string>({
    value,
    defaultValue: defaultValue ?? firstKey,
    onChange,
  });
  const tabRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

  const focusAt = (idx: number) => {
    const it = items[idx];
    if (!it) return;
    setActive(it.key);
    tabRefs.current[idx]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      for (let i = 1; i <= items.length; i++) {
        const j = (idx + i) % items.length;
        if (!items[j]?.disabled) return focusAt(j);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      for (let i = 1; i <= items.length; i++) {
        const j = (idx - i + items.length) % items.length;
        if (!items[j]?.disabled) return focusAt(j);
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusAt(items.length - 1);
    }
  };

  return (
    <div className={cx('ec-tabs', className)}>
      <div className="ec-tabs__list" role="tablist">
        {items.map((it, i) => (
          <button
            key={it.key}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            role="tab"
            type="button"
            id={`ec-tab-${it.key}`}
            aria-selected={it.key === active}
            aria-controls={`ec-tabpanel-${it.key}`}
            tabIndex={it.key === active ? 0 : -1}
            disabled={it.disabled}
            className={cx('ec-tabs__tab', it.key === active && 'ec-tabs__tab--active', it.disabled && 'ec-tabs__tab--disabled')}
            onClick={() => setActive(it.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {it.label}
          </button>
        ))}
      </div>
      <div
        className="ec-tabs__panel"
        role="tabpanel"
        id={`ec-tabpanel-${active}`}
        aria-labelledby={`ec-tab-${active}`}
      >
        {typeof children === 'function' ? children(active) : children}
      </div>
    </div>
  );
}
