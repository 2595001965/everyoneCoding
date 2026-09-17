/**
 * 分支树（T6-03 要点 1）：用 `buildBranchTree` 渲染层级；每行显示名字、当前分支标记、
 * ahead/behind、上游；操作：切换 / 新建 / 重命名 / 删除（删除必须二次确认，见 FR-GIT-05）。
 *
 * 实现注意：
 * - `Tree` 自身会递归展开 `children`，所以这里只需把 `BranchTreeNode[]` 映射成 `TreeNode[]`，
 *   **不要**再手工扁平化（会重复渲染）。
 * - 所有回调都在 `useMemo` **之前**用 `useCallback` 定义，避免渲染期访问处于 TDZ 的常量。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';

import { Button, Input, Modal, Tag, Tree, type TreeNode } from '@ec/ui';
import { buildBranchTree, type BranchTreeNode, type GitBranchInfo } from '@ec/git';

import { useGitApi } from './git-api';
import { isValidBranchName } from './git-helpers';

export interface BranchTreeProps {
  /** 分支切换成功后回调 */
  onSwitched?: (name: string) => void;
}

interface RenameState {
  name: string;
  to: string;
}

export function BranchTree({ onSwitched }: BranchTreeProps): JSX.Element {
  const api = useGitApi();
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api.branches();
    if (result.ok && result.data !== null) setBranches(result.data);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---- 回调先定义（useMemo 依赖它们，且 useMemo 在渲染期立即执行） ---- */

  const switchTo = useCallback(
    async (name: string) => {
      const result = await api.switchBranch(name);
      if (result.ok) {
        onSwitched?.(name);
        await load();
      }
    },
    [api, load, onSwitched],
  );

  const openDelete = useCallback((name: string) => setPendingDelete(name), []);
  const openRename = useCallback((name: string) => {
    setRenameError(null);
    setRename({ name, to: name });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (pendingDelete === null) return;
    const result = await api.deleteBranch(pendingDelete);
    if (result.ok) {
      setPendingDelete(null);
      await load();
    }
  }, [api, load, pendingDelete]);

  const confirmRename = useCallback(async () => {
    if (rename === null) return;
    const next = rename.to.trim();
    if (!isValidBranchName(next)) {
      setRenameError('分支名不合法（不能含空格、不能以 - 或 . 开头、不能含 ..）');
      return;
    }
    const result = await api.renameBranch(rename.name, next);
    if (result.ok) {
      setRename(null);
      setRenameError(null);
      await load();
    } else {
      setRenameError(result.error?.message ?? '重命名失败');
    }
  }, [api, load, rename]);

  const confirmCreate = useCallback(async () => {
    const next = createName.trim();
    if (!isValidBranchName(next)) {
      setCreateError('分支名不合法');
      return;
    }
    const result = await api.createBranch(next);
    if (result.ok) {
      setCreateOpen(false);
      setCreateName('');
      setCreateError(null);
      await load();
    } else {
      setCreateError(result.error?.message ?? '创建失败');
    }
  }, [api, load, createName]);

  /* ---- 树数据 ---- */

  const tree = useMemo(() => buildBranchTree(branches), [branches]);

  const built = useMemo(() => {
    const ids: string[] = [];
    const convert = (items: BranchTreeNode[]): TreeNode[] =>
      items.map((item) => {
        ids.push(item.name);
        const children = convert(item.children);
        const label = (
          <BranchLabel node={item} onSwitch={switchTo} onRename={openRename} onDelete={openDelete} />
        );
        return children.length > 0 ? { id: item.name, label, children } : { id: item.name, label };
      });
    return { nodes: convert(tree), ids };
  }, [tree, switchTo, openRename, openDelete]);

  return (
    <div className="ec-branch-tree" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="ec-branch-tree__toolbar" style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)} data-testid="branch-create">
          新建分支
        </Button>
      </div>

      {loading && <span role="status">读取分支中…</span>}
      {!loading && branches.length === 0 && <span role="status">还没有分支。</span>}

      {!loading && branches.length > 0 && (
        <div data-testid="branch-tree-body">
          <Tree data={built.nodes} defaultExpanded={built.ids} height={360} aria-label="分支树" />
        </div>
      )}

      <Modal
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="删除分支确认"
        footer={
          <>
            <Button size="sm" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button size="sm" variant="danger" onClick={confirmDelete} data-testid="branch-delete-confirm">
              删除
            </Button>
          </>
        }
      >
        <p>
          即将删除分支 <strong>{pendingDelete}</strong>。该操作不可撤销，确认继续？
        </p>
      </Modal>

      <Modal
        open={rename !== null}
        onOpenChange={(open) => {
          if (!open) setRename(null);
        }}
        title="重命名分支"
        footer={
          <>
            <Button size="sm" onClick={() => setRename(null)}>
              取消
            </Button>
            <Button size="sm" variant="primary" onClick={confirmRename} data-testid="branch-rename-confirm">
              重命名
            </Button>
          </>
        }
      >
        <Input
          aria-label="新分支名"
          value={rename?.to ?? ''}
          onChange={(v: string) => setRename((r) => (r === null ? r : { ...r, to: v }))}
          data-testid="branch-rename-input"
        />
        {renameError !== null && (
          <div role="alert" style={{ color: 'var(--ec-color-danger)' }} data-testid="branch-rename-error">
            {renameError}
          </div>
        )}
      </Modal>

      <Modal
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) setCreateOpen(false);
        }}
        title="新建分支"
        footer={
          <>
            <Button size="sm" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button size="sm" variant="primary" onClick={confirmCreate} data-testid="branch-create-confirm">
              创建
            </Button>
          </>
        }
      >
        <Input
          aria-label="分支名"
          placeholder="例如 feat/user/login"
          value={createName}
          onChange={setCreateName}
          data-testid="branch-create-input"
        />
        {createError !== null && (
          <div role="alert" style={{ color: 'var(--ec-color-danger)' }} data-testid="branch-create-error">
            {createError}
          </div>
        )}
      </Modal>
    </div>
  );
}

