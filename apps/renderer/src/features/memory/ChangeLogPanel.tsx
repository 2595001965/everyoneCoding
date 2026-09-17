import { List, Tag } from '@ec/ui';
import type { ChangeLogRecord } from '@ec/memory';

/**
 * 记忆变更日志面板（FR-MEM-12）。
 *
 * 记录每次自动写入 / 冲突解决 / 撤销的来源对话片段与时间；
 * 点击条目跳转原始对话 —— 跳转由外壳提供实现，渲染层只暴露回调（占位），
 * 未注入时给出"暂不可跳转"的提示而不是假跳转。
 */

export const CHANGE_LOG_ROW_HEIGHT = 64;

const ACTION_LABELS: Record<string, string> = {
  auto_write: '自动写入',
  manual_create: '手动新建',
  manual_edit: '手动修改',
  undo: '撤销',
  conflict_resolve: '冲突解决',
  status_change: '状态变更',
  layer_move: '层级移动',
  import: '导入',
  delete: '删除',
};

const POLICY_LABELS: Record<string, string> = {
  auto: '静默写入',
  confirm: '写入并通知',
  manual: '仅建议',
};

export interface ChangeLogPanelProps {
  records: readonly ChangeLogRecord[];
  height?: number;
  /** 跳转原始对话（占位接口；外壳接入对话存储后填充） */
  onJumpToConversation?: ((conversationId: string) => void) | undefined;
}

export function ChangeLogPanel({
  records,
  height = 260,
  onJumpToConversation,
}: ChangeLogPanelProps): JSX.Element {
  if (records.length === 0) {
    return (
      <div className="ec-change-log__empty" role="status">
        还没有变更记录。AI 自动写入长期记忆后，这里会列出来源对话片段与时间。
      </div>
    );
  }

  return (
    <List
      items={[...records]}
      itemHeight={CHANGE_LOG_ROW_HEIGHT}
      height={height}
      getItemKey={(record) => record.id}
      aria-label="记忆变更日志"
      renderItem={(record) => {
        const canJump = Boolean(record.sourceConversationId && onJumpToConversation);
        return (
          <div className="ec-change-log__row">
            <div className="ec-change-log__head">
              <Tag color={record.action === 'undo' ? 'warning' : 'info'}>
                {ACTION_LABELS[record.action] ?? record.action}
              </Tag>
              {record.policy && <Tag color="neutral">{POLICY_LABELS[record.policy] ?? record.policy}</Tag>}
              <time dateTime={new Date(record.createdAt).toISOString()}>
                {new Date(record.createdAt).toLocaleString('zh-CN')}
              </time>
            </div>
            {record.sourceSnippet && <div className="ec-change-log__snippet">“{record.sourceSnippet}”</div>}
            {record.sourceConversationId &&
              (canJump ? (
                <button
                  type="button"
                  className="ec-change-log__jump"
                  onClick={() => onJumpToConversation?.(record.sourceConversationId as string)}
                >
                  查看原始对话
                </button>
              ) : (
                <span className="ec-change-log__jump ec-change-log__jump--disabled">原始对话暂不可跳转</span>
              ))}
          </div>
        );
      }}
    />
  );
}
