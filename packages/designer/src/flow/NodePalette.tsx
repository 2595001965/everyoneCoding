/**
 * 节点面板（T3-09）：列出五类动作节点（中文名 + 图标），点击加入画布。
 */

import type * as React from 'react';

import { ACTION_KINDS, type ActionKind } from '../dsl/types';
import { ACTION_LABELS, FLOW_NODE_SPECS } from './flow-schema';

export interface NodePaletteProps {
  onAdd: (kind: ActionKind) => void;
}

export function NodePalette(props: NodePaletteProps): React.ReactElement {
  const { onAdd } = props;
  return (
    <div className="ec-node-palette" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8 }}>
      <div style={{ fontSize: 12, opacity: 0.6 }}>动作节点</div>
      {ACTION_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          data-testid={`palette-${kind}`}
          onClick={() => onAdd(kind)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            border: '1px solid #ced4da',
            borderRadius: 6,
            background: '#fff',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 16 }}>
            {FLOW_NODE_SPECS[kind].icon}
          </span>
          <span>{ACTION_LABELS[kind]}</span>
        </button>
      ))}
    </div>
  );
}
