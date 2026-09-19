import { Button, EmptyState, Tag } from '@ec/ui';
import type { ApplyPlan, ConfigDiffItem } from '@ec/ai';

/**
 * 远程配置差异预览（FR-MDL-13）。
 *
 * 规则：本地 > 远程默认。预览里能看到哪些是新增、哪些被本地优先策略跳过，
 * 默认模型变更单独列出并需用户确认后才写入。
 */

export interface DiffPreviewProps {
  items: ConfigDiffItem[];
  summary: string;
  revision: string | null;
  plan: ApplyPlan | null;
  busy?: boolean;
  onApply(options: { overwriteLocal: boolean; ackDefaultModel: boolean }): void;
  onAck(revision: string): void;
  onClose(): void;
}

const KIND_LABEL: Record<ConfigDiffItem['kind'], string> = {
  added: '新增',
  changed: '修改',
  removed: '移除',
  unchanged: '一致',
};

const KIND_COLOR: Record<ConfigDiffItem['kind'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  added: 'success',
  changed: 'warning',
  removed: 'danger',
  unchanged: 'neutral',
};

export function DiffPreview({
  items,
  summary,
  revision,
  plan,
  busy = false,
  onApply,
  onAck,
  onClose,
}: DiffPreviewProps): JSX.Element {
  return (
    <section className="ec-ai__section" aria-label="配置差异预览">
      <header className="ec-ai__section-head">
        <div>
          <h2 className="ec-ai__section-title">差异预览</h2>
          <p className="ec-ai__hint">
            {summary}
            {revision ? ` · 版本 ${revision}` : ''}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </header>

      {items.length === 0 ? (
        <EmptyState title="与本地配置一致" description="应用后不会产生任何变更。" />
      ) : (
        <ul className="ec-ai__diff">
          {items.map((item, index) => (
            <li key={`${item.path}-${index}`} className="ec-ai__diff-item">
              <Tag color={KIND_COLOR[item.kind]}>{KIND_LABEL[item.kind]}</Tag>
              <span className="ec-ai__diff-label">{item.label}</span>
              {item.before ? <code className="ec-ai__diff-before">{item.before}</code> : null}
              {item.after ? <code className="ec-ai__diff-after">{item.after}</code> : null}
            </li>
          ))}
        </ul>
      )}

      {plan && plan.items.some((item) => item.kind === 'skip') ? (
        <p className="ec-ai__hint">
          已存在同名的本地服务将被跳过（本地优先）。如需覆盖，请使用「覆盖本地同名服务」。
        </p>
      ) : null}

      {plan?.defaultModelChange ? (
        <div className="ec-ai__notice" role="alert">
          <strong>远程配置更新了默认模型：{plan.defaultModelChange.after}</strong>
          <p className="ec-ai__hint">原默认模型：{plan.defaultModelChange.before ?? '未设置'}</p>
          <span className="ec-ai__row-actions">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => onApply({ overwriteLocal: false, ackDefaultModel: true })}
            >
              应用新默认模型
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !revision}
              onClick={() => revision && onAck(revision)}
            >
              保持原样（不再提示）
            </Button>
          </span>
        </div>
      ) : null}

      <footer className="ec-ai__editor-actions">
        <Button
          variant="primary"
          disabled={busy || items.length === 0}
          onClick={() => onApply({ overwriteLocal: false, ackDefaultModel: false })}
        >
          应用配置
        </Button>
        <Button
          variant="secondary"
          disabled={busy || items.length === 0}
          onClick={() => onApply({ overwriteLocal: true, ackDefaultModel: false })}
        >
          覆盖本地同名服务
        </Button>
      </footer>
    </section>
  );
}
