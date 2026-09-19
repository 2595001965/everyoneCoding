/**
 * 回滚对话框（T6-04 要点 3）：选择 soft reset / revert 并预览影响。
 *
 * - 模式文案统一取 `ROLLBACK_MODE_LABELS`，并展示 `plan.warnings`；
 * - 展示受影响提交与文件，以及安全快照分支名（`snapshotBranch`，可见）；
 * - 执行按钮必须二次确认后才调 `rollbackExecute`（FR-GIT-07）。
 */
import { useCallback, useEffect, useState } from 'react';

import { Button, Modal, Select, Tag } from '@ec/ui';
import { ROLLBACK_MODE_LABELS, type RollbackMode, type RollbackPlan } from '@ec/git';

import { useGitApi } from './git-api';

export interface RollbackDialogProps {
  /** 目标提交 sha；为 null 时不展示内容 */
  sha: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 回滚完成后回调 */
  onDone?: (() => void) | undefined;
}

const MODES: readonly RollbackMode[] = ['soft', 'revert'];

export function RollbackDialog({
  sha,
  open,
  onOpenChange,
  onDone,
}: RollbackDialogProps): JSX.Element | null {
  const api = useGitApi();
  const [mode, setMode] = useState<RollbackMode>('soft');
  const [plan, setPlan] = useState<RollbackPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (sha === null) return;
    setLoading(true);
    const result = await api.rollbackPlan({ sha, mode });
    setPlan(result.ok && result.data !== null ? result.data : null);
    setLoading(false);
  }, [api, sha, mode]);

  useEffect(() => {
    if (!open || sha === null) return;
    void load();
  }, [open, sha, load]);

  const execute = useCallback(async () => {
    if (plan === null) return;
    setBusy(true);
    const result = await api.rollbackExecute(plan);
    setBusy(false);
    setConfirming(false);
    if (result.ok) {
      setNotice(`已回滚，安全快照分支：${result.data?.snapshotBranch ?? plan.snapshotBranch}`);
      onOpenChange(false);
      onDone?.();
    } else {
      setNotice(result.error?.message ?? '回滚失败');
    }
  }, [api, plan, onDone, onOpenChange]);

  if (!open) return null;

  return (
    <>
      <Modal
        open
        onOpenChange={onOpenChange}
        title="回滚到指定提交"
        size="lg"
        footer={
          <>
            <Button size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => setConfirming(true)}
              disabled={plan === null}
              data-testid="rollback-execute"
            >
              执行回滚
            </Button>
          </>
        }
      >
        <div
          className="ec-rollback-dialog"
          data-testid="rollback-dialog"
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ color: 'var(--ec-color-text-secondary)' }}>目标提交</span>
            <code data-testid="rollback-sha">{sha ?? ''}</code>
          </div>

          <Select
            aria-label="回滚方式"
            value={mode}
            onChange={(value) => setMode(value as RollbackMode)}
            options={MODES.map((item) => ({ label: ROLLBACK_MODE_LABELS[item], value: item }))}
            data-testid="rollback-mode"
          />
          <div style={{ color: 'var(--ec-color-text-secondary)' }} data-testid="rollback-mode-desc">
            {ROLLBACK_MODE_LABELS[mode]}
          </div>

          {loading && <span role="status">计算影响范围中…</span>}

          {plan !== null && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ color: 'var(--ec-color-text-secondary)' }}>安全快照分支</span>
                <Tag color="info" data-testid="rollback-snapshot">
                  {plan.snapshotBranch}
                </Tag>
              </div>

              {plan.warnings.length > 0 && (
                <div
                  role="alert"
                  data-testid="rollback-warnings"
                  style={{ color: 'var(--ec-color-warning)' }}
                >
                  {plan.warnings.map((warning) => (
                    <div key={warning}>· {warning}</div>
                  ))}
                </div>
              )}

              <div>
                受影响提交（{plan.affectedCommits.length}）
                <ul data-testid="rollback-commits">
                  {plan.affectedCommits.map((commit, index) => (
                    <li key={`${commit.sha}-${index}`}>
                      <code>{commit.shortSha}</code> {commit.subject}
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                受影响文件（{plan.affectedFiles.length}）
                <ul data-testid="rollback-files">
                  {plan.affectedFiles.map((path) => (
                    <li key={path} style={{ fontFamily: 'monospace' }}>
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          {notice !== null && (
            <div role="status" data-testid="rollback-notice">
              {notice}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={confirming}
        onOpenChange={setConfirming}
        title="回滚确认"
        footer={
          <>
            <Button size="sm" onClick={() => setConfirming(false)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={execute}
              loading={busy}
              data-testid="rollback-confirm"
            >
              确认回滚
            </Button>
          </>
        }
      >
        <p>
          将按「{ROLLBACK_MODE_LABELS[mode]}」回滚到 <code>{sha ?? ''}</code>
          。执行前会自动创建安全快照分支 <code>{plan?.snapshotBranch ?? ''}</code>
          ，可据此恢复。确认继续？
        </p>
      </Modal>
    </>
  );
}
