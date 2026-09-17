import * as React from 'react';
import { Button, EmptyState, SearchInput, Select, Tag } from '@ec/ui';

import {
  NOTE_TARGET_LABELS,
  NOTE_TARGET_TYPES,
  NOTE_TYPES,
  NOTE_TYPE_META,
  documentToText,
  type Note,
  type NoteStatus,
  type NoteTargetType,
  type NoteType,
} from './note-model';
import type { NoteRepository } from './note-repo';

/**
 * NotePanel：备注集中面板（T4-01 要点 3）。
 *
 * - 展示当前项目全部备注，可按「目标类型 / 备注类型 / 状态」筛选并全文搜索；
 * - 点击条目跳转到对应元素并高亮（由调用方实现 `onJumpToTarget`）；
 * - 未解决备注计数通过 `onCountChange` 暴露给项目仪表盘（FR-ANN：未解决备注计入仪表盘）；
 * - 删除为破坏性操作，必须先二次确认（P 块硬约束 6）。
 */

export interface NoteJumpTarget {
  targetType: NoteTargetType;
  targetId: string;
  noteId: string;
}

export interface NotePanelProps {
  repository: NoteRepository;
  /** 解析目标显示名（元素名 / 页面名 / 功能名） */
  resolveTargetLabel?: ((note: Note) => string) | undefined;
  onJumpToTarget?: ((target: NoteJumpTarget) => void) | undefined;
  onOpenHistory?: ((noteId: string) => void) | undefined;
  onEdit?: ((note: Note) => void) | undefined;
  /** 未解决数量变化（项目仪表盘订阅） */
  onCountChange?: ((counts: NoteCountSnapshot) => void) | undefined;
  /** 面板高度（虚拟化由 @ec/ui List 负责，这里仅限制滚动区域） */
  height?: number;
}

export interface NoteCountSnapshot {
  unresolved: number;
  mustFollow: number;
  byType: Record<NoteType, number>;
}

const TYPE_FILTER_OPTIONS = [
  { value: 'all', label: '全部类型' },
  ...NOTE_TYPES.map((type) => ({ value: type, label: NOTE_TYPE_META[type].label })),
];

const TARGET_FILTER_OPTIONS = [
  { value: 'all', label: '全部层级' },
  ...NOTE_TARGET_TYPES.map((type) => ({ value: type, label: NOTE_TARGET_LABELS[type] })),
];

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'open', label: '未解决' },
  { value: 'resolved', label: '已解决' },
];

