import { useState } from 'react';

import type { ContextPanelBlock, ContextPanelItem } from '@ec/ai';
import { Button, Checkbox, Tag, Textarea } from '@ec/ui';

/**
 * BlockCard：上下文块的单张卡片（T4-02 要点 3）。
 *
 * 一个块 = 一次提交里的一段内容，卡片要回答四个问题：
 * 1. **是什么**：中文标签 + 来源（"项目记忆 12 条"）；
 * 2. **占多少**：token 数与占总量的百分比（横条）；
 * 3. **要不要**：可勾选（取消勾选即从本次提交中排除）；
 * 4. **能不能改**：`editable` 的块支持就地编辑，编辑内容原样提交（所见即所提交）。
 */

export interface BlockCardProps {
  block: ContextPanelBlock;
  onToggle?: ((id: ContextPanelBlock['id']) => void) | undefined;
  /** 就地编辑（传原文表示取消编辑） */
  onEdit?: ((id: ContextPanelBlock['id'], text: string, original: string) => void) | undefined;
  /** 展开查看被省略条目 */
  onOpenNote?: ((noteId: string) => void) | undefined;
  defaultExpanded?: boolean;
}

export function BlockCard({ block, onToggle, onEdit, onOpenNote, defaultExpanded = false }: BlockCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.content);

  const barColor = block.enabled ? 'var(--ec-accent, #2563eb)' : 'var(--ec-border, #cbd5e1)';

  return (
    <article
      className="ec-context-block"
      data-block-id={block.id}
      data-block-enabled={block.enabled ? 'true' : 'false'}
      style={{
        border: '1px solid var(--ec-border, #e2e8f0)',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 8,
        opacity: block.enabled ? 1 : 0.6,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Checkbox
          aria-label={`包含 ${block.label}`}
          checked={block.enabled}
          onChange={() => onToggle?.(block.id)}
          disabled={onToggle === undefined}
        />
        <strong style={{ fontSize: 13 }}>{block.label}</strong>
        <Tag color={block.tokens > 0 ? 'info' : 'neutral'}>{`${block.tokens} token`}</Tag>
        {block.quota > 0 && <Tag color="neutral">{`配额 ${block.quota}`}</Tag>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--ec-text-secondary, #64748b)' }}>{block.source}</span>
      </header>

      <div
        aria-hidden="true"
        data-testid={`ec-context-bar-${block.id}`}
        data-percent={block.percent}
        style={{ height: 4, borderRadius: 2, background: 'var(--ec-surface-sunken, #f1f5f9)', margin: '6px 0' }}
      >
        <div
          style={{
            width: `${Math.min(100, block.percent)}%`,
            height: '100%',
            borderRadius: 2,
            background: barColor,
          }}
        />
      </div>

      {block.skipped !== undefined && (
        <p role="note" style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--ec-text-secondary, #64748b)' }}>
          {`未参与本次提交：${block.skipped}`}
        </p>
      )}

      {block.omittedCount > 0 && (
        <p style={{ margin: '0 0 6px', fontSize: 12, color: '#b45309' }}>{`本块已省略 ${block.omittedCount} 项`}</p>
      )}

      {block.tokens > 0 && (
        <div>
          {editing ? (
            <div>
              <Textarea
                aria-label={`${block.label} 内容`}
                rows={8}
                value={draft}
                onChange={setDraft}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <Button
                  size="sm"
                  variant="primary"
                  aria-label={`保存 ${block.label} 编辑`}
                  onClick={() => {
                    onEdit?.(block.id, draft, block.content);
                    setEditing(false);
                  }}
                >
                  保存编辑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft(block.content);
                    setEditing(false);
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <pre
              data-testid={`ec-context-content-${block.id}`}
              style={{
                margin: 0,
                maxHeight: expanded ? 320 : 96,
                overflow: 'auto',
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: 'var(--ec-surface-sunken, #f8fafc)',
                borderRadius: 6,
                padding: 8,
              }}
            >
              {block.content}
            </pre>
          )}

          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <Button size="sm" variant="ghost" aria-label={`展开 ${block.label}`} onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起' : '展开全文'}
            </Button>
            {block.editable && onEdit !== undefined && !editing && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`编辑 ${block.label}`}
                onClick={() => {
                  setDraft(block.content);
                  setEditing(true);
                }}
              >
                就地编辑
              </Button>
            )}
            <Button size="sm" variant="ghost" aria-label={`查看 ${block.label} 条目`} onClick={() => setExpanded((value) => !value)}>
              {`条目 ${block.items.length}`}
            </Button>
          </div>

          {expanded && block.items.length > 0 && (
            <ul className="ec-context-block__items" style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
              {block.items.map((item) => (
                <li key={item.key} data-item-key={item.key} data-item-tokens={item.tokens}>
                  <ItemLabel item={item} onOpenNote={onOpenNote} />
                  <span style={{ color: 'var(--ec-text-secondary, #64748b)' }}>{` · ${item.tokens} token`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * 条目名：备注条目渲染为可点击的溯源链接（生成结果页标注「已遵循备注 #id」）。
 * 备注 id 的判定不靠正则猜，而是由 block.id + key 前缀共同决定。
 */
function ItemLabel({
  item,
  onOpenNote,
}: {
  item: ContextPanelItem;
  onOpenNote?: ((noteId: string) => void) | undefined;
}): JSX.Element {
  if (item.noteId !== undefined && onOpenNote !== undefined) {
    return (
      <button
        type="button"
        className="ec-context-block__note-link"
        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--ec-accent, #2563eb)', cursor: 'pointer' }}
        onClick={() => onOpenNote(item.noteId as string)}
      >
        {item.label}
      </button>
    );
  }
  return <span>{item.label}</span>;
}
