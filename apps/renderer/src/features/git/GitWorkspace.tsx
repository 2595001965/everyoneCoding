/**
 * Git 工作区（T6-01~04 总装）：顶部仓库状态 + 六个页签（变更 / 分支 / 历史 / 冲突 / 暂存 / 远程）。
 *
 * 硬约束：
 * - 用户永不接触命令行：所有操作由 UI 触发，结果以 `GitResult.logs` 与结构化面板回显；
 * - 代码只读（D-04）：变更/冲突面板只做选择与查看，不提供任何代码编辑控件；
 * - 破坏性操作在各自面板内二次确认。
 */
import { useCallback, useEffect, useState } from 'react';

import { Button, EmptyState, Tabs, Tag } from '@ec/ui';
import { buildBranchGraph, type BranchGraph as BranchGraphModel, type GitDiff } from '@ec/git';

import { useGitApi, type GitRepoInfo } from './git-api';
import { ChangesPanel } from './ChangesPanel';
import { CommitBox } from './CommitBox';
import { FileDiff } from './FileDiff';
import { HunkSelector } from './HunkSelector';
import { BranchTree } from './BranchTree';
import { BranchGraph } from './BranchGraph';
import { HistoryFilter, EMPTY_HISTORY_FILTER, type HistoryFilterValue } from './HistoryFilter';
import { HistoryTimeline } from './HistoryTimeline';
import { MergePanel } from './MergePanel';
import { ConflictEditor } from './ConflictEditor';
import { RollbackDialog } from './RollbackDialog';
import { StashPanel } from './StashPanel';
import { RemoteManager } from './RemoteManager';

const TAB_ITEMS = [
  { key: 'changes', label: '变更' },
  { key: 'branches', label: '分支' },
  { key: 'history', label: '历史' },
  { key: 'conflicts', label: '冲突' },
  { key: 'stash', label: '暂存' },
  { key: 'remotes', label: '远程' },
];

