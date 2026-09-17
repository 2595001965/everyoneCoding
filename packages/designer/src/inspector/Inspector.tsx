import * as React from 'react';
import type { StoreApi } from 'zustand';

import { Badge, Button, EmptyState, Tabs, Tooltip, useHotkeys } from '@ec/ui';

import { findById } from '../dsl/traverse';
import type { ApiDef } from '../shared/data-source';
import { getDataSources, listDataSourcePaths } from '../shared/data-source';
import type { ElementNode } from '../dsl/types';
import { useDesignerStore, useEditorState } from '../store/designer-context';
import { draftUpdateNode } from '../store/draft-tree';
import type { EditorStore } from '../store/editor-store';
import { BindingPanel } from './BindingPanel';
import { ConditionPanel } from './ConditionPanel';
import { ContentPanel } from './ContentPanel';
import { EventPanel } from './EventPanel';
import { PermissionPanel } from './PermissionPanel';
import { DEFAULT_DEBOUNCE_MS } from './SchemaForm';
import { StylePanel } from './StylePanel';

/**
 * 属性面板（T3-05）。
 *
 * 六个分区：内容 / 样式 / 数据绑定 / 事件 / 条件渲染 / 权限。
 *
 * 关键行为：
 * - 由组件 JSON Schema 自动生成表单（新增组件无需改面板）；
 * - 修改**即时生效并可撤销**：Ctrl+Z / Ctrl+Shift+Z；
 * - 文本类输入 200ms 防抖 + `coalesceKey` 合并，连续输入只占一步 undo；
 * - 多选时只展示**公共属性**，修改批量应用到全部选中元素（同样只占一步 undo）；
 * - 与画布、图层树共享同一 selection store（三向联动）。
 */

export const INSPECTOR_TABS = ['content', 'style', 'binding', 'event', 'condition', 'permission'] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

export const INSPECTOR_TAB_LABELS: Record<InspectorTab, string> = {
  content: '内容',
  style: '样式',
  binding: '数据',
  event: '事件',
  condition: '条件',
  permission: '权限',
};

export interface InspectorProps {
  /** 覆盖 store（测试注入用） */
  store?: StoreApi<EditorStore>;
  /** 防抖毫秒（测试传 0） */
  debounceMs?: number;
  /** 项目接口清单（补全数据源目录） */
  apiCatalog?: readonly ApiDef[];
  /** 内嵌动作流编辑器高度 */
  flowHeight?: number;
}

/** 取多个元素的公共字段取值（仅保留「键相同且值相同」的字段） */
export function commonValues(
  elements: readonly ElementNode[],
  pick: (element: ElementNode) => Record<string, unknown>,
): Record<string, unknown> {
  if (elements.length === 0) return {};
  const first = pick(elements[0] as ElementNode);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(first)) {
    const serialized = JSON.stringify(value);
    const same = elements.every((element) => JSON.stringify(pick(element)[key]) === serialized);
    if (same) out[key] = value;
  }
  return out;
}

