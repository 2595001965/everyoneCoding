/**
 * 页面状态面板（T3-08）。
 *
 * - 列出页面状态变量（name / type / initial / source / apiRef / 描述）；
 * - 支持增删改、排序、按 source 或类型分组；全部变更走 `setPageStateVars`（进撤销栈）；
 * - 删除前用 `findReferencingElements` 做引用检查：被引用时弹窗警告并列出引用元素
 *   （可点击跳转 = select 该元素），确认后才删除并清理绑定；
 * - 选中单个元素时，提供「数据绑定」区，复用 BindingPicker 写入元素 bindings。
 */

import * as React from 'react';
import { Badge, Button, EmptyState, IconButton, Modal, Select, Tag } from '@ec/ui';

import { findById } from '../dsl/traverse';
import type { PageStateVar, StateType } from '../dsl/types';
import { useDesignerStore, useEditorState } from '../store/designer-context';
import {
  findReferencingElements,
  getDataSources,
  type ApiDef,
  type DataSourceCatalog,
} from '../shared/data-source';
import { BindingPicker } from './BindingPicker';
import { STATE_TYPE_LABELS, StateEditor } from './StateEditor';

type GroupMode = 'none' | 'source' | 'type';

const GROUP_OPTIONS = [
  { label: '不分组', value: 'none' },
  { label: '按来源', value: 'source' },
  { label: '按类型', value: 'type' },
];

const DEFAULT_BINDABLE_PROPS = [
  'value',
  'text',
  'checked',
  'disabled',
  'visible',
  'src',
  'label',
  'href',
];

const SOURCE_COLOR = { local: 'neutral', api: 'info' } as const;

export interface StatePanelProps {
  /** 接口清单（接口来源的 apiRef 选项与数据源目录补全用） */
  apiCatalog?: readonly ApiDef[];
}

