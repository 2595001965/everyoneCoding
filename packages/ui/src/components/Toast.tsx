/**
 * Toast：全局轻提示。ToastProvider 提供 Context，useToast() 获取 toast() 方法。
 * 容器固定右下角，aria-live=polite；自动消失，支持手动关闭。
 */
import * as React from 'react';
import { cx } from '../cx';
import { Portal } from '../_internal';

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger';

export interface ToastOptions {
  title?: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

interface ToastRecord extends ToastOptions {
  id: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export interface ToastProviderProps {
  children?: React.ReactNode;
  max?: number;
}

export function ToastProvider({ children, max = 5 }: ToastProviderProps): React.ReactElement {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);
  const seq = React.useRef(0);

  const dismiss = React.useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback(
    (options: ToastOptions) => {
      const id = ++seq.current;
      setToasts((list) => [...list, { id, ...options }].slice(-max));
      const duration = options.duration ?? 3000;
      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss, max],
  );

  const value = React.useMemo<ToastContextValue>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Portal>
        <div className="ec-toast-region" role="region" aria-live="polite" aria-label="通知">
          {toasts.map((t) => (
            <div key={t.id} className={cx('ec-toast', `ec-toast--${t.variant ?? 'info'}`)} role="status">
              <div className="ec-toast__content">
                {t.title && <div className="ec-toast__title">{t.title}</div>}
                {t.description && <div className="ec-toast__desc">{t.description}</div>}
              </div>
              <button
                type="button"
                className="ec-toast__close"
                aria-label="关闭通知"
                onClick={() => dismiss(t.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </Portal>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return ctx;
}
