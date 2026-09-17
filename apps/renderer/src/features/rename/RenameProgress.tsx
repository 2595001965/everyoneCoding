/**
 * 执行进度视图（T7-04 要点 2）。
 *
 * 展示五段执行进度、失败回滚提示、成功态的修改处数与 Git 提交 sha、一键撤销。
 */
import type { RenameTransactionResult } from '@ec/registry';
import { Button, EmptyState, Spinner, Tag } from '@ec/ui';

import './components.css';

export interface RenameProgressProps {
  result: RenameTransactionResult | null;
  running: boolean;
  onUndo?: () => void;
  onClose?: () => void;
}

function deriveState(result: RenameTransactionResult | null, running: boolean): string {
  if (running) return 'running';
  if (result === null) return 'idle';
  if (result.ok) return 'success';
  return result.rollback.performed ? 'rolled-back' : 'failed';
}

export function RenameProgress(props: RenameProgressProps): JSX.Element {
  const { result, running, onUndo, onClose } = props;
  const state = deriveState(result, running);

  return (
    <div className="ec-rename-root ec-rename-progress" data-testid="rename-progress" data-state={state}>
      {running && (
        <div className="ec-rename-inline">
          <Spinner size={18} />
          <span>执行中…</span>
        </div>
      )}

      {!running && result === null && (
        <EmptyState title="尚未执行" description="选择变更项并确认执行后会在这里显示进度" />
      )}

      {result !== null && (
        <div className="ec-rename-block">
          <div className="ec-rename-progress__segments">
            {result.segments.map((segment, index) => (
              <div className="ec-rename-progress__segment" key={`${segment.executorId}-${index}`}>
                <span>{segment.label}</span>
                <span className="ec-rename-muted">
                  已改 {segment.applied} 处 / 跳过 {segment.skipped} 处
                </span>
                {segment.failures.length > 0 && (
                  <span className="ec-rename-danger">{segment.failures.join('；')}</span>
                )}
              </div>
            ))}
          </div>

          {result.ok && (
            <div className="ec-rename-summary ec-rename-inline">
              <Tag color="success">已完成</Tag>
              <span>已修改 {result.applied} 处</span>
              {result.commitSha !== null && <code>commit {result.commitSha}</code>}
            </div>
          )}

          {!result.ok && result.rollback.performed && (
            <div className="ec-rename-rollback">
              <strong>已整体回滚</strong>
              <ul>
                {result.rollback.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ul>
            </div>
          )}

          {!result.ok && !result.rollback.performed && (
            <div className="ec-rename-rollback">
              <strong className="ec-rename-danger">执行失败</strong>
              <ul>
                {result.failures.map((failure, index) => (
                  <li key={index} className="ec-rename-danger">
                    {failure}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.ok && onUndo !== undefined && (
            <div className="ec-rename-actions">
              <Button variant="ghost" data-testid="rename-undo" onClick={onUndo}>
                一键撤销
              </Button>
            </div>
          )}

          {onClose !== undefined && (
            <div className="ec-rename-actions">
              <Button onClick={onClose}>关闭</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
