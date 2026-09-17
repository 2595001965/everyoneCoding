import * as React from 'react';

import { Tag } from '@ec/ui';

import type { ElementNode } from '../dsl/types';
import { BindingPicker } from '../state/BindingPicker';
import type { ApiDef, DataSourceCatalog } from '../shared/data-source';
import { getDataSources } from '../shared/data-source';

/**
 * 数据绑定分区（T3-05）。
 *
 * 数据源目录由 T3-08 的 `getDataSources()` 提供（在 `shared/data-source.ts` 冻结），
 * 因此本分区无需知道状态与接口的内部结构：
 * - 状态字段（如 `user.list[0].name`）
 * - 接口响应字段（如 `response.data.token`）
 *
 * 绑定结果写入 `ElementNode.bindings`（键为属性名）。
 */

/** 常见可绑定属性（与 StatePanel 保持一致） */
export const DEFAULT_BINDABLE_PROPS: readonly string[] = [
  'value',
  'text',
  'checked',
  'disabled',
  'visible',
  'src',
  'label',
  'href',
];

export interface BindingPanelProps {
  element: ElementNode;
  /** 页面 DSL（用于推导数据源目录）；批量编辑时可只传 catalog */
  catalog?: DataSourceCatalog;
  onBind: (property: string, path: string) => void;
  onUnbind: (property: string) => void;
}

export function BindingPanel({ element, catalog, onBind, onUnbind }: BindingPanelProps): React.ReactElement {
  const bindableProps = React.useMemo(
    () => Array.from(new Set([...DEFAULT_BINDABLE_PROPS, ...Object.keys(element.bindings ?? {})])),
    [element.bindings],
  );

  if (catalog === undefined) {
    return (
      <div className="ec-binding-panel" data-testid="binding-panel-empty">
        <p style={{ fontSize: 12, opacity: 0.6 }}>未提供数据源目录（需先由 T3-08 注入页面状态与接口清单）</p>
      </div>
    );
  }

  return (
    <div className="ec-binding-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={{ fontSize: 13 }}>数据绑定</strong>
        <Tag color="info">{`${catalog.states.length} 个状态 / ${catalog.apis.length} 个接口`}</Tag>
      </header>
      {bindableProps.map((property) => (
        <section key={property} data-testid={`binding-${property}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <BindingPicker
            catalog={catalog}
            property={property}
            value={element.bindings?.[property]}
            onBind={onBind}
            onUnbind={onUnbind}
          />
        </section>
      ))}
    </div>
  );
}

/** 便捷构造：由页面 DSL 推导数据源目录（供 Inspector 使用） */
export function catalogForElement(dsl: Parameters<typeof getDataSources>[0], apiCatalog: readonly ApiDef[] = []): DataSourceCatalog {
  return getDataSources(dsl, apiCatalog);
}
