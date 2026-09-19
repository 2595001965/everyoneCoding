/**
 * 别名待清理清单（T7-05 要点 3，FR-UNI-10）。
 *
 * 表格化展示需要清理的兼容期别名（对象名 / 别名 / 类别 / 废弃时间 / 清理期限 / 剩余天数 / 状态），
 * 支持多选与「一键清理选中项」，清理前二次确认。
 */
import { useMemo, useState } from 'react';

import type { AliasKind, PendingCleanupItem } from '@ec/registry';
import { ALIAS_KIND_LABELS } from '@ec/registry';
import { Badge, Button, Checkbox, EmptyState, Spinner, Tag } from '@ec/ui';

import './components.css';

export interface AliasCleanupPanelProps {
  items: readonly PendingCleanupItem[];
  onClean: (keys: readonly { registryId: string; kind: AliasKind; name: string }[]) => void;
  loading?: boolean;
  now?: number;
}

function aliasKey(item: PendingCleanupItem): string {
  return `${item.registryId}|${item.alias.kind}|${item.alias.name}`;
}

function formatDate(ts: number | null): string {
  if (ts === null) return '长期保留';
  return new Date(ts).toLocaleDateString();
}

function daysLeftText(daysLeft: number | null): string {
  if (daysLeft === null) return '长期保留';
  if (daysLeft < 0) return `已过期 ${Math.abs(daysLeft)} 天`;
  return `剩余 ${daysLeft} 天`;
}

export function AliasCleanupPanel(props: AliasCleanupPanelProps): JSX.Element {
  const { items, onClean, loading = false } = props;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const selectedCount = selected.size;
  const toggle = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedKeys = useMemo(
    () => items.filter((item) => selected.has(aliasKey(item))),
    [items, selected],
  );

  const handleClean = (): void => {
    if (selectedKeys.length === 0) return;
    const keys = selectedKeys.map((item) => ({
      registryId: item.registryId,
      kind: item.alias.kind,
      name: item.alias.name,
    }));
    if (window.confirm(`确认清理选中的 ${keys.length} 个别名？清理后兼容层将移除。`)) {
      onClean(keys);
    }
  };

  return (
    <div className="ec-rename-root" data-testid="alias-cleanup">
      {loading && (
        <div className="ec-rename-inline">
          <Spinner size={18} />
          <span>加载中…</span>
        </div>
      )}

      {!loading && items.length === 0 && (
        <EmptyState title="暂无需清理的别名" description="所有兼容期别名都还在有效期或已清理" />
      )}

      {items.length > 0 && (
        <div className="ec-rename-block">
          <div className="ec-rename-alias-table">
            {items.map((item) => {
              const key = aliasKey(item);
              const isSel = selected.has(key);
              const statusLabel = item.status === 'due' ? '待清理' : '兼容期';
              const statusColor = item.status === 'due' ? 'warning' : 'success';
              return (
                <div className="ec-rename-alias-row" data-testid="alias-row" key={key}>
                  <Checkbox
                    checked={isSel}
                    aria-label={`选择 ${item.entityName} 的别名 ${item.alias.name}`}
                    onChange={() => toggle(key)}
                  />
                  <span>{item.entityName}</span>
                  <span>{item.alias.name}</span>
                  <span>{ALIAS_KIND_LABELS[item.alias.kind]}</span>
                  <span>{formatDate(item.alias.deprecatedAt ?? item.alias.createdAt)}</span>
                  <span>
                    {formatDate(item.alias.cleanupDueAt)}
                    <span className="ec-rename-muted">（{daysLeftText(item.daysLeft)}）</span>
                    <Tag color={statusColor}>{statusLabel}</Tag>
                  </span>
                </div>
              );
            })}
          </div>

          <div className="ec-rename-actions">
            <Badge color="neutral">已选 {selectedCount} 项</Badge>
            <Button
              variant="primary"
              disabled={selectedCount === 0}
              data-testid="alias-clean"
              onClick={handleClean}
            >
              一键清理选中项
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
