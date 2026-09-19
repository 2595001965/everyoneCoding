import * as React from 'react';
import { Button, Checkbox, Input, Modal, Select, Textarea } from '@ec/ui';

import type { NoteRepository } from './note-repo';
import {
  INLINE_MARKS,
  NOTE_TARGET_LABELS,
  NOTE_TYPES,
  NOTE_TYPE_META,
  documentToText,
  emptyDocument,
  spansToText,
  textToSpans,
  toggleMarkInSpans,
  type InlineMark,
  type Note,
  type NoteChecklistItem,
  type NoteCodeBlock,
  type NoteTargetType,
  type NoteType,
  type RichTextBlock,
  type RichTextDocument,
} from './note-model';

/**
 * NotePopover：备注编辑弹层（T4-01 要点 2）。
 *
 * 支持：
 * - 富文本（段落 / 标题 / 无序列表 / 有序列表 + 加粗 / 斜体 / 行内代码 / 删除线）
 * - checkbox 清单（可勾选、可增删）
 * - 代码片段（带语言标记）
 * - 六类备注选择与优先级调整（禁止事项自动置顶且不可下调）
 *
 * 三个入口共用本组件：元素右键「添加备注」、页面标签页「页面备注」、功能节点「功能备注」，
 * 差异只在传入的 `target.targetType`。
 */

export interface NoteTargetRef {
  targetType: NoteTargetType;
  targetId: string;
  /** 显示名（元素名 / 页面名 / 功能名） */
  label?: string | undefined;
  pageId?: string | null | undefined;
  featureId?: string | null | undefined;
}

export interface NotePopoverProps {
  open: boolean;
  target: NoteTargetRef | null;
  repository: NoteRepository;
  /** 传入则为编辑既有备注，否则新建 */
  note?: Note | null;
  onClose: () => void;
  onSaved?: ((note: Note) => void) | undefined;
}

const TYPE_OPTIONS = NOTE_TYPES.map((type) => ({ value: type, label: NOTE_TYPE_META[type].label }));
const PRIORITY_OPTIONS = [1, 2, 3, 4, 5].map((value) => ({
  value: String(value),
  label: `P${value}`,
}));

const MARK_LABELS: Record<InlineMark, string> = {
  bold: '加粗',
  italic: '斜体',
  code: '代码',
  strike: '删除线',
};

interface DraftState {
  type: NoteType;
  title: string;
  content: RichTextDocument;
  checklists: NoteChecklistItem[];
  codeBlocks: NoteCodeBlock[];
  manualPriority: number | null;
}

function draftFromNote(note: Note | null | undefined): DraftState {
  if (note === null || note === undefined) {
    return {
      type: 'todo',
      title: '',
      content: emptyDocument(),
      checklists: [],
      codeBlocks: [],
      manualPriority: null,
    };
  }
  return {
    type: note.type,
    title: note.title,
    content: note.content,
    checklists: note.checklists.map((item) => ({ ...item })),
    codeBlocks: note.codeBlocks.map((block) => ({ ...block })),
    manualPriority: note.manualPriority,
  };
}

/* ------------------------------ 单块编辑器 ------------------------------ */

interface BlockEditorProps {
  block: RichTextBlock;
  index: number;
  onChange(next: RichTextBlock): void;
  onRemove(): void;
}

