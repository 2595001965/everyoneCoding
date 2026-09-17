/**
 * Button：基础按钮，支持受控禁用/加载态、变体、尺寸。原生 <button> 已处理 Enter/Space。
 */
import * as React from 'react';
import { cx } from '../cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  props,
  ref,
) {
  const {
    variant = 'secondary',
    size = 'md',
    loading = false,
    fullWidth = false,
    leftIcon,
    rightIcon,
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
        'ec-button',
        `ec-button--${variant}`,
        `ec-button--${size}`,
        fullWidth && 'ec-button--full',
        loading && 'ec-button--loading',
        className,
      )}
      aria-busy={loading || undefined}
      {...extra}
      {...rest}
    >
      {loading && <span className="ec-button__spinner" aria-hidden="true" />}
      {!loading && leftIcon && (
        <span className="ec-button__icon" aria-hidden="true">
          {leftIcon}
        </span>
      )}
      <span className="ec-button__label">{children}</span>
      {!loading && rightIcon && (
        <span className="ec-button__icon" aria-hidden="true">
          {rightIcon}
        </span>
      )}
    </button>
  );
});
