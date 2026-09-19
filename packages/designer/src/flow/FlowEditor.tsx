/**
 * 动作流编辑器（T3-09）：自绘 SVG 连线 + DOM 节点（不引第三方图库）。
 *
 * 能力：节点拖拽、连线（拖拽输出端口到目标节点）、删除、复制、简单分层自动布局；
 * 与 store 打通：通过 `useEditorState` 读取事件动作流，编辑结果用 `setPageEvents`
 * 写回（一次保存 = 一步 undo）。组件 props 暴露 `eventId`。
 */

import * as React from 'react';
import { Button, EmptyState, IconButton } from '@ec/ui';

import { useDesignerStore, useEditorState } from '../store/designer-context';
import type { ActionKind, EventDef } from '../dsl/types';
import { ActionNode } from './ActionNode';
import {
  EdgeLayer,
  NODE_HEIGHT,
  NODE_WIDTH,
  type NodePositions,
  type OutPort,
  type Point,
} from './EdgeLayer';
import { NodePalette } from './NodePalette';
import {
  ACTION_LABELS,
  createFlowNode,
  parseFlow,
  serializeFlow,
  type FlowNode,
} from './flow-schema';
import { validateFlow, type FlowIssue } from './flow-validator';

export interface FlowEditorProps {
  /** 编辑的目标事件 id */
  eventId: string;
  /** 测试注入 store 用；缺省走 context */
  store?: ReturnType<typeof useDesignerStore>;
  /** 画布高度（像素） */
  height?: number;
}

/** 按入边分层，得到简单自顶向下布局 */
function autoLayout(nodes: readonly FlowNode[]): NodePositions {
  const positions: NodePositions = {};
  if (nodes.length === 0) return positions;

  const incoming = new Set<string>();
  for (const node of nodes) {
    for (const target of [node.next, node.branchTrue, node.branchFalse]) {
      if (target) incoming.add(target);
    }
  }

  const layerOf = new Map<string, number>();
  const queue: Array<{ id: string; layer: number }> = [];
  const roots = nodes.filter((node) => !incoming.has(node.id));
  if (roots.length === 0) queue.push({ id: nodes[0]!.id, layer: 0 });
  else for (const root of roots) queue.push({ id: root.id, layer: 0 });

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (layerOf.has(item.id)) continue;
    layerOf.set(item.id, item.layer);
    const node = nodes.find((candidate) => candidate.id === item.id);
    const targets = node ? [node.next, node.branchTrue, node.branchFalse].filter(Boolean) : [];
    for (const target of targets) {
      if (target && !layerOf.has(target)) queue.push({ id: target, layer: item.layer + 1 });
    }
  }

  let maxLayer = 0;
  for (const layer of layerOf.values()) maxLayer = Math.max(maxLayer, layer);
  const layerIndex: Record<number, number> = {};
  for (const node of nodes) {
    const layer = layerOf.get(node.id) ?? maxLayer + 1;
    const index = layerIndex[layer] ?? 0;
    layerIndex[layer] = index + 1;
    positions[node.id] = { x: 40 + layer * (NODE_WIDTH + 90), y: 40 + index * (NODE_HEIGHT + 40) };
  }
  return positions;
}

