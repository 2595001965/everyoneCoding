import { useEffect, useState } from 'react';

import { Button, Progress, Tag, Textarea } from '@ec/ui';

/**
 * 逻辑结构摘要预览（T2-06 的 UI 侧，FR-DSG-12 / FR-MEM-17~19）。
 *
 * 能力：
 * - 展示精简后的骨架 / 状态 / 事件 / 数据流 / 接口依赖；
 * - 显示 token 估算与是否被裁剪（超 2k 预算时后端会裁剪并标记 truncated）；
 * - 可手动编辑摘要（保存后由上层写回页面记忆）；
 * - 展示页面记忆最近 5 次结构变更。
 *
 * 摘要类型刻意用 `Record<string, unknown>` 而非直接引用精简器类型：
 * 设计器（Wave 3）与记忆层（Wave 2）并行推进，UI 不该被后者的内部类型绑死。
 */

export const DEFAULT_TOKEN_BUDGET = 2000;

export interface StructureRevisionView {
  revision: number;
  tokenEstimate: number;
  createdAt: number;
  /** 变更的元素/子树 id 摘要 */
  changed?: readonly string[];
}

export interface StructurePreviewProps {
  summary: Record<string, unknown>;
  tokenEstimate: number;
  truncated?: boolean;
  tokenBudget?: number;
  revisions?: readonly StructureRevisionView[];
  /** 手动编辑保存（只读模式下不传） */
  onChange?: (next: Record<string, unknown>) => void;
}

export function StructurePreview({
  summary,
  tokenEstimate,
  truncated = false,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
  revisions = [],
  onChange,
}: StructurePreviewProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(summary, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(JSON.stringify(summary, null, 2));
    setError(null);
  }, [summary]);

  const ratio = tokenBudget > 0 ? Math.min(100, Math.round((tokenEstimate / tokenBudget) * 100)) : 0;

  return (
    <section className="ec-structure-preview" aria-label="逻辑结构摘要">
      <header className="ec-structure-preview__head">
        <span className="ec-structure-preview__title">逻辑结构摘要</span>
        <span className="ec-structure-preview__tokens" data-testid="structure-tokens">
          {tokenEstimate} / {tokenBudget} tokens
        </span>
        {truncated && <Tag color="warning">已裁剪</Tag>}
        {onChange && (
          <Button size="sm" variant="secondary" onClick={() => setEditing((value) => !value)}>
            {editing ? '退出编辑' : '手动编辑'}
          </Button>
        )}
      </header>

      <Progress value={ratio} max={100} />

      {editing ? (
        <div className="ec-structure-preview__editor">
          <Textarea value={draft} onChange={setDraft} rows={14} aria-label="结构摘要 JSON" />
          {error && (
            <p className="ec-structure-preview__error" role="alert">
              {error}
            </p>
          )}
          <div className="ec-structure-preview__actions">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                try {
                  const parsed: unknown = JSON.parse(draft);
                  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    setError('摘要必须是一个 JSON 对象');
                    return;
                  }
                  onChange?.(parsed as Record<string, unknown>);
                  setEditing(false);
                  setError(null);
                } catch (err) {
                  setError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
                }
              }}
            >
              保存摘要
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="ec-structure-preview__body">
          <SummaryRow label="骨架" value={summary['skeleton']} monospace />
          <SummaryRow label="区块" value={summary['blocks']} />
          <SummaryRow label="状态" value={summary['state']} />
          <SummaryRow label="事件流" value={summary['events']} />
          <SummaryRow label="数据流" value={summary['dataFlow']} />
          <SummaryRow label="接口依赖" value={summary['apiDeps']} />
        </div>
      )}

      <section className="ec-structure-preview__revisions" aria-label="最近结构变更">
        <h3>最近结构变更</h3>
        {revisions.length === 0 ? (
          <p className="ec-structure-preview__hint">还没有结构变更记录。</p>
        ) : (
          <ul>
            {revisions.slice(-5).map((revision) => (
              <li key={revision.revision} data-testid={`structure-revision-${revision.revision}`}>
                <span className="ec-structure-preview__rev">#{revision.revision}</span>
                <time dateTime={new Date(revision.createdAt).toISOString()}>
                  {new Date(revision.createdAt).toLocaleString('zh-CN')}
                </time>
                <span className="ec-structure-preview__rev-tokens">{revision.tokenEstimate} tokens</span>
                {revision.changed && revision.changed.length > 0 && (
                  <span className="ec-structure-preview__rev-changed">变更：{revision.changed.join('、')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function SummaryRow({
  label,
  value,
  monospace = false,
}: {
  label: string;
  value: unknown;
  monospace?: boolean;
}): JSX.Element | null {
  if (value === undefined || value === null) return null;
  return (
    <div className="ec-structure-preview__row">
      <span className="ec-structure-preview__label">{label}</span>
      <span className={`ec-structure-preview__value${monospace ? ' ec-structure-preview__value--mono' : ''}`}>
        {formatValue(value)}
      </span>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          const trigger = record['trigger'] ?? record['from'] ?? record['name'];
          return typeof trigger === 'string' ? trigger : JSON.stringify(entry);
        }
        return String(entry);
      })
      .join('、');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