export function StatePanel(props: StatePanelProps): React.ReactElement {
  const { apiCatalog = [] } = props;
  const store = useDesignerStore();
  const dsl = useEditorState((s) => s.dsl);
  const selectedIds = useEditorState((s) => s.selectedIds);

  const [groupMode, setGroupMode] = React.useState<GroupMode>('none');
  const [editing, setEditing] = React.useState<PageStateVar | 'new' | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);

  const catalog: DataSourceCatalog = React.useMemo(
    () => getDataSources(dsl, apiCatalog),
    [dsl, apiCatalog],
  );
  const states = dsl.state;
  const apiRefOptions = catalog.apis.map((a) => a.path);

  const groups = React.useMemo(() => {
    if (groupMode === 'none')
      return [{ key: 'all', label: `全部状态（${states.length}）`, items: states }];
    const map = new Map<string, PageStateVar[]>();
    for (const item of states) {
      const key = groupMode === 'source' ? (item.source ?? 'local') : item.type;
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    const labelFor = (k: string): string =>
      groupMode === 'source'
        ? k === 'api'
          ? '接口来源'
          : '页面来源'
        : (STATE_TYPE_LABELS[k as StateType] ?? k);
    return Array.from(map.entries()).map(([key, items]) => ({
      key,
      label: `${labelFor(key)}（${items.length}）`,
      items,
    }));
  }, [states, groupMode]);

  const move = (index: number, dir: -1 | 1): void => {
    const target = index + dir;
    if (target < 0 || target >= states.length) return;
    const next = states.slice();
    const tmp = next[index]!;
    next[index] = next[target]!;
    next[target] = tmp;
    store.getState().setPageStateVars(next);
  };

  const commitEdit = (next: PageStateVar): void => {
    if (editing === 'new') {
      store.getState().setPageStateVars([...states, next]);
    } else if (editing !== null) {
      store.getState().setPageStateVars(states.map((s) => (s.name === editing.name ? next : s)));
    }
    setEditing(null);
  };

  const requestDelete = (name: string): void => {
    const refs = findReferencingElements(dsl, name);
    if (refs.length > 0) {
      setPendingDelete(name);
      return;
    }
    performDelete(name, []);
  };

  const performDelete = (name: string, refs: ReturnType<typeof findReferencingElements>): void => {
    store.getState().apply('删除状态变量', (draft) => {
      draft.state = draft.state.filter((s) => s.name !== name);
      for (const el of refs) {
        const node = findById(draft.tree, el.id);
        const bindings = node?.bindings;
        if (bindings) {
          const nextBindings = { ...bindings };
          for (const key of Object.keys(nextBindings)) {
            if (nextBindings[key] === name) delete nextBindings[key];
          }
          if (Object.keys(nextBindings).length === 0) delete node.bindings;
          else node.bindings = nextBindings;
        }
      }
    });
    setPendingDelete(null);
  };

  const selectedElement =
    selectedIds.length === 1 ? findById(dsl.tree, selectedIds[0] as string) : null;
  const bindableProps = selectedElement
    ? Array.from(
        new Set([...DEFAULT_BINDABLE_PROPS, ...Object.keys(selectedElement.bindings ?? {})]),
      )
    : [];

  const pendingRefs = pendingDelete ? findReferencingElements(dsl, pendingDelete) : [];

  return (
    <div
      className="ec-state-panel"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12 }}
    >
      <header
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <strong>页面状态</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <Select
            aria-label="分组方式"
            options={GROUP_OPTIONS}
            value={groupMode}
            onChange={(v) => setGroupMode(v as GroupMode)}
            size="sm"
          />
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            新增状态
          </Button>
        </div>
      </header>

      {states.length === 0 ? (
        <EmptyState title="还没有状态变量" description="点击「新增状态」添加页面级状态。" />
      ) : (
        groups.map((group) => (
          <section key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.6 }}>{group.label}</div>
            {group.items.map((item) => {
              const index = states.findIndex((s) => s.name === item.name);
              return (
                <div
                  key={item.name}
                  data-testid={`state-${item.name}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    border: '1px solid var(--ec-color-border, #e3e8ef)',
                    borderRadius: 6,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <code style={{ fontWeight: 600 }}>{item.name}</code>
                      <Tag color={SOURCE_COLOR[item.source ?? 'local']}>
                        {item.source ?? 'local'}
                      </Tag>
                      <Tag color="neutral">{STATE_TYPE_LABELS[item.type]}</Tag>
                      {item.apiRef && <Badge color="info">{item.apiRef}</Badge>}
                    </div>
                    {item.description && (
                      <div
                        style={{
                          fontSize: 12,
                          opacity: 0.6,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.description}
                      </div>
                    )}
                  </div>
                  <IconButton
                    aria-label={`上移 ${item.name}`}
                    size="sm"
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </IconButton>
                  <IconButton
                    aria-label={`下移 ${item.name}`}
                    size="sm"
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </IconButton>
                  <IconButton
                    aria-label={`编辑 ${item.name}`}
                    size="sm"
                    onClick={() => setEditing(item)}
                  >
                    ✎
                  </IconButton>
                  <IconButton
                    aria-label={`删除 ${item.name}`}
                    size="sm"
                    variant="danger"
                    onClick={() => requestDelete(item.name)}
                  >
                    ×
                  </IconButton>
                </div>
              );
            })}
          </section>
        ))
      )}

      {selectedElement && (
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            borderTop: '1px dashed var(--ec-color-border, #e3e8ef)',
            paddingTop: 8,
          }}
        >
          <strong style={{ fontSize: 13 }}>
            数据绑定 · {selectedElement.name ?? selectedElement.id}
          </strong>
          {bindableProps.map((prop) => (
            <BindingPicker
              key={prop}
              catalog={catalog}
              property={prop}
              value={selectedElement.bindings?.[prop]}
              onBind={(p, path) => store.getState().setBindings(selectedElement.id, { [p]: path })}
              onUnbind={(p) => store.getState().setBindings(selectedElement.id, { [p]: null })}
            />
          ))}
        </section>
      )}

      <Modal
        open={editing !== null}
        title={
          editing === 'new'
            ? '新增状态变量'
            : `编辑状态变量${editing && 'name' in editing ? `：${editing.name}` : ''}`
        }
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null && (
          <StateEditor
            value={editing === 'new' ? undefined : editing}
            existingNames={
              editing !== 'new' && editing !== null
                ? states.filter((item) => item.name !== editing.name).map((item) => item.name)
                : states.map((item) => item.name)
            }
            apiOptions={apiRefOptions}
            onChange={commitEdit}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>

      <Modal
        open={pendingDelete !== null}
        title="状态被引用，无法删除"
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              data-testid="confirm-delete"
              onClick={() => pendingDelete && performDelete(pendingDelete, pendingRefs)}
            >
              确认删除并清理绑定
            </Button>
          </>
        }
      >
        {pendingDelete && (
          <div
            data-testid="reference-warning"
            role="alert"
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <p>
              状态 <code>{pendingDelete}</code> 仍被以下元素引用，删除将一并清除这些绑定：
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {pendingRefs.map((el) => (
                <li key={el.id}>
                  <button
                    type="button"
                    data-testid={`ref-item-${el.id}`}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--ec-color-link, #1971c2)',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                    onClick={() => store.getState().select([el.id])}
                  >
                    {el.name ?? el.id}（{el.type}）
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
    </div>
  );
}
