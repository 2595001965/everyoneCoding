/**
 * LayerNode：图层树中单个元素的行内容（类型标签 + 显示名 + 锁标 / 眼睛标）。
 *
 * - 行整体由 `@ec/ui` 的虚拟树渲染，此处只负责「树格子里显示什么」；
 * - 双击进入重命名（受控于父级的 editing 状态），提交时回调 onCommitRename；
 * - 行内 span 设 `draggable`，使 HTML5 拖拽能从这一行发起（拖拽逻辑见 useLayerDnd）。
 */
import * as React from 'react';

import type { ElementNode } from '../dsl/types';
import { NoteBadge } from '../notes/NoteBadge';
import type { NoteBadgeInfo } from '../notes/note-repo';

export interface LayerNodeProps {
  element: ElementNode;
  /** 是否处于重命名编辑态（父级控制） */
  editing: boolean;
  /** 双击触发重命名 */
  onStartRename: (id: string) => void;
  /** 提交新名称（回车 / 失焦） */
  onCommitRename: (id: string, name: string) => void;
  /** 取消重命名（Esc） */
  onCancelRename: () => void;
  /** 未解决备注角标（T4-01；缺省不渲染） */
  note?: NoteBadgeInfo | null | undefined;
}

function LockIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function EyeOffIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M9.9 4.2A9.5 9.5 0 0 1 12 4c5 0 9 4.5 10 8a12.6 12.6 0 0 1-2.2 3.3" />
      <path d="M6.5 6.6A12.6 12.6 0 0 0 2 12c1 3.5 5 8 10 8a9.3 9.3 0 0 0 4-.9" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}

export function LayerNode({
  element,
  editing,
  onStartRename,
  onCommitRename,
  onCancelRename,
  note = null,
}: LayerNodeProps): React.ReactElement {
  const displayName = element.name ?? element.type;
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (editing) {
    return (
      <span className="ec-layer-node ec-layer-node--editing">
        <input
          ref={inputRef}
          className="ec-layer-node__input"
          defaultValue={displayName}
          draggable={false}
          aria-label="重命名元素"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCommitRename(element.id, e.currentTarget.value.trim() || displayName);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={(e) => onCommitRename(element.id, e.currentTarget.value.trim() || displayName)}
        />
      </span>
    );
  }

  return (
    <span
      className="ec-layer-node"
      data-layer-id={element.id}
      draggable
      title={displayName}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartRename(element.id);
      }}
    >
      {element.locked && (
        <span className="ec-layer-node__badge ec-layer-node__badge--lock" role="img" aria-label="已锁定">
          <LockIcon />
        </span>
      )}
      {element.hidden && (
        <span className="ec-layer-node__badge ec-layer-node__badge--hidden" role="img" aria-label="已隐藏">
          <EyeOffIcon />
        </span>
      )}
      <span className="ec-layer-node__type">{element.type}</span>
      <span className="ec-layer-node__name">{displayName}</span>
      {note !== null && note !== undefined && (
        <span className="ec-layer-node__badge ec-layer-node__badge--note" style={{ marginLeft: 6 }}>
          <NoteBadge info={note} />
        </span>
      )}
    </span>
  );
}