export function FlowEditor(props: FlowEditorProps): React.ReactElement {
  const { eventId, store: storeProp, height = 520 } = props;
  const store = useDesignerStore();
  const effectiveStore = storeProp ?? store;
  const dsl = useEditorState((s) => s.dsl);

  const event: EventDef | undefined = dsl.events.find((e) => e.id === eventId);

  const [nodes, setNodes] = React.useState<FlowNode[]>([]);
  const [positions, setPositions] = React.useState<NodePositions>({});
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState<{ id: string; offsetX: number; offsetY: number } | null>(
    null,
  );
  const [connect, setConnect] = React.useState<{ fromId: string; port: OutPort } | null>(null);
  const [pointer, setPointer] = React.useState<Point | null>(null);

  const containerRef = React.useRef<HTMLDivElement>(null);
  const idSeq = React.useRef(0);
  const loadedRef = React.useRef<string | null>(null);

  // 进入编辑器 / 切换事件时，从 DSL 载入动作流（仅一次，避免覆盖本地编辑）
  React.useEffect(() => {
    if (loadedRef.current === eventId) return;
    loadedRef.current = eventId;
    const ev = effectiveStore.getState().dsl.events.find((e) => e.id === eventId);
    const initial = ev ? parseFlow(ev.actions) : [];
    setNodes(initial);
    setPositions(autoLayout(initial));
    setSelectedId(null);
  }, [eventId, effectiveStore]);

  if (!event) {
    return <EmptyState title="未找到事件" description={`事件 ${eventId} 不存在`} />;
  }

  const toLocal = (clientX: number, clientY: number): Point => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  const addNode = (kind: ActionKind): void => {
    const id = `fn-${idSeq.current}`;
    idSeq.current += 1;
    const node = createFlowNode(kind, { id });
    const pos: Point = { x: 40 + nodes.length * 24, y: 40 + nodes.length * 24 };
    setNodes((prev) => [...prev, node]);
    setPositions((prev) => ({ ...prev, [id]: pos }));
    setSelectedId(id);
  };

  const updateNode = (updated: FlowNode): void => {
    setNodes((prev) => prev.map((node) => (node.id === updated.id ? updated : node)));
  };

  const deleteSelected = (): void => {
    if (!selectedId) return;
    const removed = selectedId;
    setNodes((prev) =>
      prev
        .filter((node) => node.id !== removed)
        .map((node) => {
          let next = node;
          if (next.next === removed) next = { ...next, next: null };
          if (next.branchTrue === removed) next = { ...next, branchTrue: null };
          if (next.branchFalse === removed) next = { ...next, branchFalse: null };
          return next;
        }),
    );
    setPositions((prev) => {
      const rest = { ...prev };
      delete rest[removed];
      return rest;
    });
    setSelectedId(null);
  };

  const copySelected = (): void => {
    if (!selectedId) return;
    const source = nodes.find((node) => node.id === selectedId);
    if (!source) return;
    const id = `fn-${idSeq.current}`;
    idSeq.current += 1;
    const clone: FlowNode = { ...source, id, params: { ...source.params } };
    setNodes((prev) => [...prev, clone]);
    setPositions((prev) => ({
      ...prev,
      [id]: { x: (prev[source.id]?.x ?? 0) + 24, y: (prev[source.id]?.y ?? 0) + 24 },
    }));
    setSelectedId(id);
  };

  const applyEdge = (fromId: string, port: OutPort, toId: string): void => {
    if (fromId === toId) return;
    setNodes((prev) =>
      prev.map((node) => {
        if (node.id !== fromId) return node;
        if (port === 'next') return { ...node, next: toId };
        if (port === 'true') return { ...node, branchTrue: toId };
        return { ...node, branchFalse: toId };
      }),
    );
  };

  const save = (): void => {
    const actions = serializeFlow(nodes);
    const events = effectiveStore
      .getState()
      .dsl.events.map((e) =>
        e.id === eventId
          ? { ...e, actions, ...(nodes[0]?.id !== undefined ? { entry: nodes[0].id } : {}) }
          : e,
      );
    effectiveStore.getState().setPageEvents(events);
  };

  const relayout = (): void => setPositions(autoLayout(nodes));

  const clearAll = (): void => {
    setNodes([]);
    setPositions({});
    setSelectedId(null);
  };

  const onContainerPointerMove = (e: React.PointerEvent): void => {
    if (drag) {
      const local = toLocal(e.clientX, e.clientY);
      setPositions((prev) => ({
        ...prev,
        [drag.id]: { x: local.x - drag.offsetX, y: local.y - drag.offsetY },
      }));
    } else if (connect) {
      setPointer(toLocal(e.clientX, e.clientY));
    }
  };

  const onContainerPointerUp = (e: React.PointerEvent): void => {
    if (connect) {
      const target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest('[data-node-id]') as HTMLElement | null;
      const targetId = target?.getAttribute('data-node-id') ?? null;
      if (targetId) applyEdge(connect.fromId, connect.port, targetId);
      setConnect(null);
      setPointer(null);
    }
    if (drag) {
      setDrag(null);
      containerRef.current?.releasePointerCapture?.(e.pointerId);
    }
  };

  const onDragStart = (id: string, e: React.PointerEvent): void => {
    const pos = positions[id];
    if (!pos) return;
    const local = toLocal(e.clientX, e.clientY);
    setSelectedId(id);
    setDrag({ id, offsetX: local.x - pos.x, offsetY: local.y - pos.y });
    containerRef.current?.setPointerCapture?.(e.pointerId);
  };

  const onConnectStart = (id: string, port: OutPort, e: React.PointerEvent): void => {
    setSelectedId(id);
    setConnect({ fromId: id, port });
    setPointer(toLocal(e.clientX, e.clientY));
    containerRef.current?.setPointerCapture?.(e.pointerId);
  };

  const issues: FlowIssue[] = validateFlow({
    nodes,
    ...(nodes[0]?.id !== undefined ? { entry: nodes[0].id } : {}),
    stateNames: dsl.state.map((state) => state.name),
    knownApis: dsl.apiDeps,
  });

  const maxX = Math.max(0, ...Object.values(positions).map((p) => p.x + NODE_WIDTH)) + 200;
  const maxY = Math.max(0, ...Object.values(positions).map((p) => p.y + NODE_HEIGHT)) + 200;
  const tempStart = connect ? portPointSafe(connect.fromId, connect.port, positions) : null;

  return (
    <div
      className="ec-flow-editor"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height,
        border: '1px solid #ced4da',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid #e3e8ef',
        }}
      >
        <strong style={{ fontSize: 13 }}>动作流编辑器</strong>
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={relayout}>
          自动布局
        </Button>
        <Button size="sm" variant="ghost" onClick={copySelected} disabled={!selectedId}>
          复制选中
        </Button>
        <Button size="sm" variant="ghost" onClick={deleteSelected} disabled={!selectedId}>
          删除选中
        </Button>
        <Button size="sm" variant="ghost" onClick={clearAll}>
          清空
        </Button>
        <Button size="sm" variant="primary" data-testid="flow-save" onClick={save}>
          保存
        </Button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 132, borderRight: '1px solid #e3e8ef', overflow: 'auto' }}>
          <NodePalette onAdd={addNode} />
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div
            ref={containerRef}
            onPointerMove={onContainerPointerMove}
            onPointerUp={onContainerPointerUp}
            style={{ position: 'relative', flex: 1, overflow: 'auto', background: '#f8f9fa' }}
          >
            <EdgeLayer
              nodes={nodes}
              positions={positions}
              width={maxX}
              height={maxY}
              tempStart={tempStart}
              tempEnd={pointer}
            />
            {nodes.map((node) => (
              <ActionNode
                key={node.id}
                node={node}
                selected={node.id === selectedId}
                x={positions[node.id]?.x ?? 0}
                y={positions[node.id]?.y ?? 0}
                onSelect={setSelectedId}
                onChange={updateNode}
                onDragStart={onDragStart}
                onConnectStart={onConnectStart}
              />
            ))}
            {nodes.length === 0 && (
              <div style={{ padding: 24, opacity: 0.5 }}>从左侧面板点击添加动作节点开始编排</div>
            )}
          </div>

          {issues.length > 0 && (
            <div
              data-testid="flow-issues"
              role="alert"
              style={{
                borderTop: '1px solid #e3e8ef',
                maxHeight: 120,
                overflow: 'auto',
                padding: 8,
                fontSize: 12,
              }}
            >
              {issues.map((issue, index) => (
                <div
                  key={`${issue.code}-${issue.nodeId ?? 'global'}-${index}`}
                  data-testid={`issue-${issue.code}`}
                  style={{ color: issue.severity === 'error' ? '#e03131' : '#f08c00' }}
                >
                  [{issue.severity === 'error' ? '错误' : '警告'}] {issue.message}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedId && (
        <div style={{ position: 'absolute', right: 8, bottom: 8 }}>
          <IconButton aria-label="删除选中节点" variant="danger" onClick={deleteSelected}>
            ×
          </IconButton>
        </div>
      )}
    </div>
  );
}

function portPointSafe(id: string, port: OutPort, positions: NodePositions): Point | null {
  // 复用 EdgeLayer 的坐标计算（避免循环依赖导致的导入顺序问题，这里内联实现）
  const pos = positions[id];
  if (!pos) return null;
  if (port === 'next') return { x: pos.x + NODE_WIDTH, y: pos.y + NODE_HEIGHT / 2 };
  if (port === 'true') return { x: pos.x + NODE_WIDTH, y: pos.y + NODE_HEIGHT * 0.34 };
  return { x: pos.x + NODE_WIDTH, y: pos.y + NODE_HEIGHT * 0.66 };
}

void ACTION_LABELS;
