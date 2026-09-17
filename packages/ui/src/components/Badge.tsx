/**
 * Badge：状态徽标。color 走语义色令牌。
 */
import type * as React from 'react';
import { cx } from '../cx';

export type BadgeColor = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  color?: BadgeColor;
  dot?: boolean;
}

export function Badge({
  color = 'neutral',
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps): React.ReactElement {
  return (
    <span className={cx('ec-badge', `ec-badge--${color}`, className)} {...rest}>
      {dot && <span className="ec-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
