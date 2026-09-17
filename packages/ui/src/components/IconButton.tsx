/**
 * IconButton：仅图标的方形按钮，必须提供 aria-label。支持受控禁用/加载态。
 */
import * as React from 'react';
import { cx } from '../cx';
import type { ButtonSize } from './Button';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 必填：无障碍标签，例如“关闭”。 */
  'aria-label': string;
  size?: ButtonSize;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  props,
  ref,
) {
  const {
    size = 'md',
    variant = 'ghost',
    loading = false,
    disabled,
    className,
    children,
    type,
    ...rest
  } = props;

  const isDisabled = disabled || loading;
  const extra = isDisabled ? { disabled: true, 'aria-disabled': true } : {};

  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx(
        'ec-icon-button',
        `ec-button--${variant}`,
        `ec-button--${size}`,
        loading && 'ec-button--loading',
        className,
      )}
      aria-busy={loading || undefined}
      {...extra}
      {...rest}
    >
      {loading ? (
        <span className="ec-button__spinner" aria-hidden="true" />
      ) : (
        <span className="ec-icon-button__glyph" aria-hidden="true">
          {children}
        </span>
      )}
    </button>
  );
});
