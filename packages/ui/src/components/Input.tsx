/**
 * Input：文本输入。支持受控/非受控、错误态、前后缀、清空。
 */
import * as React from 'react';
import { cx } from '../cx';
import { useControllableState } from '../_internal';

export interface InputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'defaultValue' | 'onChange' | 'prefix' | 'suffix'
> {
  value?: string | undefined;
  defaultValue?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  invalid?: boolean | undefined;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  clearable?: boolean;
  onClear?: () => void;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  const {
    value,
    defaultValue = '',
    onChange,
    invalid = false,
    prefix,
    suffix,
    clearable = false,
    onClear,
    className,
    disabled,
    id,
    ...rest
  } = props;

  const [val, setVal] = useControllableState<string>({ value, defaultValue, onChange });
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => setVal(e.target.value);

  const showClear = clearable && !disabled && val.length > 0;

  return (
    <div
      className={cx(
        'ec-input',
        invalid && 'ec-input--invalid',
        disabled && 'ec-input--disabled',
        className,
      )}
    >
      {prefix && (
        <span className="ec-input__prefix" aria-hidden="true">
          {prefix}
        </span>
      )}
      <input
        ref={inputRef}
        id={id}
        className="ec-input__control"
        value={val}
        {...(disabled ? { disabled: true } : {})}
        {...(invalid ? { 'aria-invalid': true } : {})}
        onChange={handleChange}
        {...rest}
      />
      {showClear && (
        <button
          type="button"
          className="ec-input__clear"
          aria-label="清空输入"
          onClick={() => {
            setVal('');
            onClear?.();
            inputRef.current?.focus();
          }}
        >
          ×
        </button>
      )}
      {suffix && !showClear && (
        <span className="ec-input__suffix" aria-hidden="true">
          {suffix}
        </span>
      )}
    </div>
  );
});
