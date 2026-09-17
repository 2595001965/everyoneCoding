import { useState } from 'react';

import { Badge } from '@ec/ui';
import { LAYER_LABELS } from '@ec/memory';

import type { ConflictAnnotation } from './memory-api';

/**
 * 冲突来源徽标（FR-MEM-06：UI 标注冲突来源）。
 *
 * 两种角色：
 * - `loser`：本条目被更具体的一层接管 → 徽标「已覆盖：<层级>·<标题>」
 * - `winner`：本条目接管了更靠上的一层 → 徽标「覆盖了：<层级>·<标题>」
 *
 * 点击展开被覆盖内容与差异（字段名 + 双方取值），默认收起以免打扰。
 */

export interface ConflictBadgeProps {
  annotation: ConflictAnnotation;
  defaultExpanded?: boolean;
}

export function conflictBadgeText(annotation: ConflictAnnotation): string {
  const target = `${LAYER_LABELS[annotation.counterpartLayer]}·${annotation.counterpartTitle}`;
  return annotation.role === 'loser' ? `已覆盖：${target}` : `覆盖了：${target}`;
}

export function ConflictBadge({ annotation, defaultExpanded = false }: ConflictBadgeProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const text = conflictBadgeText(annotation);

  return (
    <span className="ec-conflict-badge">
      <Badge color={annotation.role === 'loser' ? 'warning' : 'info'}>
        <button
          type="button"
          className="ec-conflict-badge__trigger"
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          {text}
        </button>
      </Badge>
      {expanded && (
        <span className="ec-conflict-badge__detail" role="region" aria-label={`${text} 的差异详情`}>
          <span className="ec-conflict-badge__field">冲突字段：{annotation.field}</span>
          <span className="ec-conflict-badge__value">
            <span className="ec-conflict-badge__value-label">本条</span>
            <code>{formatValue(annotation.ownValue)}</code>
          </span>
          <span className="ec-conflict-badge__value">
            <span className="ec-conflict-badge__value-label">
              {LAYER_LABELS[annotation.counterpartLayer]}
            </span>
            <code>{formatValue(annotation.counterpartValue)}</code>
          </span>
        </span>
      )}
    </span>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '（空）';
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
