/**
 * 单个页面状态变量的编辑表单（T3-08）。
 *
 * - 名称、类型（string/number/boolean/object/array）、初值（按类型输入，
 *   object/array 用 JSON 文本编辑，测试通过 `user.paste()` 输入）、
 *   来源（local|api）、apiRef 选择。
 * - 类型 / 初值不匹配时给出中文校验错误，调用方据此**不写库**。
 */

import * as React from 'react';
import { Button, Checkbox, Input, Select, Textarea } from '@ec/ui';

import { STATE_TYPES, type PageStateVar, type StateType } from '../dsl/types';

/** 类型中文标签 */
export const STATE_TYPE_LABELS: Record<StateType, string> = {
  string: '文本',
  number: '数字',
  boolean: '布尔',
  object: '对象',
  array: '数组',
};

/** 编辑草稿（内部态，initial 一律以字符串形式暂存，保存时按类型解析） */
export interface StateVarDraft {
  name: string;
  type: StateType;
  source: 'local' | 'api';
  apiRef: string;
  description: string;
  initialRaw: string;
}

/** 校验单条状态变量草稿，返回按字段索引的中文错误（空对象表示通过） */
export function validateStateVar(
  draft: StateVarDraft,
  existingNames: readonly string[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = draft.name.trim();
  if (name.length === 0) errors.name = '状态名称不能为空';
  else if (!/^[A-Za-z_一-龥][A-Za-z0-9_一-龥]*$/.test(name)) {
    errors.name = '状态名称需以字母或中文开头，仅可包含字母、数字、下划线';
  } else if (existingNames.includes(name)) {
    errors.name = '状态名称已存在，请更换一个';
  }

  if (draft.source === 'api' && draft.apiRef.trim().length === 0) {
    errors.apiRef = '来源为接口时必须选择关联接口';
  }

  const raw = draft.initialRaw;
  if (draft.type === 'number') {
    if (raw.trim().length === 0) errors.initial = '请填写数字初值';
    else if (Number.isNaN(Number(raw))) errors.initial = '初值必须为合法数字';
  } else if (draft.type === 'object') {
    if (raw.trim().length === 0) errors.initial = '请填写 JSON 对象初值';
    else {
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          errors.initial = '初值必须是合法 JSON 对象';
        }
      } catch {
        errors.initial = '初值不是合法 JSON';
      }
    }
  } else if (draft.type === 'array') {
    if (raw.trim().length === 0) errors.initial = '请填写 JSON 数组初值';
    else {
      try {
        if (!Array.isArray(JSON.parse(raw))) errors.initial = '初值必须是合法 JSON 数组';
      } catch {
        errors.initial = '初值不是合法 JSON';
      }
    }
  }
  return errors;
}

/** 把初值转成表单用的原始字符串 */
function initialToRaw(type: StateType, initial: unknown): string {
  if (initial === undefined) return '';
  if (type === 'string' || type === 'number' || type === 'boolean') return String(initial);
  return JSON.stringify(initial, null, 2);
}

export interface StateEditorProps {
  /** 编辑目标；缺省为空（新建） */
  value?: PageStateVar | undefined;
  /** 已存在的状态名（用于重名校验，自身名称应排除在外） */
  existingNames?: readonly string[];
  /** apiRef 可选接口清单 */
  apiOptions?: readonly string[];
  /** 校验通过并点击保存时回调 */
  onChange: (next: PageStateVar) => void;
  /** 取消编辑 */
  onCancel?: () => void;
}

