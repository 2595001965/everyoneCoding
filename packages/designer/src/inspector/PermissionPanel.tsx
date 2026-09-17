import type * as React from 'react';

import { Button, Select } from '@ec/ui';

import type { PermissionRule } from '../dsl/types';
import { ConditionEditor } from './ConditionPanel';

/**
 * 权限分区（T3-05 要点 3）。
 *
 * 规则 = 权限类型（控制可见 / 控制可编辑）+ 允许角色 + 可选附加条件。
 * 求值由 `shared/condition.evaluatePermission()` 完成（结构化，不使用 eval）。
 */

export const PERMISSION_MODES = [
  { value: 'visible', label: '控制可见' },
  { value: 'editable', label: '控制可编辑' },
] as const;

/** 权限类型的中文标签 */
export const PERMISSION_MODE_LABELS: Record<PermissionRule['mode'], string> = {
  visible: '控制可见',
  editable: '控制可编辑',
};

export interface PermissionPanelProps {
  value: PermissionRule | null | undefined;
  onChange: (next: PermissionRule | null) => void;
  suggestions?: readonly string[];
}

export function PermissionPanel({ value, onChange, suggestions }: PermissionPanelProps): React.ReactElement {
  const rule: PermissionRule = value ?? { mode: 'visible', roles: [] };

  return (
    <div className="ec-permission-panel" data-testid="permission-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ fontSize: 12, opacity: 0.65 }}>按角色控制可见 / 可编辑；角色留空表示不限制角色。</p>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 12 }}>权限类型</span>
        <Select
          aria-label="权限类型"
          value={rule.mode}
          options={PERMISSION_MODES.map((item) => ({ label: item.label, value: item.value }))}
          onChange={(next) => onChange({ ...rule, mode: next as PermissionRule['mode'] })}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 12 }}>允许的角色（逗号分隔）</span>
        <input
          aria-label="允许的角色"
          value={rule.roles.join(',')}
          placeholder="如 admin,owner"
          onChange={(event) =>
            onChange({
              ...rule,
              roles: event.target.value
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item.length > 0),
            })
          }
          style={{ padding: '4px 8px' }}
        />
      </label>

      <ConditionEditor
        value={rule.condition ?? null}
        onChange={(next) => onChange({ ...rule, condition: next })}
        title="附加条件"
        testId="permission-condition"
        {...(suggestions !== undefined ? { suggestions } : {})}
      />

      <div>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          清除权限规则
        </Button>
      </div>
    </div>
  );
}
