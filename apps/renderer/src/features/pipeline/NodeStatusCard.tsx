import type { ReactElement } from 'react';
import type { QueueNode } from '@ec/pipeline';
import { Badge } from '@ec/ui';

export interface NodeStatusCardProps {
  /** 队列节点（来自 S5 生成结果或实时状态） */
  node: QueueNode;
  /** 节点生成结果摘要（可选） */
  result?: { status: string; files: number; summary: string } | null;
}

/** 状态 → 中文文案与语义色（成功绿 / 失败红 / 跳过灰 / 生成中蓝 / 等待中性） */
const STATUS_META: Record<string, { label: string; color: string }> = {
  success: { label: '成功', color: '#16a34a' },
  failed: { label: '失败', color: '#dc2626' },
  skipped: { label: '跳过', color: '#6b7280' },
  running: { label: '生成中', color: '#2563eb' },
  pending: { label: '等待', color: '#9ca3af' },
};

const KIND_LABEL: Record<string, string> = { feature: '功能', page: '页面' };

/** 队列节点状态卡（复用：生成队列面板展示每个节点的执行结果） */
export function NodeStatusCard({ node, result }: NodeStatusCardProps): ReactElement {
  const meta = STATUS_META[node.status] ?? STATUS_META.pending!;
  const kindLabel = KIND_LABEL[node.kind] ?? node.kind;
  const kindColor: 'primary' | 'info' = node.kind === 'feature' ? 'primary' : 'info';
  const hasResult = result !== null && result !== undefined;

  return (
    <div
      className="ec-pipe-node-card"
      data-testid="node-status-card"
      style={{
        border: '1px solid var(--ec-border, #e5e7eb)',
        borderLeft: `4px solid ${meta.color}`,
        borderRadius: 8,
        padding: 12,
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{node.name}</span>
        <Badge color={kindColor}>{kindLabel}</Badge>
      </div>

      <div style={{ marginTop: 6, fontSize: 13, color: meta.color, fontWeight: 600 }}>
        {meta.label}
        <span style={{ color: '#6b7280', fontWeight: 400 }}> · 尝试 {node.attempts}</span>
        {node.durationMs !== null && node.durationMs > 0 && (
          <span style={{ color: '#6b7280', fontWeight: 400 }}>
            {' '}
            · {(node.durationMs / 1000).toFixed(1)} 秒
          </span>
        )}
      </div>

      {node.status === 'failed' && node.error !== null && (
        <div
          style={{
            marginTop: 6,
            fontSize: 12,
            color: '#dc2626',
            background: '#fef2f2',
            borderRadius: 4,
            padding: '4px 6px',
          }}
        >
          {node.error}
        </div>
      )}

      {hasResult && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#374151' }}>
          <span>产出文件 {result!.files}</span>
          {result!.summary.length > 0 && <span> · {result!.summary}</span>}
        </div>
      )}
    </div>
  );
}
