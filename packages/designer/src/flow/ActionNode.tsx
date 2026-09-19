/**
 * 单个动作流节点（T3-09）：DOM 节点 + 可编辑参数 + 连接端口。
 * 不引第三方图库，节点拖动与连线由 FlowEditor 统一调度。
 */

import * as React from 'react';
import { Input, Select, Textarea } from '@ec/ui';

import { ACTION_LABELS, type FlowNode } from './flow-schema';
import { NODE_HEIGHT, type OutPort } from './EdgeLayer';

export interface ActionNodeViewProps {
  node: FlowNode;
  selected: boolean;
  x: number;
  y: number;
  onSelect: (id: string) => void;
  onChange: (node: FlowNode) => void;
  onDragStart: (id: string, event: React.PointerEvent) => void;
  onConnectStart: (id: string, port: OutPort, event: React.PointerEvent) => void;
}

const PORT_COLOR: Record<OutPort, string> = { next: '#868e96', true: '#2f9e44', false: '#e03131' };
/** 入边端口颜色 */
const PORT_IN_COLOR = '#1c7ed6';

function portStyle(port: OutPort | 'in'): React.CSSProperties {
  const base: React.CSSProperties = {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: '50%',
    border: '2px solid #fff',
    background: port === 'in' ? PORT_IN_COLOR : PORT_COLOR[port],
    cursor: 'crosshair',
    boxSizing: 'border-box',
  };
  if (port === 'in') return { ...base, left: -7, top: NODE_HEIGHT / 2 - 6 };
  if (port === 'next') return { ...base, right: -7, top: NODE_HEIGHT / 2 - 6 };
  if (port === 'true') return { ...base, right: -7, top: NODE_HEIGHT * 0.34 - 6 };
  return { ...base, right: -7, top: NODE_HEIGHT * 0.66 - 6 };
}

/** JSON 字段：内部维护原始文本，解析成功才回写 */
function JsonField(props: {
  label: string;
  value: unknown;
  onCommit: (value: unknown) => void;
  rows?: number;
}): React.ReactElement {
  const { label, value, onCommit, rows = 3 } = props;
  const [raw, setRaw] = React.useState(() => JSON.stringify(value ?? null, null, 2));
  const lastValue = React.useRef(value);
  if (lastValue.current !== value) {
    lastValue.current = value;
    setRaw(JSON.stringify(value ?? null, null, 2));
  }
  return (
    <Textarea
      aria-label={label}
      value={raw}
      rows={rows}
      onChange={(text) => {
        setRaw(text);
        try {
          onCommit(JSON.parse(text));
        } catch {
          /* 暂存非法 JSON，待用户补全 */
        }
      }}
    />
  );
}

export function ActionNode(props: ActionNodeViewProps): React.ReactElement {
  const { node, selected, x, y, onSelect, onChange, onDragStart, onConnectStart } = props;

  const setParam = (key: string, value: unknown): void => {
    onChange({ ...node, params: { ...node.params, [key]: value } });
  };

  const outPorts: OutPort[] = node.kind === 'branch' ? ['true', 'false'] : ['next'];

  return (
    <div
      data-node-id={node.id}
      data-kind={node.kind}
      role="treeitem"
      aria-label={`${ACTION_LABELS[node.kind]} 节点 ${node.id}`}
      onClick={() => onSelect(node.id)}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: 184,
        minHeight: NODE_HEIGHT,
        background: selected ? '#e7f5ff' : '#fff',
        border: `1px solid ${selected ? '#1971c2' : '#ced4da'}`,
        borderRadius: 8,
        boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
        padding: 8,
        boxSizing: 'border-box',
        fontSize: 12,
        userSelect: 'none',
      }}
    >
      <div
        onPointerDown={(e) => onDragStart(node.id, e)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'move', marginBottom: 6 }}
      >
        <span aria-hidden="true">
          {ACTION_LABELS[node.kind] === '跳转'
            ? '➡'
            : ACTION_LABELS[node.kind] === '请求'
              ? '⤴'
              : ACTION_LABELS[node.kind] === '赋值'
                ? '✎'
                : ACTION_LABELS[node.kind] === '提示'
                  ? '💬'
                  : '⑂'}
        </span>
        <strong>{ACTION_LABELS[node.kind]}</strong>
        {node.label ? <span style={{ opacity: 0.6 }}>{node.label}</span> : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {node.kind === 'navigate' && (
          <Input
            aria-label="目标页面"
            value={typeof node.params.route === 'string' ? node.params.route : ''}
            placeholder="目标路由，如 /dashboard"
            onChange={(v) => setParam('route', v)}
          />
        )}
        {node.kind === 'request' && (
          <>
            <Input
              aria-label="接口"
              value={typeof node.params.api === 'string' ? node.params.api : ''}
              placeholder="接口 id / 路径"
              onChange={(v) => setParam('api', v)}
            />
            <Select
              aria-label="请求方法"
              size="sm"
              options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({
                label: m,
                value: m,
              }))}
              value={typeof node.params.method === 'string' ? node.params.method : 'POST'}
              onChange={(v) => setParam('method', v)}
            />
            <JsonField
              label="请求入参"
              value={node.params.body}
              onCommit={(v) => setParam('body', v)}
            />
          </>
        )}
        {node.kind === 'assign' && (
          <>
            <Input
              aria-label="状态名"
              value={typeof node.params.name === 'string' ? node.params.name : ''}
              placeholder="状态名，如 loading"
              onChange={(v) => setParam('name', v)}
            />
            <Input
              aria-label="赋值表达式"
              value={typeof node.params.value === 'string' ? node.params.value : ''}
              placeholder="值 / 表达式，如 ${phone}"
              onChange={(v) => setParam('value', v)}
            />
          </>
        )}
        {node.kind === 'notify' && (
          <>
            <Select
              aria-label="提示类型"
              size="sm"
              options={[
                { label: '信息', value: 'info' },
                { label: '成功', value: 'success' },
                { label: '警告', value: 'warning' },
                { label: '错误', value: 'error' },
              ]}
              value={typeof node.params.type === 'string' ? node.params.type : 'info'}
              onChange={(v) => setParam('type', v)}
            />
            <Input
              aria-label="提示文案"
              value={typeof node.params.message === 'string' ? node.params.message : ''}
              placeholder="提示文案"
              onChange={(v) => setParam('message', v)}
            />
          </>
        )}
        {node.kind === 'branch' && (
          <JsonField
            label="条件表达式"
            value={node.params.expression}
            onCommit={(v) => setParam('expression', v)}
            rows={4}
          />
        )}
      </div>

      <div data-port="in" style={portStyle('in')} />
      {outPorts.map((port) => (
        <div
          key={port}
          data-port={port}
          style={portStyle(port)}
          title={port === 'true' ? '真分支' : port === 'false' ? '假分支' : '下一步'}
          onPointerDown={(e) => {
            e.stopPropagation();
            onConnectStart(node.id, port, e);
          }}
        />
      ))}
    </div>
  );
}
