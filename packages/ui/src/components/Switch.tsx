/**
 * Switch：开关。role=switch + aria-checked，Space/Enter 切换（原生 <button> 处理）。
 */
import * as React from 'react';
import { cx } from '../cx';
import { useControllableState } from '../_internal';

export interface SwitchProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onClick' | 'onChange'
> {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(function Switch(props, ref) {
  const { checked, defaultChecked = false, onChange, label, className, disabled, ...rest } = props;
  const [val, setVal] = useControllableState<boolean>({
    value: checked,
    defaultValue: defaultChecked,
    onChange,
  });

  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      className={cx(
        'ec-switch',
        val && 'ec-switch--on',
        disabled && 'ec-switch--disabled',
        className,
      )}
      aria-checked={val}
      aria-label={label}
      {...(disabled ? { disabled: true } : {})}
      onClick={() => setVal(!val)}
      {...rest}
    >
      <span className="ec-switch__thumb" aria-hidden="true" />
    </button>
  );
});
