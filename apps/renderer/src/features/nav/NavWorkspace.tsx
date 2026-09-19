/**
 * 导航工作区（T6-07 总装）：关系图谱为主视图，右侧是元素跳转入口与数据流浮层。
 *
 * - 元素名走 `JumpOverlay`：悬停看候选、Ctrl + 点击按层级跳转；
 * - 每个元素可打开 `DataFlowOverlay` 查看「元素 → 事件 → 接口 → 后端 → 回写 → 渲染」；
 * - 顶部展示双向跳转成功率（验收口径 ≥95%），便于直接取证。
 */
import { useCallback, useEffect, useState } from 'react';

import { Button, EmptyState, Tag } from '@ec/ui';
import type { NavElementRef } from '@ec/ai';

import { useNavApi, type JumpStats } from './nav-api';
import { DataFlowOverlay } from './DataFlowOverlay';
import { JumpOverlay } from './JumpOverlay';
import { RelationGraphView } from './RelationGraphView';

export interface NavWorkspaceProps {
  /** 当前页面 id（供跳转请求使用） */
  pageId?: string;
  /** 当前页面的元素清单（供悬停 / Ctrl 点击跳转） */
  elements?: readonly NavElementRef[];
  /** 当前打开的文件（就近优先） */
  currentFile?: string | null | undefined;
}

export function NavWorkspace({
  pageId = '',
  elements = [],
  currentFile,
}: NavWorkspaceProps): JSX.Element {
  const api = useNavApi();
  const [stats, setStats] = useState<JumpStats | null>(null);
  const [flowElement, setFlowElement] = useState<string | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);

  useEffect(() => {
    void api.jumpStats().then(setStats);
  }, [api]);

  const openFlow = useCallback((elementId: string) => {
    setFlowElement(elementId);
    setFlowOpen(true);
  }, []);

  return (
    <section
      className="ec-nav-workspace"
      aria-label="导航与跳转"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <header
        className="ec-nav-workspace__head"
        style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <strong>导航与跳转</strong>
        {stats !== null && (
          <span data-testid="jump-stats" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Tag color={stats.forward.rate >= 0.95 ? 'success' : 'warning'}>
              正跳成功率 {Math.round(stats.forward.rate * 100)}%（{stats.forward.success}/
              {stats.forward.total}）
            </Tag>
            <Tag color={stats.reverse.rate >= 0.95 ? 'success' : 'warning'}>
              反跳成功率 {Math.round(stats.reverse.rate * 100)}%（{stats.reverse.success}/
              {stats.reverse.total}）
            </Tag>
          </span>
        )}
      </header>

      <div
        className="ec-nav-workspace__body"
        style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}
      >
        <RelationGraphView />

        <aside
          className="ec-nav-workspace__side"
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {elements.length === 0 ? (
            <EmptyState
              title="没有可跳转的元素"
              description="在设计器里选中页面后，这里会列出元素并提供悬停 / Ctrl 点击跳转。"
            />
          ) : (
            <ul
              className="ec-nav-workspace__elements"
              data-testid="nav-element-list"
              style={{ listStyle: 'none', padding: 0, margin: 0 }}
            >
              {elements.map((element) => (
                <li
                  key={element.elementId}
                  className="ec-nav-workspace__element"
                  data-testid={`nav-element-${element.elementId}`}
                  style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}
                >
                  <JumpOverlay
                    pageId={pageId}
                    element={element}
                    {...(currentFile !== undefined ? { currentFile } : {})}
                  />
                  <span style={{ color: 'var(--ec-color-text-secondary)' }}>{element.type}</span>
                  <span style={{ flex: 1 }} />
                  <Button
                    size="sm"
                    onClick={() => openFlow(element.elementId)}
                    data-testid={`open-flow-${element.elementId}`}
                  >
                    数据流
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <DataFlowOverlay elementId={flowElement} open={flowOpen} onOpenChange={setFlowOpen} />
    </section>
  );
}
