import type * as React from 'react';

import { EmptyState, Tag } from '@ec/ui';

import { describeDiff, diffSize, type DslTreeDiff } from './diff-ops';

/**
 * 结构化差异视图（T3-10 要点 4）。
 *
 * 四类变更分栏展示：新增 / 移动 / 修改 / 删除；每一条都可点击**定位**到画布或图层树。
 * 「移动」由稳定 id 识别，不会退化成「删除 + 新增」。
 */

export interface DiffViewProps {
  diff: DslTreeDiff;
  /** 点击条目定位（选中 + 滚动到可视区域） */
  onLocate?: (elementId: string) => void;
  className?: string;
}

interface SectionProps {
  testId: string;
  title: string;
  color: 'success' | 'warning' | 'info' | 'danger';
  count: number;
  children: React.ReactNode;
}

function Section({ testId, title, color, count, children }: SectionProps): React.ReactElement {
  return (
    <section data-testid={testId} data-count={count} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <Tag color={color}>{count}</Tag>
      </header>
      {count === 0 ? <p style={{ fontSize: 12, opacity: 0.55 }}>无</p> : children}
    </section>
  );
}

export function DiffView({ diff, onLocate, className }: DiffViewProps): React.ReactElement {
  const total = diffSize(diff);

  if (total === 0) {
    return (
      <div className={className} data-testid="diff-view">
        <EmptyState title="没有差异" description="这两个版本的结构完全一致。" />
      </div>
    );
  }

  const entry = (id: string, label: string, detail: string): React.ReactElement => (
    <li key={id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
      <button
        type="button"
        data-testid={`diff-entry-${id}`}
        onClick={() => onLocate?.(id)}
        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--ec-color-link, #1971c2)', cursor: 'pointer' }}
      >
        {label}
      </button>
      <span style={{ opacity: 0.6 }}>{detail}</span>
    </li>
  );

  return (
    <div className={className} data-testid="diff-view" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={{ fontSize: 13 }}>版本差异</strong>
        <Tag color="info">{describeDiff(diff)}</Tag>
      </header>

      <Section testId="diff-added" title="新增元素" color="success" count={diff.added.length}>
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {diff.added.map((item) => entry(item.id, `${item.name ?? item.id}（${item.type}）`, `插入到 ${item.parentId ?? '根'} 第 ${item.index + 1} 位`))}
        </ul>
      </Section>

      <Section testId="diff-moved" title="移动元素" color="warning" count={diff.moved.length}>
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {diff.moved.map((item) =>
            entry(
              item.id,
              `${item.name ?? item.id}（${item.type}）`,
              `${item.fromParentId ?? '根'}[${item.fromIndex}] → ${item.parentId ?? '根'}[${item.index}]`,
            ),
          )}
        </ul>
      </Section>

      <Section testId="diff-modified" title="修改元素" color="info" count={diff.modified.length}>
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {diff.modified.map((item) => entry(item.id, `${item.name ?? item.id}（${item.type}）`, `字段：${item.changedKeys.join('、')}`))}
        </ul>
      </Section>

      <Section testId="diff-removed" title="删除元素" color="danger" count={diff.removed.length}>
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {diff.removed.map((item) => entry(item.id, `${item.name ?? item.id}（${item.type}）`, `来自 ${item.parentId ?? '根'} 第 ${item.index + 1} 位`))}
        </ul>
      </Section>

      {(diff.pageChanged.length > 0 ||
        diff.stateChanged ||
        diff.eventsChanged ||
        diff.apiDepsChanged ||
        diff.anchorsChanged ||
        diff.notesChanged) && (
        <Section
          testId="diff-page"
          title="页面级变更"
          color="info"
          count={
            diff.pageChanged.length +
            [diff.stateChanged, diff.eventsChanged, diff.apiDepsChanged, diff.anchorsChanged, diff.notesChanged].filter(Boolean).length
          }
        >
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
            {diff.pageChanged.length > 0 && <li>{`页面字段：${diff.pageChanged.join('、')}`}</li>}
            {diff.stateChanged && <li>页面状态变量</li>}
            {diff.eventsChanged && <li>事件动作流</li>}
            {diff.apiDepsChanged && <li>接口依赖</li>}
            {diff.anchorsChanged && <li>代码锚点</li>}
            {diff.notesChanged && <li>备注</li>}
          </ul>
        </Section>
      )}
    </div>
  );
}
