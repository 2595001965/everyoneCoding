/**
 * Textarea：多行文本输入。支持受控/非受控、错误态、自动高度（可选）。
 */
import * as React from 'react';
import { cx } from '../cx';
import { useControllableState } from '../_internal';

export interface TextareaProps
  extends Omit<
    React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    'value' | 'defaultValue' | 'onChange'
  > {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  invalid?: boolean;
  autoSize?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  props,
  ref,
) {
  const { value, defaultValue = '', onChange, invalid = false, autoSize = false, className, ...rest } =
    props;
  const [val, setVal] = useControllableState<string>({ value, defaultValue, onChange });
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement);

  const resize = React.useCallback(() => {
    const el = innerRef.current;
    if (!el || !autoSize) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [autoSize]);

  React.useLayoutEffect(resize, [val, resize]);

  return (
    <textarea
      ref={innerRef}
      className={cx('ec-textarea', invalid && 'ec-textarea--invalid', className)}
      value={val}
      aria-invalid={invalid || undefined}
      onChange={(e) => setVal(e.target.value)}
      {...rest}
    />
  );
});