export function NotePanel({
  repository,
  resolveTargetLabel,
  onJumpToTarget,
  onOpenHistory,
  onEdit,
  onCountChange,
  height = 420,
}: NotePanelProps): React.ReactElement {
  useNotesRevision(repository);

  const [typeFilter, setTypeFilter] = React.useState<string>('all');
  const [targetFilter, setTargetFilter] = React.useState<string>('all');
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [keyword, setKeyword] = React.useState('');
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);

  const notes = repository.list({
    ...(typeFilter !== 'all' ? { type: typeFilter as NoteType } : {}),
    ...(targetFilter !== 'all' ? { targetType: targetFilter as NoteTargetType } : {}),
    ...(statusFilter !== 'all' ? { status: statusFilter as NoteStatus } : {}),
    ...(keyword.trim().length > 0 ? { text: keyword } : {}),
  });

  const unresolved = repository.unresolvedCount();
  const byType = repository.countsByType();
  const mustFollow = byType.forbidden;

  // 依赖用 JSON 指纹而不是对象引用：否则父组件每次重渲染都会产生新对象，
  // 回调里若 setState 就会形成「渲染 → 通知 → setState → 再渲染」的死循环。
  const byTypeKey = JSON.stringify(byType);
  const countCallback = React.useRef(onCountChange);
  countCallback.current = onCountChange;

  React.useEffect(() => {
    countCallback.current?.({ unresolved, mustFollow, byType: JSON.parse(byTypeKey) as Record<NoteType, number> });
  }, [unresolved, mustFollow, byTypeKey]);

  return (
    <section className="ec-note-panel" aria-label="备注面板" data-unresolved={unresolved}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>备注</strong>
        <Tag color={unresolved > 0 ? 'warning' : 'neutral'}>{`未解决 ${unresolved}`}</Tag>
        {mustFollow > 0 && <Tag color="danger">{`禁止事项 ${mustFollow}`}</Tag>}
        <span style={{ flex: 1 }} />
        <SearchInput
          aria-label="搜索备注"
          placeholder="搜索标题 / 正文 / 清单"
          value={keyword}
          onChange={setKeyword}
        />
      </header>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <Select
          size="sm"
          aria-label="按层级筛选"
          value={targetFilter}
          options={TARGET_FILTER_OPTIONS}
          onChange={setTargetFilter}
        />
        <Select size="sm" aria-label="按类型筛选" value={typeFilter} options={TYPE_FILTER_OPTIONS} onChange={setTypeFilter} />
        <Select size="sm" aria-label="按状态筛选" value={statusFilter} options={STATUS_FILTER_OPTIONS} onChange={setStatusFilter} />
      </div>

      {notes.length === 0 ? (
        <EmptyState title="暂无备注" description="在画布元素上右键、或在页面标签页添加「页面备注」。" />
      ) : (
        <ul
          className="ec-note-panel__list"
          style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: height, overflow: 'auto' }}
        >
          {notes.map((note) => {
            const meta = NOTE_TYPE_META[note.type];
            const body = documentToText(note.content);
            const targetLabel = resolveTargetLabel?.(note) ?? note.targetId;
            return (
              <li
                key={note.id}
                data-note-id={note.id}
                data-note-type={note.type}
                data-note-status={note.status}
                style={{
                  border: '1px solid var(--ec-border, #e2e8f0)',
                  borderLeft: `3px solid ${meta.color}`,
                  borderRadius: 6,
                  padding: '8px 10px',
                  marginBottom: 8,
                  background: note.status === 'resolved' ? 'var(--ec-surface-sunken, #f8fafc)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Tag color={note.type === 'forbidden' ? 'danger' : 'info'}>{meta.label}</Tag>
                  <span style={{ fontSize: 12, color: 'var(--ec-text-secondary, #64748b)' }}>
                    {`${NOTE_TARGET_LABELS[note.targetType]}·${targetLabel}`}
                  </span>
                  <Tag color="neutral">{`P${note.priority}`}</Tag>
                  {note.status === 'resolved' && <Tag color="success">已解决</Tag>}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: 'var(--ec-text-secondary, #64748b)' }}>{`v${note.version}`}</span>
                </div>

                <div style={{ fontSize: 13, fontWeight: 600 }}>{note.title.length > 0 ? note.title : '(无标题)'}</div>
                {body.length > 0 && (
                  <p style={{ margin: '4px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' }}>{body}</p>
                )}
                {note.checklists.length > 0 && (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
                    {note.checklists.map((item) => (
                      <li key={item.id} style={{ textDecoration: item.checked ? 'line-through' : 'none' }}>
                        {item.text}
                      </li>
                    ))}
                  </ul>
                )}
                {note.codeBlocks.length > 0 && (
                  <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--ec-text-secondary, #64748b)' }}>
                    {`含 ${note.codeBlocks.length} 个代码片段（${note.codeBlocks.map((block) => block.language).join(', ')}）`}
                  </p>
                )}

                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`跳转到 ${targetLabel}`}
                    disabled={onJumpToTarget === undefined}
                    onClick={() =>
                      onJumpToTarget?.({ targetType: note.targetType, targetId: note.targetId, noteId: note.id })
                    }
                  >
                    定位
                  </Button>
                  <Button size="sm" variant="ghost" disabled={onEdit === undefined} onClick={() => onEdit?.(note)}>
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`查看 ${note.title.length > 0 ? note.title : note.id} 的历史`}
                    disabled={onOpenHistory === undefined}
                    onClick={() => onOpenHistory?.(note.id)}
                  >
                    历史
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      note.status === 'open' ? repository.resolve(note.id) : repository.reopen(note.id)
                    }
                  >
                    {note.status === 'open' ? '标记已解决' : '重新打开'}
                  </Button>
                  {pendingDelete === note.id ? (
                    <>
                      <span role="alert" style={{ fontSize: 12, color: NOTE_TYPE_META.forbidden.color }}>
                        删除后历史一并丢失，确认？
                      </span>
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`确认删除 ${note.id}`}
                        onClick={() => {
                          repository.remove(note.id);
                          setPendingDelete(null);
                        }}
                      >
                        确认删除
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPendingDelete(null)}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" aria-label={`删除 ${note.id}`} onClick={() => setPendingDelete(note.id)}>
                      删除
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** 订阅仓库变更：仓库的写操作会递增 revision，触发面板重渲染 */
export function useNotesRevision(repository: NoteRepository): number {
  return React.useSyncExternalStore(repository.subscribe, repository.getRevision, repository.getRevision);
}
