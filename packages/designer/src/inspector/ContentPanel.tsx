import * as React from 'react';

import { EmptyState, Tag } from '@ec/ui';

import type { ElementNode } from '../dsl/types';
import { componentRegistry } from '../registry/component-registry';
import type { PropSchema } from '../registry/prop-schema';
import { SchemaForm } from './SchemaForm';

/**
 * 内容分区（T3-05）：组件 props 编辑。
 *
 * schema 来自组件注册表（T3-04），因此新增组件无需改属性面板：
 * 注册时带 `propSchema` 即自动出现在这里。未注册类型退化为「裸 props JSON 编辑」。
 */

/** 内置兜底 schema：未注册组件也能编辑 props */
export const FALLBACK_PROPS_SCHEMA: PropSchema = {
  fields: [{ key: 'data', label: '属性（JSON）', type: 'json', group: '高级' }],
};

export interface ContentPanelProps {
  element: ElementNode;
  debounceMs?: number;
  onPropChange: (key: string, value: unknown, options?: { coalesceKey?: string }) => void;
  /** 整体替换 props（JSON 编辑用） */
  onPropsReplace: (props: Record<string, unknown>) => void;
  onlyKeys?: readonly string[];
}

export function ContentPanel({
  element,
  debounceMs,
  onPropChange,
  onPropsReplace,
  onlyKeys,
}: ContentPanelProps): React.ReactElement {
  const meta = componentRegistry.get(element.type);
  const [rawMode, setRawMode] = React.useState(false);

  const values = React.useMemo(() => ({ ...(meta?.defaultProps ?? {}), ...(element.props ?? {}) }), [meta, element.props]);

  return (
    <div className="ec-content-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Tag color="info">{element.type}</Tag>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{element.name ?? '未命名'}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="toggle-raw-props"
          onClick={() => setRawMode((value) => !value)}
          style={{ background: 'none', border: 'none', fontSize: 12, cursor: 'pointer', opacity: 0.7 }}
        >
          {rawMode ? '表单编辑' : 'JSON 编辑'}
        </button>
      </header>

      {meta === null && !rawMode && (
        <EmptyState title="未注册的组件" description="该类型不在组件注册表中，只能以 JSON 方式编辑属性。" />
      )}

      {rawMode ? (
        <SchemaForm
          schema={FALLBACK_PROPS_SCHEMA}
          values={{ data: element.props ?? {} }}
          onChange={(_key, value) => {
            if (value === undefined) onPropsReplace({});
            else if (typeof value === 'object' && value !== null) onPropsReplace(value as Record<string, unknown>);
          }}
          debounceMs={0}
        />
      ) : (
        <SchemaForm
          schema={meta?.propSchema ?? FALLBACK_PROPS_SCHEMA}
          values={values}
          onChange={onPropChange}
          {...(debounceMs !== undefined ? { debounceMs } : {})}
          {...(onlyKeys !== undefined ? { onlyKeys } : {})}
        />
      )}
    </div>
  );
}
