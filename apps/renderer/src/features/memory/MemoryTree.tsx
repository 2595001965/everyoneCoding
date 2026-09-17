import { useMemo } from 'react';

import { Tree, type TreeNode } from '@ec/ui';
import { LAYER_LABELS, MEMORY_LAYERS } from '@ec/memory';

import type { MemoryStats } from './memory-api';

/**
 * 记忆中心左侧分层树（FR-MEM-21）。
 *
 * 三段结构：
 * - **分层**：长期 / 项目 / 功能 / 页面 / 元素 / 问题，带条数角标；
 * - **标签**：全部出现过的标签，点击即筛选（可多选，父组件维护选中集合）；
 * - **视图**：置顶分组与「进行中问题」快捷入口。
 *
 * 节点 id 采用 `layer:` / `tag:` / `view:` 前缀，父组件据此解析，
 * 避免在树组件里塞业务分支。
 */

export const LAYER_NODE_PREFIX = 'layer:';
export const TAG_NODE_PREFIX = 'tag:';
export const VIEW_NODE_PREFIX = 'view:';

export type MemoryViewKey = 'pinned' | 'issues';

export function layerNodeId(layer: string): string {
  return `${LAYER_NODE_PREFIX}${layer}`;
}

export function tagNodeId(tag: string): string {
  return `${TAG_NODE_PREFIX}${tag}`;
}

export function viewNodeId(view: MemoryViewKey): string {
  return `${VIEW_NODE_PREFIX}${view}`;
}

export interface MemoryTreeProps {
  stats: MemoryStats;
  /** 全部标签（父组件从当前列表聚合） */
  tags: readonly string[];
  /** 已选标签（多选） */
  selectedTags?: readonly string[];
  /** 当前选中的树节点 id（layer: / tag: / view: 前缀） */
  selectedNodeId?: string | undefined;
  /** 节点被选中（父组件据此解析前缀并切换筛选） */
  onSelect?: ((nodeId: string) => void) | undefined;
  height?: number;
  defaultExpanded?: readonly string[];
}

export function MemoryTree({
  stats,
  tags,
  selectedTags = [],
  selectedNodeId,
  onSelect,
  height = 420,
  defaultExpanded = ['group:layers', ...(selectedTags.length > 0 ? ['group:tags'] : [])],
}: MemoryTreeProps): JSX.Element {
  const data = useMemo<TreeNode[]>(() => {
    const countOf = (layer: string): number => stats.layers.find((entry) => entry.layer === layer)?.total ?? 0;

    const layerNodes: TreeNode[] = MEMORY_LAYERS.map((layer) => ({
      id: layerNodeId(layer),
      label: (
        <span className="ec-memory-tree__label">
          <span className="ec-memory-tree__name">{LAYER_LABELS[layer]}</span>
          <span className="ec-memory-tree__count">{countOf(layer)}</span>
        </span>
      ),
      ...(layer === 'issue' && stats.activeIssues > 0
        ? {
            icon: (
              <span className="ec-memory-tree__dot" title={`${stats.activeIssues} 个进行中问题`} aria-hidden="true">
                ●
              </span>
            ),
          }
        : {}),
    }));

    const tagNodes: TreeNode[] = tags
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((tag) => ({
        id: tagNodeId(tag),
        label: (
          <span className="ec-memory-tree__label">
            <span className="ec-memory-tree__name">{tag}</span>
            {selectedTags.includes(tag) && <span className="ec-memory-tree__mark">✓</span>}
          </span>
        ),
      }));

    return [
      { id: 'group:layers', label: '分层', children: layerNodes },
      { id: 'group:tags', label: `标签（${tags.length}）`, children: tagNodes },
      {
        id: 'group:views',
        label: '视图',
        children: [
          { id: viewNodeId('pinned'), label: '置顶' },
          {
            id: viewNodeId('issues'),
            label: (
              <span className="ec-memory-tree__label">
                <span className="ec-memory-tree__name">进行中问题</span>
                <span className="ec-memory-tree__count">{stats.activeIssues}</span>
              </span>
            ),
          },
        ],
      },
    ];
  }, [stats, tags, selectedTags]);

  return (
    <div className="ec-memory-tree">
      {/* 选中态由父组件持有（标签是多选，选中态同时体现在 label 的 ✓ 上） */}
      <Tree
        data={data}
        height={height}
        defaultExpanded={[...defaultExpanded]}
        {...(selectedNodeId !== undefined ? { selected: selectedNodeId } : {})}
        {...(onSelect ? { onSelect } : {})}
        aria-label="记忆分层树"
      />
    </div>
  );
}
