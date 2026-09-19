import * as React from 'react';

import { Button, EmptyState, Select } from '@ec/ui';

import type { EventDef } from '../dsl/types';
import { FlowEditor } from '../flow/FlowEditor';

/**
 * 事件分区（T3-05 要点 2）。
 *
 * 列出与当前元素相关的事件（含页面级事件），并内嵌 T3-09 的**动作流编辑器**；
 * 动作流保存由 FlowEditor 直接写回 editor store（一次保存 = 一步 undo）。
 */

export const TRIGGER_OPTIONS = [
  { value: 'click', label: '点击' },
  { value: 'dblclick', label: '双击' },
  { value: 'change', label: '值变化' },
  { value: 'submit', label: '提交' },
  { value: 'mount', label: '挂载' },
] as const;

export function triggerLabel(trigger: string): string {
  return TRIGGER_OPTIONS.find((option) => option.value === trigger)?.label ?? trigger;
}

export interface EventPanelProps {
  /** 当前元素 id */
  elementId: string;
  /** 页面全部事件 */
  events: readonly EventDef[];
  /** 新建事件（触发器类型） */
  onCreateEvent: (trigger: string) => void;
  /** 编辑器高度 */
  height?: number;
}

export function EventPanel({
  elementId,
  events,
  onCreateEvent,
  height = 380,
}: EventPanelProps): React.ReactElement {
  const bound = React.useMemo(
    () =>
      events.filter(
        (event) =>
          event.elementId === elementId ||
          event.elementId === null ||
          event.elementId === undefined,
      ),
    [events, elementId],
  );
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const active = bound.find((event) => event.id === activeId) ?? bound[0] ?? null;

  if (bound.length === 0) {
    return (
      <div className="ec-event-panel" data-testid="event-panel">
        <EmptyState
          title="没有绑定事件"
          description="为该元素添加一个事件，再用可视化节点图编排动作流。"
          action={
            <Button variant="primary" onClick={() => onCreateEvent('click')}>
              添加点击事件
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div
      className="ec-event-panel"
      data-testid="event-panel"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Select
          aria-label="选择事件"
          size="sm"
          value={active?.id ?? ''}
          options={bound.map((event) => ({
            label: `${triggerLabel(event.trigger)}（${event.actions.length} 个动作）`,
            value: event.id,
          }))}
          onChange={(next) => setActiveId(next)}
        />
        <Button size="sm" variant="secondary" onClick={() => onCreateEvent('click')}>
          新增事件
        </Button>
      </header>
      {active !== null && <FlowEditor eventId={active.id} height={height} />}
    </div>
  );
}
