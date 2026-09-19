/**
 * 统一重命名工作区（T7-03 / T7-04 / T7-05 的页面级装配）。
 *
 * 组成：
 * - 左侧：可重命名对象清单（注册表项）→ 点击打开 `RenameDialog`
 * - 右侧：重命名历史（`RenameHistory`，含一键撤销）、别名"待清理"清单
 *   （`AliasCleanupPanel`）、批处理入口（`BatchRenameDialog`）
 * - 执行完成后展示 `RenameProgress`（五段执行结果 / 失败回滚提示 / 撤销入口）
 *
 * 触发点映射（FR-UNI-03）：元素 → 画布属性面板（`inspector`）、页面 → `page`、
 * 功能 → `feature`；图层树重命名（`layers`）由设计器在装配时直接调用同一端口。
 *
 * 硬约束：本组件只经 `RenameApi` 端口工作，不直接读写磁盘（D-04）。
 */

import { useCallback, useMemo, useState } from 'react';

import type {
  AliasKind,
  PendingCleanupItem,
  RenameTransactionResult,
  RenameTriggerSource,
} from '@ec/registry';
import { Button, EmptyState, Spinner, Tag } from '@ec/ui';

import { AliasCleanupPanel } from './AliasCleanupPanel';
import { BatchRenameDialog } from './BatchRenameDialog';
import { RenameDialog } from './RenameDialog';
import { RenameHistory } from './RenameHistory';
import { RenameProgress } from './RenameProgress';
import { useRenameApi, useRenameResource, type RenameApi, type RenameTarget } from './rename-api';

/** 触发点映射：元素 / 页面 / 功能 → 四个触发点之一 */
export function triggerSourceOf(target: RenameTarget): RenameTriggerSource {
  if (target.entityType === 'page') return 'page';
  if (target.entityType === 'feature') return 'feature';
  return 'inspector';
}

export interface RenameWorkspaceProps {
  api?: RenameApi | undefined;
}

export function RenameWorkspace({ api }: RenameWorkspaceProps): JSX.Element {
  const injected = useRenameApi();
  const client = api ?? injected;

  const [selected, setSelected] = useState<RenameTarget | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RenameTransactionResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const targets = useRenameResource((client_) => client_.listTargets(), 'targets');
  const history = useRenameResource((client_) => client_.history(), 'history');
  const cleanup = useRenameResource((client_) => client_.pendingCleanup(), 'cleanup');

  const openRename = useCallback((target: RenameTarget) => {
    setSelected(target);
    setResult(null);
    setNotice(null);
    setDialogOpen(true);
  }, []);

  const onExecuted = useCallback(
    (executed: RenameTransactionResult) => {
      setResult(executed);
      setNotice(executed.ok ? null : executed.failures.join('；'));
      history.reload();
      targets.reload();
      cleanup.reload();
    },
    [history, targets, cleanup],
  );

  const undo = useCallback(
    async (eventId: string) => {
      setBusy(true);
      try {
        const undone = await client.undo({ eventId });
        setNotice(undone.ok ? '已撤销并还原全部改动' : undone.failures.join('；'));
        history.reload();
        targets.reload();
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [client, history, targets],
  );

  const clean = useCallback(
    async (items: readonly { registryId: string; kind: AliasKind; name: string }[]) => {
      setBusy(true);
      try {
        const cleaned = await client.cleanAliases({ items });
        setNotice(`已清理 ${cleaned} 项兼容别名`);
        cleanup.reload();
        targets.reload();
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [client, cleanup, targets],
  );

  const targetItems = targets.data ?? [];
  const cleanupItems: readonly PendingCleanupItem[] = cleanup.data ?? [];
  const historyItems = useMemo(() => history.data ?? [], [history.data]);

  if (client.ready === false) {
    return (
      <EmptyState
        title="统一重命名服务未初始化"
        description={
          client.reason ??
          '外壳尚未注入 RenameApi（__EC_RENAME__）。真实装配属 Wave 9/10 的外壳接线工作。'
        }
      />
    );
  }

  return (
    <section
      data-testid="rename-workspace"
      aria-label="统一重命名"
      style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) 2fr', gap: 16 }}
    >
      <div
        data-testid="rename-targets"
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>可重命名对象</h2>
          <Tag color="neutral">{targetItems.length}</Tag>
          {targets.loading && <Spinner size={14} />}
          <span style={{ flex: 1 }} />
          <Button size="sm" onClick={() => setBatchOpen(true)} data-testid="open-batch">
            批量 / 规范化
          </Button>
        </header>
        {targets.error !== null ? (
          <EmptyState title="读取失败" description={targets.error} />
        ) : targetItems.length === 0 ? (
          <EmptyState
            title="暂无对象"
            description="在项目管理或设计器中创建元素、页面或功能后会自动注册"
          />
        ) : (
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {targetItems.map((item) => (
              <li
                key={item.registryId}
                data-testid="rename-target"
                data-registry-id={item.registryId}
              >
                <button
                  type="button"
                  onClick={() => openRename(item)}
                  aria-label={`重命名 ${item.canonicalName}`}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    padding: '6px 8px',
                    border: '1px solid var(--ec-color-border)',
                    borderRadius: 6,
                    background: 'var(--ec-color-bg-surface)',
                    color: 'var(--ec-color-text-primary)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <strong>{item.canonicalName}</strong>
                    <Tag color="info">{item.entityType}</Tag>
                    {item.syncState !== 'synced' && <Tag color="warning">{item.syncState}</Tag>}
                  </span>
                  <code style={{ color: 'var(--ec-color-text-secondary)' }}>
                    {item.projections.component}
                  </code>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {notice !== null && (
          <p data-testid="rename-workspace-notice" style={{ margin: 0 }}>
            {notice}
          </p>
        )}

        <section aria-label="执行结果">
          <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>最近一次执行</h2>
          <RenameProgress
            result={result}
            running={busy}
            onUndo={() => {
              const eventId = result?.event?.id;
              if (eventId !== undefined) void undo(eventId);
            }}
          />
        </section>

        <section aria-label="重命名历史">
          <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>重命名历史</h2>
          <RenameHistory
            entries={historyItems}
            loading={history.loading}
            onUndo={(id) => {
              void undo(id);
            }}
          />
        </section>

        <section aria-label="别名待清理">
          <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>兼容别名（待清理）</h2>
          <AliasCleanupPanel
            items={cleanupItems}
            loading={cleanup.loading}
            onClean={(items) => {
              void clean(items);
            }}
          />
        </section>
      </div>

      <RenameDialog
        open={dialogOpen}
        target={selected}
        api={client}
        source={selected === null ? 'inspector' : triggerSourceOf(selected)}
        onClose={() => setDialogOpen(false)}
        onExecuted={onExecuted}
      />

      <BatchRenameDialog
        api={client}
        targets={targetItems}
        open={batchOpen}
        onClose={() => {
          setBatchOpen(false);
          history.reload();
          targets.reload();
          cleanup.reload();
        }}
      />
    </section>
  );
}
