import * as React from 'react';

import { Button, EmptyState, Tag, Tooltip } from '@ec/ui';

import type { PageDsl } from '../dsl/types';
import { Canvas } from '../canvas/Canvas';
import { REASON_LABELS } from './auto-snapshot';
import type { SnapshotMeta, SnapshotReason } from './snapshot';

/**
 * 时间轴（T3-10 要点 3）。
 *
 * - 按时间列出快照（时间、触发原因、变更元素数、占用字节）；
 * - 「预览」以**只读模式**渲染该版本的画布；
 * - 「回滚到此版本」由上层调用 `HistoryStore.rollback()`（回滚前会自动保存当前状态）。
 */

const REASON_COLORS: Record<SnapshotReason, 'info' | 'success' | 'warning'> = {
  auto: 'info',
  manual: 'success',
  milestone: 'warning',
};

export interface TimelineProps {
  snapshots: readonly SnapshotMeta[];
  /** 回放：返回该快照对应的完整 DSL */
  onPreview: (snapshotId: string) => PageDsl | null;
  /** 回滚到该快照 */
  onRollback: (snapshotId: string) => void;
  /** 预览区高度 */
  previewHeight?: number;
  /** 自定义只读渲染器（缺省用画布） */
  renderPreview?: (dsl: PageDsl) => React.ReactNode;
  className?: string;
}

export function Timeline({
  snapshots,
  onPreview,
  onRollback,
  previewHeight = 260,
  renderPreview,
  className,
}: TimelineProps): React.ReactElement {
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [previewDsl, setPreviewDsl] = React.useState<PageDsl | null>(null);

  const handlePreview = (id: string): void => {
    setPreviewId(id);
    setPreviewDsl(onPreview(id));
  };

  if (snapshots.length === 0) {
    return (
      <div className={className} data-testid="timeline">
        <EmptyState
          title="还没有快照"
          description="编辑过程中会每 5 分钟自动快照，关键操作也会立即留档。"
        />
      </div>
    );
  }

  return (
    <div
      className={className}
      data-testid="timeline"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <ol
        className="ec-timeline__list"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {[...snapshots].reverse().map((snapshot) => (
          <li
            key={snapshot.id}
            data-testid={`snapshot-${snapshot.id}`}
            data-kind={snapshot.kind}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              border:
                snapshot.id === previewId
                  ? '1px solid var(--ec-accent, #2f6bff)'
                  : '1px solid #e9ecef',
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <time dateTime={new Date(snapshot.createdAt).toISOString()}>
              {new Date(snapshot.createdAt).toLocaleTimeString('zh-CN')}
            </time>
            <Tag color={REASON_COLORS[snapshot.reason]}>{REASON_LABELS[snapshot.reason]}</Tag>
            <Tag color="info">{snapshot.kind === 'base' ? '全量基线' : '增量'}</Tag>
            <span data-testid={`snapshot-label-${snapshot.id}`} style={{ flex: 1 }}>
              {snapshot.label ?? '（无说明）'}
            </span>
            <span
              data-testid={`snapshot-changed-${snapshot.id}`}
            >{`变更 ${snapshot.changedElements} 个元素`}</span>
            <span data-testid={`snapshot-size-${snapshot.id}`}>{`${snapshot.sizeBytes} B`}</span>
            <Button size="sm" variant="ghost" onClick={() => handlePreview(snapshot.id)}>
              预览
            </Button>
            <Tooltip content="回滚前会自动保存当前版本，可再次回滚">
              <Button size="sm" variant="secondary" onClick={() => onRollback(snapshot.id)}>
                回滚
              </Button>
            </Tooltip>
          </li>
        ))}
      </ol>

      {previewId !== null && (
        <section
          data-testid="timeline-preview"
          aria-label="历史版本预览（只读）"
          style={{ borderTop: '1px solid #e9ecef', paddingTop: 8 }}
        >
          <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>历史版本预览（只读）</strong>
            <Tag color="info">{previewId}</Tag>
            <span style={{ flex: 1 }} />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPreviewId(null);
                setPreviewDsl(null);
              }}
            >
              关闭预览
            </Button>
          </header>
          {previewDsl === null ? (
            <p role="alert" style={{ fontSize: 12, color: 'var(--ec-color-danger, #e5484d)' }}>
              该快照无法回放（数据缺失）
            </p>
          ) : (
            <div
              style={{
                height: previewHeight,
                border: '1px solid #e9ecef',
                borderRadius: 6,
                overflow: 'hidden',
              }}
            >
              {renderPreview ? renderPreview(previewDsl) : <Canvas dsl={previewDsl} />}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