export function StateEditor(props: StateEditorProps): React.ReactElement {
  const { value, existingNames = [], apiOptions = [], onChange, onCancel } = props;

  const [draft, setDraft] = React.useState<StateVarDraft>(() => ({
    name: value?.name ?? '',
    type: value?.type ?? 'string',
    source: value?.source ?? 'local',
    apiRef: value?.apiRef ?? '',
    description: value?.description ?? '',
    initialRaw: initialToRaw(value?.type ?? 'string', value?.initial),
  }));
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const patch = (partial: Partial<StateVarDraft>): void => {
    setDraft((prev) => {
      const next = { ...prev, ...partial };
      // 切换类型时清空初值，避免旧文本与新类型不匹配造成困惑
      if (partial.type !== undefined && partial.type !== prev.type) next.initialRaw = '';
      return next;
    });
  };

  const handleSave = (): void => {
    const others = existingNames.filter((n) => n !== draft.name.trim());
    const found = validateStateVar(draft, others);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const next: PageStateVar = { name: draft.name.trim(), type: draft.type };
    if (draft.description.trim().length > 0) next.description = draft.description.trim();
    if (draft.source === 'api') {
      next.source = 'api';
      next.apiRef = draft.apiRef;
    } else {
      next.source = 'local';
    }
    if (draft.type === 'number') next.initial = Number(draft.initialRaw);
    else if (draft.type === 'boolean') next.initial = draft.initialRaw === 'true';
    else if (draft.type === 'object' || draft.type === 'array')
      next.initial = JSON.parse(draft.initialRaw);
    else if (draft.initialRaw.length > 0) next.initial = draft.initialRaw;

    onChange(next);
  };

  const typeOptions = STATE_TYPES.map((t) => ({ label: STATE_TYPE_LABELS[t], value: t }));
  const sourceOptions = [
    { label: '页面内维护（local）', value: 'local' },
    { label: '由接口响应写入（api）', value: 'api' },
  ];
  const apiRefOptions = apiOptions.map((a) => ({ label: a, value: a }));

  return (
    <div className="ec-state-editor" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="名称" error={errors.name}>
        <Input
          aria-label="状态名称"
          value={draft.name}
          invalid={Boolean(errors.name)}
          onChange={(v) => patch({ name: v })}
          placeholder="例如 userName"
        />
      </Field>

      <Field label="类型" error={undefined}>
        <Select
          aria-label="状态类型"
          options={typeOptions}
          value={draft.type}
          onChange={(v) => patch({ type: v as StateType })}
        />
      </Field>

      <Field label="来源" error={undefined}>
        <Select
          aria-label="状态来源"
          options={sourceOptions}
          value={draft.source}
          onChange={(v) => patch({ source: v as 'local' | 'api' })}
        />
      </Field>

      {draft.source === 'api' && (
        <Field label="关联接口" error={errors.apiRef}>
          <Select
            aria-label="关联接口"
            options={apiRefOptions}
            value={draft.apiRef}
            invalid={Boolean(errors.apiRef)}
            onChange={(v) => patch({ apiRef: v })}
            placeholder="选择接口"
          />
        </Field>
      )}

      <Field label="初值" error={errors.initial}>
        {draft.type === 'object' || draft.type === 'array' ? (
          <Textarea
            aria-label="初值 JSON"
            value={draft.initialRaw}
            invalid={Boolean(errors.initial)}
            onChange={(v) => patch({ initialRaw: v })}
            placeholder={draft.type === 'object' ? '{ "key": "value" }' : '[1, 2, 3]'}
            rows={4}
          />
        ) : draft.type === 'boolean' ? (
          <Checkbox
            checked={draft.initialRaw === 'true'}
            onChange={(c) => patch({ initialRaw: String(c) })}
            label="初始值为真"
          />
        ) : (
          <Input
            aria-label="初值"
            value={draft.initialRaw}
            invalid={Boolean(errors.initial)}
            type={draft.type === 'number' ? 'number' : 'text'}
            onChange={(v) => patch({ initialRaw: v })}
            placeholder={draft.type === 'number' ? '0' : '文本初值'}
          />
        )}
      </Field>

      <Field label="描述" error={undefined}>
        <Input
          aria-label="状态描述"
          value={draft.description}
          onChange={(v) => patch({ description: v })}
          placeholder="可选说明"
        />
      </Field>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
        )}
        <Button variant="primary" onClick={handleSave}>
          保存
        </Button>
      </div>
    </div>
  );
}

function Field(props: {
  label: string;
  error?: string | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, opacity: 0.8 }}>{props.label}</span>
      {props.children}
      {props.error && (
        <span role="alert" style={{ color: 'var(--ec-color-danger, #e5484d)', fontSize: 12 }}>
          {props.error}
        </span>
      )}
    </label>
  );
}
