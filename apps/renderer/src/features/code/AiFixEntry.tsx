import { useState } from 'react';

import { Button, Modal, Textarea } from '@ec/ui';

/**
 * AiFixEntry：「交给 AI 修改」入口（T4-05 要点 2 / E2E-18）。
 *
 * 触发时机：用户在只读代码视图里尝试编辑被拦截时弹出。
 * 职责是**把"我想改这段代码"翻译成一条 AI 指令**：预填文件路径与用户补充说明，
 * 确认后交给外壳跳转到 AI 对话（`onConfirm`）。整个流程不产生任何直接写文件的操作。
 */

export interface AiFixEntryProps {
  path: string;
  /** 为什么会弹出（拦截原因），展示给用户看 */
  reason: string;
  /** 预填的上下文（可选：被拦截位置附近的代码片段） */
  contextSnippet?: string | undefined;
  onConfirm?: ((input: { path: string; reason: string; fileName: string }) => void) | undefined;
  onClose: () => void;
}

export function AiFixEntry({ path, reason, contextSnippet, onConfirm, onClose }: AiFixEntryProps): JSX.Element {
  const [comment, setComment] = useState('');
  const fileName = path.split('/').at(-1) ?? path;

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="md"
      title="交给 AI 修改"
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            aria-label="交给 AI 修改"
            disabled={onConfirm === undefined}
            onClick={() => {
              onConfirm?.({ path, reason, fileName });
              onClose();
            }}
          >
            交给 AI 修改
          </Button>
        </div>
      }
    >
      <div className="ec-ai-fix-entry" data-file-path={path}>
        <p role="note" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--ec-text-secondary, #64748b)' }}>
          {reason}
        </p>
        <p style={{ margin: '0 0 8px', fontSize: 12 }}>
          {`目标文件：${path}`}
        </p>
        <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>希望怎么改（会作为指令发给 AI）</label>
        <Textarea
          aria-label="AI 修改说明"
          rows={4}
          value={comment}
          placeholder={`例如：把 ${fileName} 里的登录校验改成先校验图形验证码`}
          onChange={setComment}
        />
        {contextSnippet !== undefined && contextSnippet.length > 0 && (
          <pre
            data-testid="ec-ai-fix-context"
            style={{ marginTop: 8, maxHeight: 160, overflow: 'auto', fontSize: 11, background: 'var(--ec-surface-sunken, #f8fafc)', padding: 8, borderRadius: 6 }}
          >
            {contextSnippet}
          </pre>
        )}
      </div>
    </Modal>
  );
}
