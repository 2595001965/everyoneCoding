/**
 * PageNode：页面列表中的单个页面行（T3-07）。
 *
 * 展示：平台标签 + 页面名 + 路由；支持单击选中、双击重命名（内联输入）、
 * 复制、删除（删除由父级弹出二次确认 Modal）。
 */
import * as React from 'react';
import { IconButton } from '@ec/ui';

import type { PageDsl } from '../dsl/types';

export interface PageNodeProps {
  page: PageDsl;
  active: boolean;
  onSelect: (id: string) => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onRequestDelete: (id: string) => void;
}

function IconCopy(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function IconTrash(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" />
    </svg>
  );
}

export function PageNode({
  page,
  active,
  onSelect,
  onStartRename,
  onCommitRename,
  onDuplicate,
  onRequestDelete,
}: PageNodeProps): React.ReactElement {
  const [editing, setEditing] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = (value: string): void => {
    const name = value.trim();
    if (name) onCommitRename(page.id, name);
    setEditing(false);
  };

  return (
    <div
      className={`ec-page-node${active ? ' ec-page-node--active' : ''}`}
      data-page-id={page.id}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`页面 ${page.name}（${page.platform}，${page.route}）`}
      onClick={() => onSelect(page.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(page.id);
        }
      }}
      onDoubleClick={() => {
        setEditing(true);
        onStartRename(page.id);
      }}
    >
      <span className="ec-page-node__platform" aria-hidden="true">
        {page.platform}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          className="ec-page-node__input"
          defaultValue={page.name}
          aria-label="重命名页面"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(e.currentTarget.value);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={(e) => commit(e.currentTarget.value)}
        />
      ) : (
        <span className="ec-page-node__name">{page.name}</span>
      )}
      <span className="ec-page-node__route">{page.route}</span>
      <span className="ec-page-node__actions" onClick={(e) => e.stopPropagation()}>
        <IconButton aria-label="复制页面" size="sm" onClick={() => onDuplicate(page.id)}>
          <IconCopy />
        </IconButton>
        <IconButton aria-label="删除页面" size="sm" onClick={() => onRequestDelete(page.id)}>
          <IconTrash />
        </IconButton>
      </span>
    </div>
  );
}
