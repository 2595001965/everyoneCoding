/**
 * Spinner：加载指示。role=status + aria-live=polite，默认 aria-label 为中文。
 */
import type * as React from 'react';
import { cx } from '../cx';

export interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

export function Spinner({
  size = 16,
  className,
  label = '加载中',
}: SpinnerProps): React.ReactElement {
  return (
    <span
      className={cx('ec-spinner', className)}
      style={{ width: size, height: size }}
      role="status"
      aria-live="polite"
      aria-label={label}
    />
  );
}
