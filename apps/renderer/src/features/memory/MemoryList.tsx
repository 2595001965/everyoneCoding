import { Checkbox, List, Tag } from '@ec/ui';
import { LAYER_LABELS, layerOf, type MemoryItem } from '@ec/memory';

import { ConflictBadge } from './ConflictBadge';
import type { ConflictAnnotation } from './memory-api';

/**
 * 记忆列表（FR-MEM-21）。
 *
 * 每行：勾选框 + 标题 + 层级标签 + 标签 + 重要度 + 置顶星标 + 冲突徽标。
 * 用 `@ec/ui` 的 List（虚拟化），因此行高固定为 `ROW_HEIGHT`。
 */

export const ROW_HEIGHT = 56;

export interface MemoryListProps {
  items: readonly MemoryItem[];
  height?: number;
  selectedId?: string | null;
  checkedIds?: readonly string[];
  /** memoryId → 该条目的冲突标注（可能同时被覆盖与覆盖他人） */
  conflicts?: Record<string, ConflictAnnotation[]>;
  onSelect?: (id: string) => void;
  onCheck?: (id: string, checked: boolean) => void;
  emptyText?: string;
}

export function MemoryList({
  items,
  height = 480,
  selectedId = null,
  checkedIds = [],
  conflicts = {},
  onSelect,
  onCheck,
  emptyText = '当前条件下没有记忆条目',
}: MemoryListProps): JSX.Element {
  if (items.length === 0) {
    return (
      <div className="ec-memory-list__empty" role="status">
        {emptyText}
      </div>
    );
  }

  // List 要求可变数组，这里做一次浅拷贝（数量级在百条内，代价可忽略）
  const rows = [...items];

  return (
    <List
      items={rows}
      itemHeight={ROW_HEIGHT}
      height={height}
      getItemKey={(item) => item.id}
      aria-label="记忆条目列表"
      renderItem={(item) => {
        const checked = checkedIds.includes(item.id);
        const annotations = conflicts[item.id] ?? [];
        const isSelected = item.id === selectedId;
        return (
          <div
            className={`ec-memory-list__row${isSelected ? ' ec-memory-list__row--selected' : ''}`}
            data-testid={`memory-row-${item.id}`}
            onClick={() => onSelect?.(item.id)}
          >
            <span className="ec-memory-list__check" onClick={(event) => event.stopPropagation()}>
              <Checkbox
                checked={checked}
                onChange={(next) => onCheck?.(item.id, next)}
                aria-label={`选择「${item.title}」`}
              />
            </span>
            <span className="ec-memory-list__main">
              <span className="ec-memory-list__title">
                {item.pinned && (
                  <span className="ec-memory-list__pin" title="已置顶" aria-label="已置顶">
                    ★
                  </span>
                )}
                {item.title}
                {item.issueStatus === 'unsolved' && (
                  <span className="ec-memory-list__issue" title="进行中问题">
                    进行中
                  </span>
                )}
              </span>
              <span className="ec-memory-list__meta">
                <Tag color="neutral">{LAYER_LABELS[layerOf(item)]}</Tag>
                {item.tags.slice(0, 4).map((tag) => (
                  <Tag key={tag} color="info">
                    {tag}
                  </Tag>
                ))}
                <span className="ec-memory-list__importance" title={`重要度 ${item.importance}`}>
                  重要度 {item.importance}
                </span>
                {item.status !== 'active' && <span className="ec-memory-list__status">已归档</span>}
              </span>
              {annotations.length > 0 && (
                <span className="ec-memory-list__conflicts">
                  {annotations.map((annotation) => (
                    <ConflictBadge
                      key={`${annotation.counterpartId}:${annotation.field}:${annotation.role}`}
                      annotation={annotation}
                    />
                  ))}
                </span>
              )}
            </span>
          </div>
        );
      }}
    />
  );
}
