/**
 * Tag：可关闭的标签。受控/非受控关闭，支持键盘（Enter/Space 触发关闭按钮）。
 */
import * as React from 'react';
import { cx } from '../cx';

export type TagColor = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  color?: TagColor;
  closable?: boolean;
  onClose?: () => void;
}

export const Tag = React.forwardRef<HTMLSpanElement, TagProps>(function Tag(
  {
    color = 'neutral',
    closable = false,
    onClose,
    className,
    children,
    ...rest
  },
  ref,
) {
  return (
    <span ref={ref} className={cx('ec-tag', `ec-tag--${color}`, className)} {...rest}>
      <span className="ec-tag__label">{children}</span>
      {closable && (
        <button
          type="button"
          className="ec-tag__close"
          aria-label="移除标签"
          onClick={onClose}
        >
          ×
        </button>
      )}
    </span>
  );
});
