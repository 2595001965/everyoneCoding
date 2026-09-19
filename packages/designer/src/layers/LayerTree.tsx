/**
 * LayerTree：图层树主组件（T3-06 三向联动核心）。
 *
 * 行为：
 * 1. 用 `@ec/ui` 虚拟树渲染 dsl.tree，500+ 节点只渲染窗口内行；
 * 2. 按名称 / 类型搜索过滤（保留命中节点的祖先链）；
 * 3. 行点击选中（Shift/Ctrl 多选），与画布 / 属性面板共享 editor store 的 selectedIds；
 * 4. hover 一行 => store.setHovered（画布描边）；画布 hover 回写也会体现在 store；
 * 5. 右键菜单：重命名 / 锁定 / 隐藏 / 删除 / 复制；
 * 6. 双击重命名 => 先发 `onRenameRequest`（Wave 7 接管）+ 乐观 updateMeta({name})；
 * 7. 拖拽改层级（useLayerDnd），循环拖入被拒绝，一步进撤销栈；
 * 8. 锁定元素显示锁标（画布跳过命中测试由画布负责），隐藏元素显示眼睛关闭标且 DSL 保留节点。
 */
import * as React from 'react';
import { ContextMenu, type MenuOption, SearchInput, Tree, type TreeNode } from '@ec/ui';

import { findById, walkElements } from '../dsl/traverse';
import type { ElementNode } from '../dsl/types';
import type { NoteBadgeInfo } from '../notes/note-repo';
import { useDesignerStore, useEditorState } from '../store/designer-context';
import type { SelectionMode } from '../store/editor-store';
import { LayerNode } from './LayerNode';
import { rowIdFromEvent, useLayerDnd } from './useLayerDnd';

export interface LayerTreeProps {
  /** 重命名事件（Wave 7 统一重命名流程接管）；本任务仅转发 + 乐观更新 */
  onRenameRequest?: (elementId: string, newName: string) => void;
  /** 固定高度（虚拟化需要） */
  height?: number;
  /** 行高 */
  itemHeight?: number;
  ariaLabel?: string;
  /** 未解决备注角标（T4-01）：给出 elementId 即返回角标信息，缺省不渲染 */
  noteBadges?: ((elementId: string) => NoteBadgeInfo | null) | undefined;
}

interface BuildArgs {
  editingId: string | null;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
  noteBadges?: ((elementId: string) => NoteBadgeInfo | null) | undefined;
}

function elementToTreeNode(node: ElementNode, args: BuildArgs): TreeNode {
  return {
    id: node.id,
    label: (
      <LayerNode
        element={node}
        editing={node.id === args.editingId}
        onStartRename={args.onStartRename}
        onCommitRename={args.onCommitRename}
        onCancelRename={args.onCancelRename}
        note={args.noteBadges?.(node.id) ?? null}
      />
    ),
    children: (node.children ?? []).map((child) => elementToTreeNode(child, args)),
  };
}

/** 收集需要展开的容器节点 id（有子节点的节点），用于图层树默认展开 */
function expandableIds(root: ElementNode): string[] {
  return walkElements(root)
    .filter((walked) => (walked.node.children ?? []).length > 0)
    .map((walked) => walked.node.id);
}

/** 搜索过滤：命中节点自身或任一后代则保留（从而保留祖先链） */
function filterElement(
  node: ElementNode,
  predicate: (n: ElementNode) => boolean,
): ElementNode | null {
  const children = (node.children ?? [])
    .map((child) => filterElement(child, predicate))
    .filter((kept): kept is ElementNode => kept !== null);
  if (predicate(node) || children.length > 0) {
    return children.length > 0 ? { ...node, children } : node;
  }
  return null;
}

