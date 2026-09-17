import type * as React from 'react';
import { Button, EmptyState, Tag } from '@ec/ui';

import { NOTE_TYPE_META, documentToText, type NoteRevision } from './note-model';
import { useNotesRevision } from './NotePanel';
import type { NoteRepository } from './note-repo';

/**
 * NoteHistory：备注变更留痕（T4-01 要点 4 / FR-ANN-07）。
 *
 * - 每次修改都留一版；`changedFields` 记录字段级差异，便于回答「改了什么」；
 * - 可回退到任意历史版本（回退本身也会留痕，所以可以再回退回来）；
 * - `hasNoteUpdatedSince` 的语义由仓库提供，生成前用它判断要不要提示「重新生成该元素」。
 */

export interface NoteHistoryProps {
  repository: NoteRepository;
  noteId: string;
  /** 回退成功回调（通常用于刷新生成结果页的「备注已更新」提示） */
  onRestored?: ((revision: NoteRevision) => void) | undefined;
  onClose?: (() => void) | undefined;
}

const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  type: '类型',
  content: '正文',
  checklists: '清单',
  codeBlocks: '代码片段',
  status: '状态',
  manualPriority: '优先级',
};

export function NoteHistory({ repository, noteId, onRestored, onClose }: NoteHistoryProps): React.ReactElement {
  useNotesRevision(repository);

  const note = repository.get(noteId);
  if (note === null) {
    return (
      <section className="ec-note-history" aria-label="备注历史">
        <EmptyState title="备注不存在" description="它可能已被删除。" />
      </section>
    );
  }

  const history = repository.historyOf(noteId);
  const meta = NOTE_TYPE_META[note.type];

  return (
    <section className="ec-note-history" aria-label="备注历史" data-note-id={noteId}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>变更历史</strong>
        <Tag color={note.type === 'forbidden' ? 'danger' : 'info'}>{meta.label}</Tag>
        <Tag color="neutral">{`当前 v${note.version}`}</Tag>
        <span style={{ flex: 1 }} />
        {onClose !== undefined && (
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        )}
      </header>

      <div
        data-testid="ec-note-history-current"
        style={{ border: `1px solid ${meta.color}`, borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}
      >
        <div style={{ fontSize: 12, color: meta.color }}>{`v${note.version} · 当前版本`}</div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{note.title.length > 0 ? note.title : '(无标题)'}</div>
        <p style={{ margin: '4px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' }}>{documentToText(note.content)}</p>
      </div>

      {history.length === 0 ? (
        <EmptyState title="暂无历史版本" description="该备注自创建以来只修改过 0 次。" />
      ) : (
        <ol className="ec-note-history__list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {[...history].reverse().map((revision) => (
            <li
              key={revision.version}
              data-revision-version={revision.version}
              style={{
                border: '1px solid var(--ec-border, #e2e8f0)',
                borderRadius: 6,
                padding: '8px 10px',
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{`v${revision.version}`}</span>
                <span style={{ fontSize: 12, color: 'var(--ec-text-secondary, #64748b)' }}>
                  {`${revision.editor} · ${new Date(revision.createdAt).toLocaleString('zh-CN')}`}
                </span>
                <span style={{ flex: 1 }} />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`回退到 v${revision.version}`}
                  onClick={() => {
                    const restored = repository.restore(noteId, revision.version);
                    if (restored !== null) onRestored?.(revision);
                  }}
                >
                  回退到此版本
                </Button>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                {revision.changedFields.length === 0 ? (
                  <Tag color="neutral">无字段变化</Tag>
                ) : (
                  revision.changedFields.map((field) => (
                    <Tag key={field} color="warning">
                      {FIELD_LABELS[field] ?? field}
                    </Tag>
                  ))
                )}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{revision.title.length > 0 ? revision.title : '(无标题)'}</div>
              <p style={{ margin: '4px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {documentToText(revision.content)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
