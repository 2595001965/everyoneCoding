/**
 * SearchInput：带搜索图标与清空按钮的输入框。受控/非受控。
 */
import type * as React from 'react';
import { cx } from '../cx';
import { Input } from './Input';

export interface SearchInputProps {
  value?: string | undefined;
  defaultValue?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  'aria-label'?: string;
}

export function SearchInput({
  value,
  defaultValue,
  onChange,
  placeholder = '搜索',
  className,
  disabled,
  'aria-label': ariaLabel = '搜索',
}: SearchInputProps): React.ReactElement {
  return (
    <Input
      className={cx('ec-search-input', className)}
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      prefix={<span aria-hidden="true">⌕</span>}
      clearable
    />
  );
}
