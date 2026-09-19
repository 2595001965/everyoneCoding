import * as React from 'react';

import { Button, Select, Tag } from '@ec/ui';

import type { ConditionComparisonOp, ConditionExpr, ConditionOp } from '../dsl/types';
import {
  CONDITION_OPERATOR_LABELS,
  LOGICAL_OPS,
  UNARY_OPS,
  createCondition,
  describeCondition,
  parseCondition,
} from '../shared/condition';

/**
 * 条件渲染分区（T3-05 要点 3）。
 *
 * 结构化条件树（AND / OR / NOT + 比较 / 集合 / 空值运算），**不使用 eval**：
 * 面板只编辑可序列化的 JSON 结构，求值交给 `shared/condition.evaluateCondition`。
 */

/** 可用于条件的比较运算符（面板下拉） */
export const COMPARISON_OPS: readonly ConditionOp[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'endsWith',
  'in',
];

/** 比较类条件（排除逻辑 / 一元 / 集合运算） */
type ComparisonExpr = Extract<ConditionExpr, { op: ConditionComparisonOp }>;

function isComparisonExpr(node: ConditionExpr): node is ComparisonExpr {
  return !(['and', 'or', 'not', 'truthy', 'falsy', 'empty', 'in'] as string[]).includes(node.op);
}

export interface ConditionEditorProps {
  value: ConditionExpr | null | undefined;
  onChange: (next: ConditionExpr | null) => void;
  /** 可选字段建议（状态变量 + 接口字段路径） */
  suggestions?: readonly string[];
  title?: string;
  testId?: string;
}

export function ConditionEditor({
  value,
  onChange,
  suggestions = [],
  title = '条件表达式',
  testId = 'condition-editor',
}: ConditionEditorProps): React.ReactElement {
  const expr = parseCondition(value) ?? null;

  if (expr === null) {
    return (
      <div
        className="ec-condition-editor"
        data-testid={testId}
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        <p style={{ fontSize: 12, opacity: 0.6 }}>{title}：未设置（始终渲染）</p>
        <Button size="sm" variant="secondary" onClick={() => onChange(createCondition('eq'))}>
          添加条件
        </Button>
      </div>
    );
  }

  return (
    <div
      className="ec-condition-editor"
      data-testid={testId}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <Tag color="info">{describeCondition(expr)}</Tag>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          清除
        </Button>
      </header>
      <ConditionNodeView node={expr} depth={0} suggestions={suggestions} onChange={onChange} />
      <p
        data-testid="condition-structured"
        style={{ fontSize: 11, opacity: 0.5, wordBreak: 'break-all' }}
      >
        {JSON.stringify(expr)}
      </p>
    </div>
  );
}

interface ConditionNodeViewProps {
  node: ConditionExpr;
  depth: number;
  suggestions: readonly string[];
  onChange: (next: ConditionExpr) => void;
}

