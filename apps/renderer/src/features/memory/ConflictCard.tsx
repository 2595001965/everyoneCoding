import { Button, Modal, Tag } from '@ec/ui';
import { CONFLICT_STRATEGY_LABELS, type ConflictStrategy } from '@ec/memory';

/**
 * 记忆冲突对比卡（FR-MEM-11）。
 *
 * 新抽取的长期记忆与已有记忆矛盾时弹出，用户三选一：
 * 「采用新」「保留旧」「合并」。合并结果保留双方来源引用（由领域层保证）。
 *
 * 用 Modal 承载（这里**允许**是模态的：冲突必须显式决策，不能默默覆盖用户既有偏好）。
 */

export interface ConflictCardProps {
  open?: boolean;
  model: {
    /** 既有条目 id（采用新/合并时以此条为主更新） */
    memoryId: string;
    title: string;
    category?: string;
    existing: { title: string; content: string };
    incoming: { title: string; content: string };
    /** 冲突字段名列表（来自 T2-01 的冲突检测） */
    fields?: readonly string[];
  };
  /** 用户选择；组件不自行关闭，由父组件在决策完成后关闭 */
  onResolve: (strategy: ConflictStrategy) => void;
  onCancel?: () => void;
  busy?: boolean;
}

export function ConflictCard({ open = true, model, onResolve, onCancel, busy = false }: ConflictCardProps): JSX.Element {
  return (
    <Modal
      open={open}
      {...(onCancel ? { onOpenChange: (next: boolean) => (!next ? onCancel() : undefined) } : {})}
      title="记忆冲突：这条偏好与已有记忆不一致"
      size="lg"
      footer={
        <div className="ec-conflict-card__actions">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              稍后处理
            </Button>
          )}
          <Button variant="secondary" onClick={() => onResolve('takeNew')} disabled={busy}>
            {CONFLICT_STRATEGY_LABELS.takeNew}
          </Button>
          <Button variant="secondary" onClick={() => onResolve('keepLocal')} disabled={busy}>
            {CONFLICT_STRATEGY_LABELS.keepLocal}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => onResolve('merge')}>
            {CONFLICT_STRATEGY_LABELS.merge}
          </Button>
        </div>
      }
    >
      <div className="ec-conflict-card" data-testid="conflict-card">
        <header className="ec-conflict-card__head">
          <span className="ec-conflict-card__title">{model.title}</span>
          {model.category && <Tag color="info">{model.category}</Tag>}
          {model.fields && model.fields.length > 0 && (
            <span className="ec-conflict-card__fields">冲突字段：{model.fields.join('、')}</span>
          )}
        </header>
        <div className="ec-conflict-card__sides">
          <section className="ec-conflict-card__side" aria-label="已有记忆">
            <h3>已有记忆</h3>
            <p className="ec-conflict-card__side-title">{model.existing.title}</p>
            <pre className="ec-conflict-card__body">{model.existing.content}</pre>
          </section>
          <section className="ec-conflict-card__side" aria-label="新抽取的记忆">
            <h3>新抽取的记忆</h3>
            <p className="ec-conflict-card__side-title">{model.incoming.title}</p>
            <pre className="ec-conflict-card__body">{model.incoming.content}</pre>
          </section>
        </div>
        <p className="ec-conflict-card__hint">
          合并会深合并结构化字段、拼接正文，并同时保留双方的来源引用（对话 id）。
        </p>
      </div>
    </Modal>
  );
}