export function GitWorkspace(): JSX.Element {
  const api = useGitApi();
  const [info, setInfo] = useState<GitRepoInfo | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<HistoryFilterValue>({ ...EMPTY_HISTORY_FILTER });
  const [rollbackSha, setRollbackSha] = useState<string | null>(null);
  const [rollbackOpen, setRollbackOpen] = useState(false);

  const refreshInfo = useCallback(async () => {
    const next = await api.info();
    setInfo(next);
    setReady(next !== null);
  }, [api]);

  useEffect(() => {
    void refreshInfo();
  }, [refreshInfo]);

  const openFile = useCallback(
    async (path: string) => {
      setDiffPath(path);
      const result = await api.diff({ path });
      setDiff(result.ok ? result.data : null);
    },
    [api],
  );

  const runInit = useCallback(async () => {
    setInitializing(true);
    setInitError(null);
    const result = await api.init();
    setInitializing(false);
    if (result.ok) await refreshInfo();
    else setInitError(result.error?.message ?? '初始化仓库失败');
  }, [api, refreshInfo]);

  if (!ready && info === null) {
    return (
      <section className="ec-git-workspace" aria-label="版本管理">
        <EmptyState
          title="当前工作区还不是 Git 仓库"
          description="初始化后即可获得变更视图、分支管理、提交历史与回滚能力。初始化会自动写入适合本项目的 .gitignore 模板。"
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <Button variant="primary" onClick={runInit} loading={initializing} data-testid="git-init">
            初始化仓库
          </Button>
          {initError !== null && (
            <span role="alert" style={{ color: 'var(--ec-color-danger)' }} data-testid="git-init-error">
              {initError}
            </span>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="ec-git-workspace" aria-label="版本管理" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <header
        className="ec-git-workspace__head"
        style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <strong>{info?.name ?? '仓库'}</strong>
        {info?.branch !== null && info?.branch !== undefined && <Tag color="primary">{info.branch}</Tag>}
        {info !== null && (info.ahead > 0 || info.behind > 0) && (
          <span style={{ color: 'var(--ec-color-text-secondary)' }}>
            {info.ahead > 0 ? `↑${info.ahead} ` : ''}
            {info.behind > 0 ? `↓${info.behind}` : ''}
          </span>
        )}
        <Tag color={info?.clean === true ? 'success' : 'warning'} data-testid="git-clean-tag">
          {info?.clean === true ? '工作区干净' : '有未提交变更'}
        </Tag>
        <span style={{ color: 'var(--ec-color-text-secondary)' }} data-testid="git-backend">
          后端：{info?.backendLabel ?? '未知'}
        </span>
        <span style={{ flex: 1 }} />
        <code style={{ color: 'var(--ec-color-text-secondary)' }}>{info?.path ?? ''}</code>
      </header>

      <Tabs items={TAB_ITEMS} defaultValue="changes" aria-label="Git 工作区">
        {(active) => (
          <>
            {active === 'changes' && (
              <div className="ec-git-workspace__changes" style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 1fr) 2fr', gap: 12 }}>
                <div>
                  <ChangesPanel onOpenFile={(path) => void openFile(path)} />
                  <div style={{ marginTop: 12 }}>
                    <CommitBox onCommitted={() => void refreshInfo()} />
                  </div>
                </div>
                <div>
                  {diffPath !== null && <div style={{ fontFamily: 'monospace', marginBottom: 4 }}>{diffPath}</div>}
                  {diff === null ? (
                    <EmptyState title="选择一个文件查看差异" description="差异视图支持并排 / 内联切换与折叠未修改区域。" />
                  ) : (
                    <>
                      <FileDiff diff={diff} />
                      {diff.files[0] !== undefined && <HunkSelector file={diff.files[0]} />}
                    </>
                  )}
                </div>
              </div>
            )}

            {active === 'branches' && (
              <div className="ec-git-workspace__branches" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <BranchTree onSwitched={() => void refreshInfo()} />
                <BranchGraphPanel />
              </div>
            )}

            {active === 'history' && (
              <div className="ec-git-workspace__history" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <HistoryFilter value={filter} onChange={setFilter} />
                <HistoryTimeline
                  filter={filter}
                  onSelect={(sha) => {
                    setRollbackSha(sha);
                  }}
                />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Button
                    size="sm"
                    onClick={() => setRollbackOpen(true)}
                    disabled={rollbackSha === null}
                    data-testid="open-rollback"
                  >
                    回滚到此提交
                  </Button>
                  <span style={{ color: 'var(--ec-color-text-secondary)' }}>
                    {rollbackSha === null ? '先在上方选择一条提交' : `已选择 ${rollbackSha.slice(0, 7)}`}
                  </span>
                </div>
              </div>
            )}

            {active === 'conflicts' && (
              <div className="ec-git-workspace__conflicts" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <ConflictEditor onApplied={() => void refreshInfo()} />
                <MergePanel onFinished={() => void refreshInfo()} />
              </div>
            )}

            {active === 'stash' && <StashPanel onChanged={() => void refreshInfo()} />}

            {active === 'remotes' && <RemoteManager onChanged={() => void refreshInfo()} />}
          </>
        )}
      </Tabs>

      <RollbackDialog
        sha={rollbackSha}
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        onDone={() => void refreshInfo()}
      />
    </section>
  );
}

/** 提交图面板：自己拉一次提交 / 分支 / tag 数据并组图，BranchGraph 本身保持纯展示 */
function BranchGraphPanel(): JSX.Element {
  const api = useGitApi();
  const [graph, setGraph] = useState<BranchGraphModel | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [commits, branches, tags] = await Promise.all([
        api.log({ limit: 200 }),
        api.branches(),
        api.tags(),
      ]);
      if (cancelled) return;
      const list = commits.data ?? [];
      setGraph(
        buildBranchGraph({
          commits: list,
          branches: branches.data ?? [],
          tags: tags.data ?? [],
          headSha: list[0]?.sha ?? null,
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (graph === null) return <span role="status">加载提交图…</span>;
  return <BranchGraph graph={graph} selectedSha={selected} onSelect={setSelected} />;
}
