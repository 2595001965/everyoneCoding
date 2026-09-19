import * as React from 'react';

import { Checkbox, Input, Select, Textarea } from '@ec/ui';

import {
  groupFields,
  visibleFields,
  type PropField,
  type PropSchema,
} from '../registry/prop-schema';

/**
 * SchemaForm：据组件属性 JSON Schema **自动生成表单**（T3-05 要点 1）。
 *
 * - 支持 text / textarea / number / boolean / enum / color / size / spacing / shadow /
 *   border / json / columns / image / options 全部控件类型；
 * - 分组折叠（来自 `PropGroup`）与条件显隐（`visibleWhen`）；
 * - 文本类输入 **200ms 防抖**：本地即时回显，安静 200ms 后才提交，
 *   配合撤销栈的 `coalesceKey` 保证"连续输入合并为一步 undo"（T3-05 验收项）。
 *
 * 表单不持有文档状态：值由外部传入，变更通过 `onChange(key, value, options)` 上抛。
 */

export const DEFAULT_DEBOUNCE_MS = 200;

export interface SchemaFormProps {
  schema: PropSchema;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown, options?: { coalesceKey?: string }) => void;
  /** 防抖毫秒（默认 200；传 0 关闭，便于测试同步断言） */
  debounceMs?: number;
  /** 禁用全部字段（如多选批量编辑时的只读字段） */
  disabled?: boolean;
  /** 仅展示这些字段（多选公共属性） */
  onlyKeys?: readonly string[];
  className?: string;
}

/**
 * 文本类字段：本地即时回显 + 静默 200ms 后提交。
 * 外部值变化（撤销、批量修改）时同步回本地。
 */
function useDebouncedText(
  external: unknown,
  commit: (value: string) => void,
  delay: number,
): [string, (next: string) => void] {
  const [local, setLocal] = React.useState(() =>
    external === undefined || external === null ? '' : String(external),
  );
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const touched = React.useRef(false);

  React.useEffect(() => {
    if (touched.current) return;
    setLocal(external === undefined || external === null ? '' : String(external));
  }, [external]);

  React.useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const update = React.useCallback(
    (next: string) => {
      touched.current = true;
      setLocal(next);
      if (timer.current !== null) clearTimeout(timer.current);
      if (delay <= 0) {
        commit(next);
        return;
      }
      timer.current = setTimeout(() => commit(next), delay);
    },
    [commit, delay],
  );

  return [local, update];
}

