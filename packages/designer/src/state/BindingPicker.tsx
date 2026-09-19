/**
 * 数据绑定选择器（T3-08）。
 *
 * - 可视化选择绑定目标：数据来源是 `listDataSourcePaths(catalog)`（页面状态 + 接口响应字段）。
 * - 支持对象 / 数组路径选择，例如 `user.list[0].name`：状态对象 / 数组会按初值结构自动展开层级，
 *   接口的响应字段按 `responseFields` 展开。
 * - 也支持手动输入路径，用 `parsePath` 校验，非法时给出中文报错。
 * - 选定后生成路径表达式，由外部通过 `setBindings` 写入元素 `bindings`（键为属性名）。
 */

import * as React from 'react';
import { Button, Input, Tag, Tree, type TreeNode } from '@ec/ui';

import { formatPath, parsePath, type PathSegment } from '../shared/expression';
import {
  listDataSourcePaths,
  type DataField,
  type DataSourceCatalog,
  type StateDef,
} from '../shared/data-source';
import type { StateType } from '../dsl/types';

/** 从值推断 StateType */
function inferType(value: unknown): StateType {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'object';
  return 'string';
}

/** 把一个值递归展开为 DataField 树（用于对象 / 数组路径选择） */
export function valueToField(name: string, value: unknown): DataField {
  const field: DataField = { name, type: inferType(value) };
  if (Array.isArray(value) && value.length > 0) {
    field.children = [valueToField('0', value[0]!)]; // 下标段渲染为 [...]
  } else if (value !== null && typeof value === 'object') {
    field.children = Object.entries(value as Record<string, unknown>).map(([key, child]) =>
      valueToField(key, child),
    );
  }
  return field;
}

/** 由状态变量声明展开其可绑定字段（无初值则无子级） */
export function expandStateShape(state: StateDef): DataField | null {
  if (state.initial === undefined) return null;
  return valueToField(state.name, state.initial);
}

const TYPE_COLORS: Record<
  StateType,
  'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'
> = {
  string: 'neutral',
  number: 'primary',
  boolean: 'success',
  object: 'warning',
  array: 'info',
};

export interface BindingPickerProps {
  /** 数据源目录（来自 getDataSources） */
  catalog: DataSourceCatalog;
  /** 需要绑定的属性名，如 'value'、'text' */
  property: string;
  /** 当前已绑定的路径（用于回显与清除） */
  value?: string | undefined;
  /** 确认绑定：property + 路径表达式 */
  onBind: (property: string, path: string) => void;
  /** 清除绑定 */
  onUnbind?: (property: string) => void;
}

export function BindingPicker(props: BindingPickerProps): React.ReactElement {
  const { catalog, property, value, onBind, onUnbind } = props;
  const [manual, setManual] = React.useState('');
  const [manualError, setManualError] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  // 构建可展开的数据源树：状态按初值结构展开，接口按 responseFields 展开。
  const { nodes, idToPath } = React.useMemo(() => {
    const idToPath = new Map<string, string>();
    let counter = 0;
    const nodes: TreeNode[] = [];

    const makeNode = (
      segments: PathSegment[],
      label: React.ReactNode,
      children?: TreeNode[],
    ): TreeNode => {
      const id = `bn-${counter}`;
      counter += 1;
      idToPath.set(id, formatPath(segments));
      const node: TreeNode = { id, label };
      if (children) node.children = children;
      return node;
    };

    const fieldNode = (parentSegments: PathSegment[], field: DataField): TreeNode => {
      const seg: PathSegment = /^\d+$/.test(field.name) ? Number(field.name) : field.name;
      const segments = [...parentSegments, seg];
      const children = field.children?.map((child) => fieldNode(segments, child));
      return makeNode(
        segments,
        <span>
          {field.name} <Tag color={TYPE_COLORS[field.type]}>{field.type}</Tag>
        </span>,
        children,
      );
    };

    for (const state of catalog.states) {
      const field = expandStateShape(state);
      const children = field?.children?.map((child) => fieldNode([state.name], child));
      nodes.push(
        makeNode(
          [state.name],
          <span>
            {state.name} <Tag color={TYPE_COLORS[state.type]}>{state.type}</Tag>
          </span>,
          children,
        ),
      );
    }

    for (const api of catalog.apis) {
      const children = (api.responseFields ?? []).map((child) => fieldNode(['response'], child));
      nodes.push(
        makeNode(
          [`response:${api.id}`],
          <span>
            {api.path} <Tag color="info">接口</Tag>
          </span>,
          children,
        ),
      );
    }

    return { nodes, idToPath };
  }, [catalog]);

  const handlePick = (id: string): void => {
    const path = idToPath.get(id);
    if (path) onBind(property, path);
  };

  const handleManualBind = (): void => {
    const path = manual.trim();
    if (path.length === 0) {
      setManualError('路径不能为空');
      return;
    }
    if (parsePath(path) === null) {
      setManualError('路径格式不合法：应为形如 user.list[0].name 的路径');
      return;
    }
    setManualError(null);
    onBind(property, path);
    setManual('');
  };

  return (
    <div className="ec-binding-picker" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>属性</span>
        <code
          style={{
            fontSize: 12,
            padding: '2px 6px',
            background: 'var(--ec-color-canvas-subtle, #f1f3f5)',
            borderRadius: 4,
          }}
        >
          {property}
        </code>
        {value ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Tag color="success">{value}</Tag>
            {onUnbind && (
              <Button variant="ghost" size="sm" onClick={() => onUnbind(property)}>
                清除
              </Button>
            )}
          </span>
        ) : (
          <span style={{ fontSize: 12, opacity: 0.5 }}>（未绑定）</span>
        )}
      </div>

      <div
        ref={listRef}
        style={{
          maxHeight: 200,
          overflow: 'auto',
          border: '1px solid var(--ec-color-border, #e3e8ef)',
          borderRadius: 6,
        }}
      >
        {nodes.length === 0 ? (
          <div style={{ padding: 12, fontSize: 12, opacity: 0.5 }}>暂无可选数据源</div>
        ) : (
          <Tree data={nodes} height={200} aria-label={`${property} 数据源`} onSelect={handlePick} />
        )}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <Input
          aria-label="手动输入绑定路径"
          value={manual}
          invalid={Boolean(manualError)}
          onChange={setManual}
          placeholder="手动输入路径，如 user.list[0].name"
        />
        <Button variant="secondary" size="sm" onClick={handleManualBind}>
          绑定
        </Button>
      </div>
      {manualError && (
        <span role="alert" style={{ color: 'var(--ec-color-danger, #e5484d)', fontSize: 12 }}>
          {manualError}
        </span>
      )}
    </div>
  );
}

/** 列出目录里全部可选路径（供测试与调试） */
export function listAllBindingPaths(catalog: DataSourceCatalog): string[] {
  return listDataSourcePaths(catalog).map((ref) => ref.path);
}
