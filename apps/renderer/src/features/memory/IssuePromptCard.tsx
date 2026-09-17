import { Button } from '@ec/ui';

/**
 * Debug 循环检测提示卡（FR-MEM-14）。
 *
 * **非模态**是硬要求，实现上体现为三点，缺一不可：
 * 1. 不用 Modal / Popover（它们会锁焦点），只用一个普通浮层；
 * 2. 不设置 `autoFocus`、不调用 `.focus()`、不 trap 焦点 —— 用户正在输入时输入焦点不被抢走；
 * 3. `role="status"` + `aria-live="polite"`，只在读屏队列里播报，不打断当前操作。
 *
 * 三个动作：立即建立 / 稍后（30 分钟静默）/ 不再提示此项（对该目标持久生效）。
 */

export interface IssuePromptCardProps {
  suggestion: {
    /** 目标键（页面/元素/功能组合），用于忽略与静默记录 */
    targetKey: string;
    /** 可读标题，形如「反复调试「登录页 / 提交按钮」」 */
    title: string;
    /** 命中原因摘要（循环次数 / 同一错误重复次数） */
    detail?: string;
  };
  onBuild: () => void;
  onLater: () => void;
  onNeverShow: () => void;
  /** 用户主动关闭（等同"稍后"） */
  onClose?: () => void;
}

export function IssuePromptCard({
  suggestion,
  onBuild,
  onLater,
  onNeverShow,
  onClose,
}: IssuePromptCardProps): JSX.Element {
  return (
    <aside
      className="ec-issue-prompt"
      role="status"
      aria-live="polite"
      data-testid="issue-prompt-card"
      // 刻意不加 tabIndex 与 autoFocus：不参与、不夺取键盘焦点
      aria-label="反复调试提示"
    >
      <div className="ec-issue-prompt__content">
        <p className="ec-issue-prompt__title">
          检测到正在反复调试「{suggestion.title}」，是否建立专门的问题记忆？
        </p>
        {suggestion.detail && <p className="ec-issue-prompt__detail">{suggestion.detail}</p>}
      </div>
      <div className="ec-issue-prompt__actions">
        <Button size="sm" variant="primary" onClick={onBuild}>
          立即建立
        </Button>
        <Button size="sm" variant="secondary" onClick={onLater}>
          稍后
        </Button>
        <Button size="sm" variant="ghost" onClick={onNeverShow}>
          不再提示此项
        </Button>
        {onClose && (
          <Button size="sm" variant="ghost" aria-label="关闭提示" onClick={onClose}>
            ×
          </Button>
        )}
      </div>
    </aside>
  );
}