export function Inspector({ store: storeProp, debounceMs = DEFAULT_DEBOUNCE_MS, apiCatalog = [], flowHeight = 380 }: InspectorProps): React.ReactElement {
  const contextStore = useDesignerStore();
  const store = storeProp ?? contextStore;
  const dsl = useEditorState((state) => state.dsl);
  const selectedIds = useEditorState((state) => state.selectedIds);
  const undoState = useEditorState((state) => state.undoState);
  const [tab, setTab] = React.useState<InspectorTab>('content');

  // Ctrl+Z / Ctrl+Shift+Z（输入框聚焦时同样生效，撤销刚输入的内容）
  useHotkeys(
    [
      { combo: 'Ctrl+Z', handler: () => store.getState().undo(), allowInInput: true },
      { combo: 'Ctrl+Shift+Z', handler: () => store.getState().redo(), allowInInput: true },
    ],
    [store],
  );

  const elements = React.useMemo(
    () => selectedIds.map((id) => findById(dsl.tree, id)).filter((node): node is ElementNode => node !== null),
    [dsl.tree, selectedIds],
  );

  const catalog = React.useMemo(() => getDataSources(dsl, apiCatalog), [dsl, apiCatalog]);
  const suggestions = React.useMemo(() => listDataSourcePaths(catalog).map((ref) => ref.path), [catalog]);

  const isMulti = elements.length > 1;
  const single = elements.length === 1 ? (elements[0] as ElementNode) : null;
  /** 多选且类型一致时，仍按该类型的属性 Schema 生成表单（否则退化为 JSON 编辑） */
  const multiType = React.useMemo(() => {
    if (!isMulti) return null;
    const first = elements[0]?.type;
    return first !== undefined && elements.every((element) => element.type === first) ? first : null;
  }, [isMulti, elements]);
  const commonProps = React.useMemo(() => commonValues(elements, (element) => element.props ?? {}), [elements]);
  const commonStyle = React.useMemo(() => commonValues(elements, (element) => element.style ?? {}), [elements]);

  /** 批量写入 props（一次 apply = 一步 undo） */
  const patchProps = React.useCallback(
    (key: string, value: unknown, options?: { coalesceKey?: string }): void => {
      const ids = store.getState().selectedIds;
      store.getState().apply(
        '修改属性',
        (draft) => {
          for (const id of ids) {
            draftUpdateNode(draft.tree, id, (node) => {
              node.props = { ...(node.props ?? {}), [key]: value };
            });
          }
        },
        options ?? {},
      );
    },
    [store],
  );

  const replaceProps = React.useCallback(
    (props: Record<string, unknown>): void => {
      const ids = store.getState().selectedIds;
      store.getState().apply('修改属性', (draft) => {
        for (const id of ids) {
          draftUpdateNode(draft.tree, id, (node) => {
            node.props = props;
          });
        }
      });
    },
    [store],
  );

  const patchStyle = React.useCallback(
    (key: string, value: unknown, options?: { coalesceKey?: string }): void => {
      const ids = store.getState().selectedIds;
      store.getState().apply(
        '修改样式',
        (draft) => {
          for (const id of ids) {
            draftUpdateNode(draft.tree, id, (node) => {
              node.style = { ...(node.style ?? {}), [key]: value };
            });
          }
        },
        options ?? {},
      );
    },
    [store],
  );

  const patchMetaShared = React.useCallback(
    (patch: Partial<Pick<ElementNode, 'condition' | 'permission'>>, label: string): void => {
      const ids = store.getState().selectedIds;
      store.getState().apply(label, (draft) => {
        for (const id of ids) {
          draftUpdateNode(draft.tree, id, (node) => {
            if (patch.condition !== undefined) node.condition = patch.condition;
            if (patch.permission !== undefined) node.permission = patch.permission;
          });
        }
      });
    },
    [store],
  );

  const createEvent = React.useCallback(
    (trigger: string): void => {
      const current = store.getState().dsl;
      const elementId = store.getState().selectedIds[0] ?? null;
      const id = `ev-${current.events.length + 1}-${trigger}`;
      store.getState().setPageEvents([...current.events, { id, trigger, elementId, entry: null, actions: [] }]);
    },
    [store],
  );

  if (elements.length === 0) {
    return (
      <div className="ec-inspector ec-inspector--empty" data-testid="inspector">
        <EmptyState title="未选中元素" description="在画布或图层树中选中元素后，这里显示它的属性。" />
      </div>
    );
  }

  return (
    <div className="ec-inspector" data-testid="inspector" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong data-testid="inspector-title">
          {isMulti ? `已选 ${elements.length} 个元素` : (single?.name ?? single?.type ?? '元素')}
        </strong>
        {!isMulti && single !== null && <Badge>{single.type}</Badge>}
        <span style={{ flex: 1 }} />
        <Tooltip content={undoState.undoLabel !== null ? `撤销：${undoState.undoLabel}` : '没有可撤销的操作'}>
          <Button
            size="sm"
            variant="ghost"
            aria-label="撤销"
            disabled={!undoState.canUndo}
            onClick={() => store.getState().undo()}
          >
            撤销
          </Button>
        </Tooltip>
        <Tooltip content={undoState.redoLabel !== null ? `重做：${undoState.redoLabel}` : '没有可重做的操作'}>
          <Button
            size="sm"
            variant="ghost"
            aria-label="重做"
            disabled={!undoState.canRedo}
            onClick={() => store.getState().redo()}
          >
            重做
          </Button>
        </Tooltip>
      </header>

      <Tabs items={INSPECTOR_TABS.map((id) => ({ key: id, label: INSPECTOR_TAB_LABELS[id] }))} value={tab} onChange={(next) => setTab(next as InspectorTab)}>
        {() => (
          <div data-testid={`inspector-panel-${tab}`} style={{ paddingTop: 8 }}>
            {tab === 'content' && (
              <ContentPanel
                element={single ?? ({ id: '__multi__', type: multiType ?? 'Multi', props: commonProps } as ElementNode)}
                debounceMs={debounceMs}
                onPropChange={(key, value, options) => patchProps(key, value, options)}
                onPropsReplace={replaceProps}
                {...(isMulti ? { onlyKeys: Object.keys(commonProps) } : {})}
              />
            )}

            {tab === 'style' && (
              <StylePanel
                element={single ?? ({ id: '__multi__', type: multiType ?? 'Multi', style: commonStyle } as ElementNode)}
                debounceMs={debounceMs}
                onStyleChange={(key, value, options) => patchStyle(key, value, options)}
                {...(isMulti ? { onlyKeys: Object.keys(commonStyle) } : {})}
              />
            )}

            {tab === 'binding' && (
              <BindingPanel
                element={single ?? (elements[0] as ElementNode)}
                catalog={catalog}
                onBind={(property, path) => {
                  const ids = store.getState().selectedIds;
                  store.getState().apply('修改数据绑定', (draft) => {
                    for (const id of ids) {
                      draftUpdateNode(draft.tree, id, (node) => {
                        node.bindings = { ...(node.bindings ?? {}), [property]: path };
                      });
                    }
                  });
                }}
                onUnbind={(property) => {
                  const ids = store.getState().selectedIds;
                  store.getState().apply('修改数据绑定', (draft) => {
                    for (const id of ids) {
                      draftUpdateNode(draft.tree, id, (node) => {
                        const next = { ...(node.bindings ?? {}) };
                        delete next[property];
                        if (Object.keys(next).length === 0) delete node.bindings;
                        else node.bindings = next;
                      });
                    }
                  });
                }}
              />
            )}

            {tab === 'event' && (
              <EventPanel
                elementId={(single ?? (elements[0] as ElementNode)).id}
                events={dsl.events}
                onCreateEvent={createEvent}
                height={flowHeight}
              />
            )}

            {tab === 'condition' && (
              <ConditionPanel
                value={single?.condition ?? null}
                onChange={(next) => patchMetaShared({ condition: next }, '修改条件渲染')}
                suggestions={suggestions}
              />
            )}

            {tab === 'permission' && (
              <PermissionPanel
                value={single?.permission ?? null}
                onChange={(next) => patchMetaShared({ permission: next }, '修改权限规则')}
                suggestions={suggestions}
              />
            )}
          </div>
        )}
      </Tabs>
    </div>
  );
}