function BranchLabel({
  node,
  onSwitch,
  onRename,
  onDelete,
}: {
  node: BranchTreeNode;
  onSwitch: (name: string) => void;
  onRename: (name: string) => void;
  onDelete: (name: string) => void;
}): JSX.Element {
  const branch = node.branch;
  return (
    <span className="ec-branch-tree__label" style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
      <span className="ec-branch-tree__name" style={{ minWidth: 120 }}>
        {node.label}
        {branch?.current === true && (
          <Tag color="primary" style={{ marginLeft: 6 }}>
            当前
          </Tag>
        )}
      </span>
      {branch !== null && (
        <>
          {branch.ahead > 0 && (
            <span
              className="ec-branch-tree__ahead"
              style={{ color: 'var(--ec-color-success)' }}
              data-testid={`ahead-${branch.name}`}
            >
              ↑{branch.ahead}
            </span>
          )}
          {branch.behind > 0 && (
            <span
              className="ec-branch-tree__behind"
              style={{ color: 'var(--ec-color-warning)' }}
              data-testid={`behind-${branch.name}`}
            >
              ↓{branch.behind}
            </span>
          )}
          {branch.upstream !== null && (
            <span
              className="ec-branch-tree__upstream"
              style={{ color: 'var(--ec-color-text-secondary)' }}
              data-testid={`upstream-${branch.name}`}
            >
              {branch.upstream}
              {branch.gone ? '（已删除）' : ''}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {!branch.current && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSwitch(branch.name);
              }}
              data-testid={`branch-switch-${branch.name}`}
              style={linkBtn}
            >
              切换
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRename(branch.name);
            }}
            data-testid={`branch-rename-${branch.name}`}
            style={linkBtn}
          >
            重命名
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(branch.name);
            }}
            data-testid={`branch-delete-${branch.name}`}
            style={{ ...linkBtn, color: 'var(--ec-color-danger)' }}
          >
            删除
          </button>
        </>
      )}
    </span>
  );
}

const linkBtn: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--ec-color-info)',
  cursor: 'pointer',
  padding: '0 4px',
};
