/**
 * 合并 / 变基面板（T6-04 要点 1）：选择源 / 目标分支 → 预览影响 → 合并（二次确认，
 * 说明会先创建 `backup/<时间戳>` 备份分支）→ 展示 `MergeOutcome` 与冲突文件清单。
 *
 * 破坏性操作（合并 / 变基）一律先弹确认；用户永不接触命令行。
 */
import { useCallback, useEffect, useState } from 'react';

import { Button, EmptyState, Modal, Select, Tag } from '@ec/ui';
import { backupBranchName, type MergeOutcome } from '@ec/git';

import { useGitApi } from './git-api';

export interface MergePanelProps {
  /** 合并 / 变基结束后回调（工作区刷新变更与分支） */
  onFinished?: () => void;
}

const STATUS_LABELS: Record<MergeOutcome['status'], string> = {
  merged: '合并成功',
  'fast-forward': '快进合并',
  conflicted: '存在冲突，需要处理',
  'up-to-date': '已是最新，无需合并',
  failed: '合并失败',
};

export function MergePanel({ onFinished }: MergePanelProps): JSX.Element {
  const api = useGitApi();
  const [branchNames, setBranchNames] = useState<string[]>([]);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [preview, setPreview] = useState<{
    commits: number;
    filesChanged: number;
    fastForward: boolean;
  } | null>(null);
  const [outcome, setOutcome] = useState<MergeOutcome | null>(null);
  const [pending, setPending] = useState<'merge' | 'rebase' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await api.branches();
    const names = result.ok && result.data !== null ? result.data.map((branch) => branch.name) : [];
    setBranchNames(names);
    setSource((current) => (current === '' ? (names[0] ?? '') : current));
    setTarget((current) => (current === '' ? (names[1] ?? names[0] ?? '') : current));
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runPreview = useCallback(async () => {
    if (source === '' || target === '') return;
    setError(null);
    setOutcome(null);
    const result = await api.previewMerge(source, target);
    if (result.ok && result.data !== null) {
      setPreview({
        commits: result.data.commits.length,
        filesChanged: result.data.filesChanged,
        fastForward: result.data.fastForward,
      });
    } else {
      setPreview(null);
      setError(result.error?.message ?? '预览失败');
    }
  }, [api, source, target]);

  const execute = useCallback(async () => {
    if (pending === null || source === '' || target === '') return;
    setBusy(true);
    const result =
      pending === 'merge'
        ? await api.merge(source, { backup: true })
        : await api.rebase(target, { backup: true });
    setBusy(false);
    setPending(null);
    if (result.ok && result.data !== null) {
      setOutcome(result.data);
      onFinished?.();
    } else {
      setError(result.error?.message ?? '操作失败');
    }
  }, [api, pending, source, target, onFinished]);

  if (branchNames.length < 1) {
    return <EmptyState title="还没有可用分支" description="先创建至少一个分支再进行合并或变基。" />;
  }

  return (
    <div
      className="ec-merge-panel"
      data-testid="merge-panel"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div
        className="ec-merge-panel__row"
        style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Select
          aria-label="源分支"
          value={source}
          onChange={setSource}
          options={branchNames.map((name) => ({ label: name, value: name }))}
          data-testid="merge-source"
        />
        <span style={{ color: 'var(--ec-color-text-secondary)' }}>→</span>
        <Select
          aria-label="目标分支"
          value={target}
          onChange={setTarget}
          options={branchNames.map((name) => ({ label: name, value: name }))}
          data-testid="merge-target"
        />
        <Button size="sm" onClick={runPreview} data-testid="merge-preview-action">
          预览影响
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => setPending('merge')}
          data-testid="merge-start"
        >
          合并
        </Button>
        <Button size="sm" onClick={() => setPending('rebase')} data-testid="rebase-start">
          变基
        </Button>
      </div>

      {preview !== null && (
        <div className="ec-merge-panel__preview" role="status" data-testid="merge-preview">
          将引入 {preview.commits} 个提交，影响 {preview.filesChanged} 个文件
          {preview.fastForward ? '（可快进合并）' : '（会产生合并提交）'}
        </div>
      )}

      {error !== null && (
        <div role="alert" style={{ color: 'var(--ec-color-danger)' }} data-testid="merge-error">
          {error}
        </div>
      )}

      {outcome !== null && (
        <div className="ec-merge-panel__outcome" data-testid="merge-outcome">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Tag
              color={
                outcome.status === 'conflicted' || outcome.status === 'failed'
                  ? 'danger'
                  : 'success'
              }
            >
              {STATUS_LABELS[outcome.status]}
            </Tag>
            {outcome.backupBranch !== null && (
              <span data-testid="merge-backup">
                已创建备份分支 <code>{outcome.backupBranch}</code>
              </span>
            )}
          </div>
          {outcome.conflictFiles.length > 0 && (
            <ul className="ec-merge-panel__conflicts" data-testid="merge-conflict-files">
              {outcome.conflictFiles.map((path) => (
                <li key={path} style={{ fontFamily: 'monospace' }}>
                  {path}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Modal
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending === 'rebase' ? '变基确认' : '合并确认'}
        footer={
          <>
            <Button size="sm" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={execute}
              loading={busy}
              data-testid="merge-confirm"
            >
              确认执行
            </Button>
          </>
        }
      >
        <p>
          将把 <strong>{source}</strong> {pending === 'rebase' ? '变基到' : '合并进'}{' '}
          <strong>{target}</strong>。 执行前会先创建备份分支{' '}
          <code data-testid="merge-backup-name">{backupBranchName(Date.now())}</code>
          ，出问题可一键回到当前状态。
        </p>
      </Modal>
    </div>
  );
}
