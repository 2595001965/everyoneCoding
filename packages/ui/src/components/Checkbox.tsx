/**
 * Checkbox：复选框。支持受控/非受控、不确定态（indeterminate）、三态可选。
 * 原生 <input type=checkbox> 处理 Space 切换与焦点。
 */
import * as React from 'react';
import { cx } from '../cx';
import { useControllableState } from '../_internal';

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'checked' | 'onChange' | 'type'> {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  indeterminate?: boolean;
  label?: React.ReactNode;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  props,
  ref,
) {
  const {
    checked,
    defaultChecked = false,
    onChange,
    indeterminate = false,
    label,
    className,
    disabled,
    id,
    ...rest
  } = props;

  const [val, setVal] = useControllableState<boolean>({ value: checked, defaultValue: defaultChecked, onChange });
  const innerRef = React.useRef<HTMLInputElement | null>(null);
  React.useImperativeHandle(ref, () => innerRef.current as HTMLInputElement);

  React.useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const autoId = React.useId();
  const controlId = id ?? autoId;

  return (
    <label className={cx('ec-checkbox', disabled && 'ec-checkbox--disabled', className)} htmlFor={controlId}>
      <input
        ref={innerRef}
        id={controlId}
        type="checkbox"
        className="ec-checkbox__input"
        checked={val}
        {...(disabled ? { disabled: true } : {})}
        onChange={(e) => setVal(e.target.checked)}
        {...rest}
      />
      <span className="ec-checkbox__box" aria-hidden="true" />
      {label != null && <span className="ec-checkbox__label">{label}</span>}
    </label>
  );
});
