import { forwardRef, useState } from 'react';
import { cx } from '../cx';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 加载中：禁用并显示 Spinner */
  loading?: boolean;
  block?: boolean;
}

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'ec-btn--primary',
  secondary: 'ec-btn--secondary',
  ghost: 'ec-btn--ghost',
  danger: 'ec-btn--danger',
};

/** 按钮：Enter / Space 触发（原生 button 语义），加载与禁用态可达性完整 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, block = false, disabled, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-busy={loading}
      disabled={disabled === true || loading}
      className={cx('ec-btn', BUTTON_VARIANT[variant], `ec-btn--${size}`, block && 'ec-btn--block', className)}
      {...rest}
    >
      {loading ? <span className="ec-btn__spinner" aria-hidden="true" /> : null}
      <span className="ec-btn__label">{children}</span>
    </button>
  );
});

// ---------------------------------------------------------------------------
// IconButton
// ---------------------------------------------------------------------------

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 必填：无可见文字，必须提供 aria-label（中文） */
  label: string;
  size?: 'sm' | 'md';
}

/** 图标按钮：无文字内容，可访问性依赖 label */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={cx('ec-iconbtn', `ec-iconbtn--${size}`, className)}
      {...rest}
    >
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Badge / Tag
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** 圆点样式 */
  dot?: boolean;
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'ec-badge--neutral',
  primary: 'ec-badge--primary',
  success: 'ec-badge--success',
  warning: 'ec-badge--warning',
  danger: 'ec-badge--danger',
  info: 'ec-badge--info',
};

export function Badge({ tone = 'neutral', dot = false, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx('ec-badge', TONE_CLASS[tone], className)} {...rest}>
      {dot ? <span className="ec-badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 可关闭 */
  closable?: boolean;
  onClose?: () => void;
}

export function Tag({ closable = false, onClose, className, children, ...rest }: TagProps) {
  return (
    <span className={cx('ec-tag', className)} {...rest}>
      <span className="ec-tag__text">{children}</span>
      {closable ? (
        <button
          type="button"
          className="ec-tag__close"
          aria-label={`移除标签 ${typeof children === 'string' ? children : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose?.();
          }}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Spinner / Progress
// ---------------------------------------------------------------------------

export function Spinner({ size = 16, label = '加载中' }: { size?: number; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="ec-spinner"
      style={{ width: size, height: size }}
    />
  );
}

export interface ProgressProps {
  /** 0–100 */
  value: number;
  label?: string;
  showValue?: boolean;
  tone?: 'primary' | 'success' | 'danger';
}

export function Progress({ value, label, showValue = true, tone = 'primary' }: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="ec-progress"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? '进度'}
    >
      <div className={cx('ec-progress__bar', `ec-progress__bar--${tone}`)} style={{ width: `${clamped}%` }} />
      {showValue ? <span className="ec-progress__value">{Math.round(clamped)}%</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** 操作区（按钮等） */
  action?: React.ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="ec-empty" role="status">
      <div className="ec-empty__icon" aria-hidden="true">
        ◌
      </div>
      <div className="ec-empty__title">{title}</div>
      {description !== undefined ? <div className="ec-empty__desc">{description}</div> : null}
      {action !== undefined ? <div className="ec-empty__action">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

export interface BreadcrumbItem {
  label: string;
  onClick?: () => void;
}

export function Breadcrumb({ items, ariaLabel = '面包屑导航' }: { items: BreadcrumbItem[]; ariaLabel?: string }) {
  return (
    <nav aria-label={ariaLabel} className="ec-breadcrumb">
      <ol className="ec-breadcrumb__list">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="ec-breadcrumb__item">
              {isLast || item.onClick === undefined ? (
                <span aria-current={isLast ? 'page' : undefined} className="ec-breadcrumb__label">
                  {item.label}
                </span>
              ) : (
                <button type="button" className="ec-breadcrumb__link" onClick={item.onClick}>
                  {item.label}
                </button>
              )}
              {!isLast ? (
                <span aria-hidden="true" className="ec-breadcrumb__sep">
                  /
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// SearchInput
// ---------------------------------------------------------------------------

export interface SearchInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Esc 清空 */
  onClear?: () => void;
  placeholder?: string;
}

export function SearchInput({ value, onValueChange, onClear, className, ...rest }: SearchInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <div className={cx('ec-search', focused && 'ec-search--focused', className)}>
      <span aria-hidden="true" className="ec-search__icon">
        ⌕
      </span>
      <input
        type="search"
        role="searchbox"
        className="ec-search__input"
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value.length > 0) {
            event.stopPropagation();
            onValueChange('');
            onClear?.();
          }
          rest.onKeyDown?.(event);
        }}
        {...rest}
      />
      {value.length > 0 ? (
        <button
          type="button"
          className="ec-search__clear"
          aria-label="清空搜索"
          onClick={() => {
            onValueChange('');
            onClear?.();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