function ConditionNodeView({
  node,
  depth,
  suggestions,
  onChange,
}: ConditionNodeViewProps): React.ReactElement {
  const opOptions = [...LOGICAL_OPS, ...UNARY_OPS, ...COMPARISON_OPS].map((op) => ({
    value: op,
    label: CONDITION_OPERATOR_LABELS[op],
  }));

  const opSelect = (
    <Select
      aria-label="运算符"
      size="sm"
      value={node.op}
      options={opOptions}
      onChange={(next) => onChange(createCondition(next as ConditionOp))}
    />
  );

  const indent = depth === 0 ? 0 : 12;

  if (node.op === 'and' || node.op === 'or') {
    return (
      <div
        data-testid={`condition-group-${node.op}`}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          paddingLeft: indent,
          borderLeft: indent > 0 ? '1px dashed #dee2e6' : undefined,
        }}
      >
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {opSelect}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange({ ...node, items: [...node.items, createCondition('eq')] })}
          >
            添加子条件
          </Button>
          <span style={{ fontSize: 11, opacity: 0.55 }}>{`${node.items.length} 个子条件`}</span>
        </div>
        {node.items.length === 0 && <p style={{ fontSize: 12, opacity: 0.6 }}>还没有子条件</p>}
        {node.items.map((item, index) => (
          <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <ConditionNodeView
                node={item}
                depth={depth + 1}
                suggestions={suggestions}
                onChange={(next) => {
                  const items = node.items.slice();
                  items[index] = next;
                  onChange({ ...node, items });
                }}
              />
            </div>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`删除第 ${index + 1} 个子条件`}
              onClick={() =>
                onChange({ ...node, items: node.items.filter((_item, i) => i !== index) })
              }
            >
              移除
            </Button>
          </div>
        ))}
      </div>
    );
  }

  if (node.op === 'not') {
    return (
      <div
        data-testid="condition-not"
        style={{ display: 'flex', gap: 6, alignItems: 'flex-start', paddingLeft: indent }}
      >
        {opSelect}
        <div style={{ flex: 1 }}>
          <ConditionNodeView
            node={node.item}
            depth={depth + 1}
            suggestions={suggestions}
            onChange={(next) => onChange({ op: 'not', item: next })}
          />
        </div>
      </div>
    );
  }

  if (node.op === 'truthy' || node.op === 'falsy' || node.op === 'empty') {
    return (
      <div
        data-testid={`condition-${node.op}`}
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flexWrap: 'wrap',
          paddingLeft: indent,
        }}
      >
        <PathInput
          label="字段路径"
          value={node.left}
          suggestions={suggestions}
          onChange={(next) => onChange({ ...node, left: next })}
        />
        {opSelect}
      </div>
    );
  }

  if (node.op === 'in') {
    return (
      <div
        data-testid="condition-in"
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flexWrap: 'wrap',
          paddingLeft: indent,
        }}
      >
        <PathInput
          label="字段路径"
          value={node.left}
          suggestions={suggestions}
          onChange={(next) => onChange({ ...node, left: next })}
        />
        {opSelect}
        <input
          aria-label="集合取值（逗号分隔）"
          value={node.right.map((item) => String(item)).join(',')}
          onChange={(event) =>
            onChange({
              ...node,
              right: event.target.value
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item.length > 0),
            })
          }
          style={{ flex: 1, minWidth: 120, padding: '4px 8px' }}
        />
      </div>
    );
  }

  if (!isComparisonExpr(node)) {
    return (
      <div data-testid="condition-unknown" style={{ fontSize: 12, opacity: 0.6 }}>
        不支持的条件类型
      </div>
    );
  }

  const comparison: ComparisonExpr = node;
  const rightText = comparison.right === null ? '' : String(comparison.right);
  return (
    <div
      data-testid={`condition-${comparison.op}`}
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        flexWrap: 'wrap',
        paddingLeft: indent,
      }}
    >
      <PathInput
        label="字段路径"
        value={comparison.left}
        suggestions={suggestions}
        onChange={(next) => onChange({ ...comparison, left: next })}
      />
      {opSelect}
      <input
        aria-label="比较值"
        value={rightText}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === 'true' || raw === 'false')
            return onChange({ ...comparison, right: raw === 'true' });
          if (raw.trim() !== '' && !Number.isNaN(Number(raw)))
            return onChange({ ...comparison, right: Number(raw) });
          return onChange({ ...comparison, right: raw });
        }}
        style={{ flex: 1, minWidth: 100, padding: '4px 8px' }}
      />
    </div>
  );
}

function PathInput({
  label,
  value,
  suggestions,
  onChange,
}: {
  label: string;
  value: string;
  suggestions: readonly string[];
  onChange: (next: string) => void;
}): React.ReactElement {
  const listId = React.useId();
  return (
    <>
      <input
        aria-label={label}
        list={suggestions.length > 0 ? listId : undefined}
        value={value}
        placeholder="如 user.role"
        onChange={(event) => onChange(event.target.value)}
        style={{ flex: 1, minWidth: 120, padding: '4px 8px' }}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      )}
    </>
  );
}

export interface ConditionPanelProps {
  value: ConditionExpr | null | undefined;
  onChange: (next: ConditionExpr | null) => void;
  suggestions?: readonly string[];
}

export function ConditionPanel({
  value,
  onChange,
  suggestions,
}: ConditionPanelProps): React.ReactElement {
  return (
    <div className="ec-condition-panel">
      <p style={{ fontSize: 12, opacity: 0.65, marginBottom: 8 }}>
        条件不满足时该元素在预览中不渲染；设计器内仍显示，便于继续编辑。
      </p>
      <ConditionEditor
        value={value}
        onChange={onChange}
        title="条件渲染"
        testId="condition-panel"
        {...(suggestions !== undefined ? { suggestions } : {})}
      />
    </div>
  );
}
