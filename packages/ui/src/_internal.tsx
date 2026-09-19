/**
 * 内部通用能力（不对外导出）：Portal、受控状态、焦点陷阱、唯一 id。
 * 仅被本包组件复用，保证浮层行为一致、与可视化设计器画布样式隔离。
 */
import * as React from 'react';
import * as ReactDOM from 'react-dom';

/** 在 document.body 下挂载 Portal；jsdom 下 document.body 必然存在。 */
export function Portal({ children }: { children: React.ReactNode }): React.ReactPortal | null {
  if (typeof document === 'undefined' || !document.body) return null;
  return ReactDOM.createPortal(children, document.body);
}

/** 受控 / 非受控统一的 state 钩子。 */
export function useControllableState<T>(params: {
  value?: T | undefined;
  defaultValue: T;
  onChange?: ((value: T) => void) | undefined;
}): [T, (next: T) => void] {
  const { value, defaultValue, onChange } = params;
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState<T>(defaultValue);
  const current = isControlled ? (value as T) : internal;
  const setValue = React.useCallback(
    (next: T) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );
  return [current, setValue];
}

/**
 * 焦点陷阱：激活时把 Tab 限制在容器内，并聚焦首个可聚焦元素；关闭时恢复。
 *
 * 注意 `onClose` 的处理：Modal / Drawer / Popover / ContextMenu / CommandPalette
 * 都传入内联箭头函数（每次渲染都是新引用）。若把它放进 effect 依赖，陷阱会在
 * **每一次渲染后重新执行**，于是"首次聚焦"被反复触发 —— 表现为弹窗里除第一个
 * 输入框以外都无法连续输入（每敲一个字焦点就被拉回第一个控件）。
 * 因此这里用 ref 持有回调：回调始终最新，但不参与依赖。
 */
export function useFocusTrap(
  ref: React.RefObject<HTMLElement>,
  active: boolean,
  onClose?: () => void,
): void {
  const closeRef = React.useRef(onClose);
  React.useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const prevFocused = (
      typeof document !== 'undefined' ? document.activeElement : null
    ) as HTMLElement | null;

    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    const first = focusables()[0];
    if (first) first.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (!firstEl || !lastEl) return;
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && activeEl === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && activeEl === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    // Escape 挂在 document 上：焦点可能不在面板内（如面板无可聚焦元素）
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      prevFocused?.focus?.();
    };
    // 依赖里刻意不含 onClose（见函数头注释）
  }, [active, ref]);
}

let idSeq = 0;
/** 稳定的组件内唯一 id（jsdom / SSR 安全）。 */
export function useStableId(prefix: string): string {
  const ref = React.useRef<string | null>(null);
  if (ref.current === null) ref.current = `${prefix}-${(++idSeq).toString(36)}`;
  return ref.current;
}
