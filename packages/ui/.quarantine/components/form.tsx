import { forwardRef, useId, useState } from 'react';
import { cx } from '../cx';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** 无障碍名（未用 label 包裹时必填） */
  label?: string;
  status?: 'default' | 'error' | 'warning';
  errorText?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, status = 'default', errorText, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={cx('ec-field', className)}>
      {label !== undefined ? (
        <label className="ec-field__label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        className={cx('ec-input', status !== 'default' && `ec-input--${status}`)}
        aria-invalid={status === 'error'}
        aria-describedby={errorText !== undefined ? `${inputId}-desc` : undefined}
        {...rest}
      />
      {errorText !== undefined ? (
        <div id={`${inputId}-desc`} role="alert" className="ec-field__error">
          {errorText}
        </div>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const areaId = id ?? autoId;
  return (
    <div className={cx('ec-field', className)}>
      {label !== undefined ? (
        <label className="ec-field__label" htmlFor={areaId}>
          {label}
        </label>
      ) : null}
      <textarea ref={ref} id={areaId} className="ec-textarea" {...rest} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  label?: string;
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, label, placeholder, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className={cx('ec-field', className)}>
      {label !== undefined ? (
        <label className="ec-field__label" htmlFor={selectId}>
          {label}
        </label>
      ) : null}
      <select ref={ref} id={selectId} className="ec-select" {...rest}>
        {placeholder !== undefined ? (
          <option value="" disabled={rest.required === true}>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------

export interface CheckboxProps {
  checked: boolean;
  /** 非受控模式初值 */
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  indeterminate?: boolean;
}

export function Checkbox({
  checked,
  defaultChecked,
  onChange,
  label,
  disabled = false,
  indeterminate = false,
}: CheckboxProps) {
  const [inner, setInner] = useState(defaultChecked ?? false);
  const isControlled = checked !== undefined;
  const value = isControlled ? checked : inner;

  return (
    <label className={cx('ec-check', disabled && 'ec-check--disabled')}>
      <input
        type="checkbox"
        className="ec-check__input"
        checked={value}
        ref={(node) => {
          if (node) node.indeterminate = indeterminate && !value;
        }}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.checked;
          if (!isControlled) setInner(next);
          onChange?.(next);
        }}
      />
      <span aria-hidden="true" className="ec-check__box">
        {indeterminate && !value ? '–' : value ? '✓' : ''}
      </span>
      <span className="ec-check__label">{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Radio（分组）
// ---------------------------------------------------------------------------

export interface RadioGroupOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface RadioGroupProps {
  options: RadioGroupOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  name?: string;
}

export function RadioGroup({ options, value, onChange, label, name }: RadioGroupProps) {
  const groupName = name ?? useId();
  return (
    <div role="radiogroup" aria-label={label} className="ec-radio-group">
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label key={option.value} className={cx('ec-radio', option.disabled && 'ec-radio--disabled')}>
            <input
              type="radio"
              name={groupName}
              className="ec-radio__input"
              checked={checked}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span aria-hidden="true" className="ec-radio__dot" />
            <span className="ec-radio__label">{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <label className={cx('ec-switch', disabled && 'ec-switch--disabled')}>
      <input
        type="checkbox"
        role="switch"
        className="ec-switch__input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden="true" className="ec-switch__track">
        <span className="ec-switch__thumb" />
      </span>
      <span className="ec-switch__label">{label}</span>
    </label>
  );
}
