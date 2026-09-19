/**
 * Radio：单选框。配合相同 name 的多个 Radio 组成单选组，原生支持方向键导航。
 */
import * as React from 'react';
import { cx } from '../cx';
import { useControllableState } from '../_internal';

export interface RadioProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'checked' | 'onChange' | 'type'
> {
  value?: string | undefined;
  checked?: boolean | undefined;
  defaultChecked?: boolean | undefined;
  onChange?: ((checked: boolean) => void) | undefined;
  label?: React.ReactNode;
}

export function RadioGroup({
  name,
  value,
  defaultValue,
  onChange,
  className,
  children,
}: {
  name: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const [val, setVal] = useControllableState<string>({
    value,
    defaultValue: defaultValue ?? '',
    onChange,
  });
  return (
    <div className={cx('ec-radio-group', className)} role="radiogroup">
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        return React.cloneElement(
          child as React.ReactElement<RadioProps>,
          {
            name,
            checked: (child as React.ReactElement<RadioProps>).props.value === val,
            onChange: () =>
              setVal(String((child as React.ReactElement<RadioProps>).props.value ?? '')),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as Partial<RadioProps>,
        );
      })}
    </div>
  );
}

export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(function Radio(props, ref) {
  const {
    checked,
    defaultChecked = false,
    onChange,
    label,
    className,
    disabled,
    id,
    value,
    ...rest
  } = props;
  const [val, setVal] = useControllableState<boolean>({
    value: checked,
    defaultValue: defaultChecked,
    onChange,
  });
  const autoId = React.useId();
  const controlId = id ?? autoId;
  return (
    <label
      className={cx('ec-radio', disabled && 'ec-radio--disabled', className)}
      htmlFor={controlId}
    >
      <input
        ref={ref}
        id={controlId}
        type="radio"
        className="ec-radio__input"
        checked={val}
        {...(disabled ? { disabled: true } : {})}
        value={value}
        onChange={(e) => setVal(e.target.checked)}
        {...rest}
      />
      <span className="ec-radio__circle" aria-hidden="true" />
      {label != null && <span className="ec-radio__label">{label}</span>}
    </label>
  );
});