export function SchemaForm({
  schema,
  values,
  onChange,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  disabled = false,
  onlyKeys,
  className,
}: SchemaFormProps): React.ReactElement {
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});

  const visible = React.useMemo(() => {
    const fields = visibleFields(schema, values);
    return onlyKeys === undefined ? fields : fields.filter((field) => onlyKeys.includes(field.key));
  }, [schema, values, onlyKeys]);

  const groups = React.useMemo(() => groupFields({ fields: visible }), [visible]);

  const emit = React.useCallback(
    (field: PropField, value: unknown): void => {
      onChange(field.key, value, { coalesceKey: `prop:${field.key}` });
    },
    [onChange],
  );

  if (groups.length === 0) {
    return (
      <div className={className} data-testid="schema-form-empty">
        <p style={{ fontSize: 12, opacity: 0.6 }}>该组件没有可编辑属性</p>
      </div>
    );
  }

  return (
    <div className={className} data-testid="schema-form">
      {groups.map(({ group, fields }) => {
        const isCollapsed = collapsed[group] === true;
        return (
          <section key={group} className="ec-schema-form__group" data-group={group}>
            <button
              type="button"
              className="ec-schema-form__group-head"
              aria-expanded={!isCollapsed}
              data-testid={`schema-group-${group}`}
              onClick={() => setCollapsed((prev) => ({ ...prev, [group]: !isCollapsed }))}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                background: 'none',
                border: 'none',
                padding: '6px 2px',
                cursor: 'pointer',
                fontSize: 12,
                opacity: 0.75,
              }}
            >
              <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
              {group}
            </button>
            {!isCollapsed && (
              <div
                className="ec-schema-form__fields"
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                {fields.map((field) => (
                  <PropFieldControl
                    key={field.key}
                    field={field}
                    value={values[field.key]}
                    disabled={disabled}
                    debounceMs={debounceMs}
                    onChange={(value) => emit(field, value)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** 文本类字段类型（走防抖 + 本地回显） */
const DEBOUNCED_TYPES: ReadonlySet<PropField['type']> = new Set([
  'text',
  'textarea',
  'size',
  'spacing',
  'shadow',
  'border',
  'image',
  'color',
]);

export interface PropFieldControlProps {
  field: PropField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
  debounceMs?: number;
}

/** 单个字段控件：按 `PropFieldType` 分派（导出便于单测覆盖全部控件类型） */
export function PropFieldControl({
  field,
  value,
  disabled,
  onChange,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: PropFieldControlProps): React.ReactElement {
  const label =
    field.unit !== undefined && field.unit.length > 0
      ? `${field.label}（${field.unit}）`
      : field.label;
  const debounced = DEBOUNCED_TYPES.has(field.type);
  const rawValue = value === undefined || value === null ? '' : String(value);
  const commit = React.useCallback((next: string) => onChange(next), [onChange]);
  const [local, setLocal] = useDebouncedText(
    debounced ? value : '',
    commit,
    debounced ? debounceMs : 0,
  );

  const textLike = (rows?: number): React.ReactElement => {
    const shared = {
      'aria-label': label,
      value: debounced ? local : rawValue,
      disabled,
      ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
      onChange: (next: string) => (debounced ? setLocal(next) : onChange(next)),
    };
    return rows === undefined ? <Input {...shared} /> : <Textarea {...shared} rows={rows} />;
  };

  switch (field.type) {
    case 'number':
      return (
        <FieldShell field={field} label={label}>
          <Input
            aria-label={label}
            type="number"
            value={rawValue}
            disabled={disabled}
            onChange={(next) => onChange(next === '' ? undefined : Number(next))}
          />
        </FieldShell>
      );
    case 'boolean':
      return (
        <FieldShell field={field} label={label}>
          <Checkbox
            aria-label={label}
            checked={Boolean(value)}
            disabled={disabled}
            onChange={(checked) => onChange(checked)}
          />
        </FieldShell>
      );
    case 'enum':
      return (
        <FieldShell field={field} label={label}>
          <Select
            aria-label={label}
            value={rawValue}
            options={(field.options ?? []).map((option) => ({
              label: option.label,
              value: option.value,
            }))}
            disabled={disabled}
            onChange={(next) => onChange(next)}
          />
        </FieldShell>
      );
    case 'color':
      return (
        <FieldShell field={field} label={label}>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              aria-label={`${label} 取色器`}
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(rawValue) ? rawValue : '#000000'}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
            />
            {textLike()}
          </span>
        </FieldShell>
      );
    case 'json':
      return (
        <FieldShell field={field} label={label}>
          <JsonField label={label} value={value} disabled={disabled} onChange={onChange} />
        </FieldShell>
      );
    case 'options':
    case 'columns':
      return (
        <FieldShell field={field} label={label}>
          {textLike(4)}
        </FieldShell>
      );
    case 'textarea':
      return (
        <FieldShell field={field} label={label}>
          {textLike(3)}
        </FieldShell>
      );
    default:
      return (
        <FieldShell field={field} label={label}>
          {textLike()}
        </FieldShell>
      );
  }
}

/** JSON 字段：解析成功才回写，失败给中文提示且不污染文档 */
function JsonField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}): React.ReactElement {
  const [raw, setRaw] = React.useState(() =>
    value === undefined ? '' : JSON.stringify(value, null, 2),
  );
  const [error, setError] = React.useState<string | null>(null);
  const focused = React.useRef(false);

  React.useEffect(() => {
    if (focused.current) return;
    setRaw(value === undefined ? '' : JSON.stringify(value, null, 2));
    setError(null);
  }, [value]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Textarea
        aria-label={label}
        rows={4}
        value={raw}
        disabled={disabled}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
        }}
        onChange={(next) => {
          setRaw(next);
          if (next.trim().length === 0) {
            setError(null);
            onChange(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(next);
            setError(null);
            onChange(parsed);
          } catch {
            setError('JSON 格式不正确，暂未写入');
          }
        }}
      />
      {error !== null && (
        <span role="alert" style={{ fontSize: 11, color: 'var(--ec-color-danger, #e5484d)' }}>
          {error}
        </span>
      )}
    </div>
  );
}

function FieldShell({
  field,
  label,
  children,
}: {
  field: PropField;
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label
      data-testid={`prop-field-${field.key}`}
      data-field-type={field.type}
      title={field.description}
      style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      <span style={{ fontSize: 12, opacity: 0.8 }}>{label}</span>
      {children}
    </label>
  );
}