export function LayerTree({
  onRenameRequest,
  height = 400,
  itemHeight = 28,
  ariaLabel = '图层树',
  noteBadges,
}: LayerTreeProps): React.ReactElement {
  const store = useDesignerStore();
  const dsl = useEditorState((s) => s.dsl);
  const selectedIds = useEditorState((s) => s.selectedIds);
  const dnd = useLayerDnd();

  const [query, setQuery] = React.useState('');
  const [editingId, setEditingId] = React.useState<string | null>(null);
  /** 默认展开全部容器层级：图层树打开即可看到子元素，避免"看不到内容"的困惑 */
  const [expanded, setExpanded] = React.useState<string[]>(() => expandableIds(dsl.tree));
  const [contextTargetId, setContextTargetId] = React.useState<string | null>(null);

  // 切换页面 / 文档被整体替换时重新展开
  const activePageId = dsl.id;
  React.useEffect(() => {
    setExpanded(expandableIds(store.getState().dsl.tree));
    setEditingId(null);
    setQuery('');
  }, [activePageId, store]);

  // 记录鼠标按键修饰符，供 Tree 的 onSelect 判定多选模式（mousedown 先于 click 触发）
  const lastModifiers = React.useRef<{ shift: boolean; ctrl: boolean; meta: boolean }>({
    shift: false,
    ctrl: false,
    meta: false,
  });

  const allIds = React.useMemo(() => walkElements(dsl.tree).map((w) => w.node.id), [dsl.tree]);

  // 搜索状态下自动展开全部，确保命中可见
  React.useEffect(() => {
    if (query.trim()) setExpanded(allIds);
  }, [query, allIds]);

  // 拖拽高亮目标容器行（直接操作 DOM，避免污染 React 选中态）
  React.useEffect(() => {
    const prev = document.querySelector('.ec-layer-row--drop-target');
    if (prev) prev.classList.remove('ec-layer-row--drop-target');
    if (dnd.dragState.overId) {
      const el = document.getElementById(`ec-tree-${dnd.dragState.overId}`);
      el?.classList.add('ec-layer-row--drop-target');
    }
  }, [dnd.dragState.overId]);

  const treeNodes = React.useMemo<TreeNode[]>(() => {
    const q = query.trim().toLowerCase();
    const root = q
      ? filterElement(
          dsl.tree,
          (n) => (n.name ?? '').toLowerCase().includes(q) || n.type.toLowerCase().includes(q),
        )
      : dsl.tree;
    if (root === null) return [];
    const args: BuildArgs = {
      editingId,
      onStartRename: (id) => setEditingId(id),
      onCommitRename: (id, name) => {
        setEditingId(null);
        onRenameRequest?.(id, name);
        store.getState().updateMeta(id, { name });
      },
      onCancelRename: () => setEditingId(null),
      ...(noteBadges !== undefined ? { noteBadges } : {}),
    };
    return [elementToTreeNode(root, args)];
  }, [dsl.tree, query, editingId, onRenameRequest, store, noteBadges]);

  const handleSelect = React.useCallback(
    (id: string) => {
      const mods = lastModifiers.current;
      let mode: SelectionMode = 'replace';
      if (mods.shift) mode = 'add';
      else if (mods.ctrl || mods.meta) mode = 'toggle';
      store.getState().select([id], { mode });
    },
    [store],
  );

  const handleMouseOver = React.useCallback(
    (e: React.MouseEvent) => {
      const id = rowIdFromEvent(e);
      if (id) store.getState().setHovered(id);
    },
    [store],
  );

  const contextElement = contextTargetId ? findById(dsl.tree, contextTargetId) : null;

  const menuItems: MenuOption[] = React.useMemo(() => {
    const locked = contextElement?.locked ?? false;
    const hidden = contextElement?.hidden ?? false;
    return [
      { key: 'rename', label: '重命名' },
      { key: 'lock', label: locked ? '解锁' : '锁定' },
      { key: 'hide', label: hidden ? '显示' : '隐藏' },
      { key: 'divider', label: '', separator: true },
      { key: 'duplicate', label: '复制' },
      { key: 'delete', label: '删除', danger: true },
    ];
  }, [contextElement]);

  const handleMenuSelect = React.useCallback(
    (key: string) => {
      const id = contextTargetId;
      if (!id) return;
      const api = store.getState();
      switch (key) {
        case 'rename':
          setEditingId(id);
          break;
        case 'lock':
          api.updateMeta(id, { locked: !(contextElement?.locked ?? false) });
          break;
        case 'hide':
          api.updateMeta(id, { hidden: !(contextElement?.hidden ?? false) });
          break;
        case 'duplicate':
          api.duplicateElement(id);
          break;
        case 'delete':
          api.removeElements([id]);
          break;
        default:
          break;
      }
      setContextTargetId(null);
    },
    [contextTargetId, contextElement, store],
  );

  const handleContextMenuCapture = React.useCallback(
    (e: React.MouseEvent) => {
      const id = rowIdFromEvent(e);
      if (!id) return;
      setContextTargetId(id);
      store.getState().select([id], { mode: 'replace' });
    },
    [store],
  );

  return (
    <div className="ec-layer-tree">
      <div className="ec-layer-tree__toolbar">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="按名称或类型搜索"
          aria-label="搜索图层"
        />
      </div>
      <ContextMenu items={menuItems} onSelect={handleMenuSelect}>
        <div
          className="ec-layer-tree__scroll"
          onMouseDownCapture={(e) => {
            lastModifiers.current = {
              shift: e.shiftKey,
              ctrl: e.ctrlKey,
              meta: e.metaKey,
            };
          }}
          onMouseOverCapture={handleMouseOver}
          onContextMenuCapture={handleContextMenuCapture}
          {...dnd.handlers}
        >
          <Tree
            data={treeNodes}
            height={height}
            itemHeight={itemHeight}
            expanded={expanded}
            onExpandedChange={setExpanded}
            {...(selectedIds.length > 0 ? { selected: selectedIds[0]! } : {})}
            onSelect={handleSelect}
            aria-label={ariaLabel}
          />
        </div>
      </ContextMenu>
    </div>
  );
}