function BlockEditor({ block, index, onChange, onRemove }: BlockEditorProps): React.ReactElement {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  const applyMark = (mark: InlineMark): void => {
    const element = textareaRef.current;
    if (element === null) return;
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    if (block.type === 'paragraph' || block.type === 'heading') {
      onChange({ ...block, spans: toggleMarkInSpans(block.spans, start, end, mark) });
    }
  };

  const changeShape = (shape: string): void => {
    if (block.type === 'paragraph' || block.type === 'heading') {
      const spans = block.spans;
      if (shape === 'paragraph') onChange({ type: 'paragraph', spans });
      else if (shape === 'h1') onChange({ type: 'heading', level: 1, spans });
      else if (shape === 'h2') onChange({ type: 'heading', level: 2, spans });
      else if (shape === 'h3') onChange({ type: 'heading', level: 3, spans });
      else if (shape === 'bullet') onChange({ type: 'bullet-list', items: [spans] });
      else if (shape === 'ordered') onChange({ type: 'ordered-list', items: [spans] });
    } else if (shape === 'paragraph') {
      onChange({ type: 'paragraph', spans: block.items[0] ?? [] });
    }
  };

  const shapeValue =
    block.type === 'heading'
      ? `h${block.level}`
      : block.type === 'bullet-list'
        ? 'bullet'
        : block.type === 'ordered-list'
          ? 'ordered'
          : 'paragraph';

  return (
    <div className="ec-note-block" data-block-index={index} style={{ marginBottom: 8 }}>
      <div
        style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}
      >
        <Select
          size="sm"
          aria-label={`第 ${index + 1} 段格式`}
          value={shapeValue}
          options={[
            { value: 'paragraph', label: '正文' },
            { value: 'h1', label: '标题1' },
            { value: 'h2', label: '标题2' },
            { value: 'h3', label: '标题3' },
            { value: 'bullet', label: '无序列表' },
            { value: 'ordered', label: '有序列表' },
          ]}
          onChange={changeShape}
        />
        {(block.type === 'paragraph' || block.type === 'heading') &&
          INLINE_MARKS.map((mark) => (
            <Button
              key={mark}
              size="sm"
              variant="ghost"
              aria-label={`${MARK_LABELS[mark]}（第 ${index + 1} 段）`}
              onClick={() => applyMark(mark)}
            >
              {MARK_LABELS[mark]}
            </Button>
          ))}
        <Button size="sm" variant="ghost" aria-label={`删除第 ${index + 1} 段`} onClick={onRemove}>
          删除本段
        </Button>
      </div>

      {(block.type === 'paragraph' || block.type === 'heading') && (
        <>
          <Textarea
            ref={textareaRef}
            aria-label={`备注正文 第 ${index + 1} 段`}
            rows={2}
            value={spansToText(block.spans)}
            onChange={(value) => onChange({ ...block, spans: textToSpans(value) })}
          />
          <RichTextPreview spans={block.spans} />
        </>
      )}

      {(block.type === 'bullet-list' || block.type === 'ordered-list') && (
        <div>
          {block.items.map((item, itemIndex) => (
            <div key={itemIndex} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              <Input
                aria-label={`清单项 ${index + 1}-${itemIndex + 1}`}
                value={spansToText(item)}
                onChange={(value) => {
                  const items = block.items.map((current, current_index) =>
                    current_index === itemIndex ? textToSpans(value) : current,
                  );
                  onChange({ ...block, items });
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`删除清单项 ${index + 1}-${itemIndex + 1}`}
                onClick={() => {
                  const items = block.items.filter(
                    (_, current_index) => current_index !== itemIndex,
                  );
                  onChange(
                    items.length === 0 ? { type: 'paragraph', spans: [] } : { ...block, items },
                  );
                }}
              >
                删除
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange({ ...block, items: [...block.items, textToSpans('')] })}
          >
            添加列表项
          </Button>
        </div>
      )}
    </div>
  );
}

/** 富文本预览：把标记渲染为真实样式（用户所见即生成时所注入的文字） */
export function RichTextPreview({
  spans,
}: {
  spans: readonly { text: string; marks: readonly InlineMark[] }[];
}): React.ReactElement | null {
  if (spans.length === 0) return null;
  return (
    <p
      className="ec-note-preview"
      style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--ec-text-secondary, #64748b)' }}
    >
      <span aria-hidden="true">预览：</span>
      {spans.map((span, index) => (
        <span
          key={index}
          style={{
            fontWeight: span.marks.includes('bold') ? 700 : 400,
            fontStyle: span.marks.includes('italic') ? 'italic' : 'normal',
            textDecoration: span.marks.includes('strike') ? 'line-through' : 'none',
            fontFamily: span.marks.includes('code') ? 'monospace' : 'inherit',
            background: span.marks.includes('code')
              ? 'var(--ec-surface-sunken, #f1f5f9)'
              : 'transparent',
          }}
        >
          {span.text}
        </span>
      ))}
    </p>
  );
}

/* ------------------------------ 备注弹层 ------------------------------ */

export function NotePopover({
  open,
  target,
  repository,
  note = null,
  onClose,
  onSaved,
}: NotePopoverProps): React.ReactElement | null {
  const [draft, setDraft] = React.useState<DraftState>(() => draftFromNote(note));
  const [error, setError] = React.useState<string | null>(null);
  const nextTempId = React.useRef(0);

  React.useEffect(() => {
    if (!open) return;
    setDraft(draftFromNote(note));
    setError(null);
  }, [open, note]);

  if (!open || target === null) return null;

  const meta = NOTE_TYPE_META[draft.type];
  const tempId = (prefix: string): string => {
    nextTempId.current += 1;
    return `${prefix}-draft-${nextTempId.current}`;
  };

  const setContent = (index: number, next: RichTextBlock): void => {
    setDraft((current) => ({
      ...current,
      content: {
        type: 'doc',
        blocks: current.content.blocks.map((block, current_index) =>
          current_index === index ? next : block,
        ),
      },
    }));
  };

  const submit = (): void => {
    const plain = documentToText(draft.content).trim();
    if (
      draft.title.trim().length === 0 &&
      plain.length === 0 &&
      draft.checklists.length === 0 &&
      draft.codeBlocks.length === 0
    ) {
      setError('备注内容不能为空（至少填写标题、正文、清单或代码片段之一）。');
      return;
    }
    const payload = {
      type: draft.type,
      title: draft.title,
      content: draft.content,
      checklists: draft.checklists,
      codeBlocks: draft.codeBlocks,
      manualPriority: meta.mustFollow ? null : draft.manualPriority,
    };
    const saved =
      note !== null
        ? repository.update(note.id, payload)
        : repository.create({
            ...payload,
            targetType: target.targetType,
            targetId: target.targetId,
          });
    if (saved === null) {
      setError('备注已不存在，可能被其他窗口删除。');
      return;
    }
    onSaved?.(saved);
    onClose();
  };

  const targetLabel = `${NOTE_TARGET_LABELS[target.targetType]}：${target.label ?? target.targetId}`;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      title={note !== null ? `编辑备注 · ${targetLabel}` : `添加备注 · ${targetLabel}`}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} aria-label="保存备注">
            保存备注
          </Button>
        </div>
      }
    >
      <div className="ec-note-editor" data-note-target={target.targetId}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 12 }}>
          <label style={{ flex: '0 0 160px' }}>
            <span style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>备注类型</span>
            <Select
              aria-label="备注类型"
              value={draft.type}
              options={TYPE_OPTIONS}
              onChange={(value) => setDraft((current) => ({ ...current, type: value as NoteType }))}
            />
          </label>
          <label style={{ flex: '0 0 120px' }}>
            <span style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>优先级</span>
            <Select
              aria-label="优先级"
              disabled={meta.mustFollow}
              value={String(meta.mustFollow ? 5 : (draft.manualPriority ?? meta.basePriority))}
              options={PRIORITY_OPTIONS}
              onChange={(value) =>
                setDraft((current) => ({ ...current, manualPriority: Number(value) }))
              }
            />
          </label>
          <label style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>标题</span>
            <Input
              aria-label="备注标题"
              value={draft.title}
              placeholder="一句话概括，例如：登录按钮需校验图形验证码"
              onChange={(value) => setDraft((current) => ({ ...current, title: value }))}
            />
          </label>
        </div>

        {meta.mustFollow && (
          <p
            role="note"
            style={{
              margin: '0 0 12px',
              padding: '6px 10px',
              borderRadius: 6,
              fontSize: 12,
              color: NOTE_TYPE_META.forbidden.color,
              background: NOTE_TYPE_META.forbidden.background,
            }}
          >
            禁止事项为硬约束：优先级锁定为 P5，生成代码时会以强约束句式置顶注入，且不可人工下调。
          </p>
        )}

        <section aria-label="备注正文">
          {draft.content.blocks.map((block, index) => (
            <BlockEditor
              key={index}
              block={block}
              index={index}
              onChange={(next) => setContent(index, next)}
              onRemove={() =>
                setDraft((current) => ({
                  ...current,
                  content: {
                    type: 'doc',
                    blocks:
                      current.content.blocks.length <= 1
                        ? [emptyDocument().blocks[0] as RichTextBlock]
                        : current.content.blocks.filter(
                            (_, current_index) => current_index !== index,
                          ),
                  },
                }))
              }
            />
          ))}
          <Button
            size="sm"
            variant="ghost"
            aria-label="添加段落"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                content: {
                  type: 'doc',
                  blocks: [...current.content.blocks, { type: 'paragraph', spans: [] }],
                },
              }))
            }
          >
            + 段落
          </Button>
        </section>

        <section aria-label="备注清单" style={{ marginTop: 12 }}>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>checklist 清单</h4>
          {draft.checklists.map((item, index) => (
            <div
              key={item.id}
              style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}
            >
              <Checkbox
                aria-label={`勾选清单项 ${index + 1}`}
                checked={item.checked}
                onChange={(checked) =>
                  setDraft((current) => ({
                    ...current,
                    checklists: current.checklists.map((candidate) =>
                      candidate.id === item.id ? { ...candidate, checked } : candidate,
                    ),
                  }))
                }
              />
              <Input
                aria-label={`清单项文本 ${index + 1}`}
                value={item.text}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    checklists: current.checklists.map((candidate) =>
                      candidate.id === item.id ? { ...candidate, text: value } : candidate,
                    ),
                  }))
                }
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`删除清单项 ${index + 1}`}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    checklists: current.checklists.filter((candidate) => candidate.id !== item.id),
                  }))
                }
              >
                删除
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            aria-label="添加清单项"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                checklists: [
                  ...current.checklists,
                  { id: tempId('check'), text: '', checked: false },
                ],
              }))
            }
          >
            + 清单项
          </Button>
        </section>

        <section aria-label="代码片段" style={{ marginTop: 12 }}>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>代码片段</h4>
          {draft.codeBlocks.map((block, index) => (
            <div
              key={block.id}
              style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'flex-start' }}
            >
              <Input
                aria-label={`代码语言 ${index + 1}`}
                style={{ flex: '0 0 110px' }}
                value={block.language}
                placeholder="language"
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    codeBlocks: current.codeBlocks.map((candidate) =>
                      candidate.id === block.id ? { ...candidate, language: value } : candidate,
                    ),
                  }))
                }
              />
              <Textarea
                aria-label={`代码内容 ${index + 1}`}
                rows={3}
                value={block.code}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    codeBlocks: current.codeBlocks.map((candidate) =>
                      candidate.id === block.id ? { ...candidate, code: value } : candidate,
                    ),
                  }))
                }
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`删除代码片段 ${index + 1}`}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    codeBlocks: current.codeBlocks.filter((candidate) => candidate.id !== block.id),
                  }))
                }
              >
                删除
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            aria-label="添加代码片段"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                codeBlocks: [
                  ...current.codeBlocks,
                  { id: tempId('code'), language: 'ts', code: '' },
                ],
              }))
            }
          >
            + 代码片段
          </Button>
        </section>

        {error !== null && (
          <p
            role="alert"
            style={{ color: NOTE_TYPE_META.forbidden.color, fontSize: 12, marginTop: 8 }}
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
