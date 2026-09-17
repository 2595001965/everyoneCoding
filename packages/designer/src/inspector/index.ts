/**
 * 属性面板（T3-05）公共 API。
 * 主会话据此接线 `packages/designer/src/index.ts`。
 */
export {
  Inspector,
  INSPECTOR_TABS,
  INSPECTOR_TAB_LABELS,
  commonValues,
  type InspectorProps,
  type InspectorTab,
} from './Inspector';

export { SchemaForm, PropFieldControl, DEFAULT_DEBOUNCE_MS, type SchemaFormProps, type PropFieldControlProps } from './SchemaForm';

export { StylePanel, STYLE_SCHEMA, type StylePanelProps } from './StylePanel';

export { ContentPanel, FALLBACK_PROPS_SCHEMA, type ContentPanelProps } from './ContentPanel';

export { BindingPanel, DEFAULT_BINDABLE_PROPS, catalogForElement, type BindingPanelProps } from './BindingPanel';

export { EventPanel, TRIGGER_OPTIONS, triggerLabel, type EventPanelProps } from './EventPanel';

export { ConditionPanel, ConditionEditor, COMPARISON_OPS, type ConditionPanelProps, type ConditionEditorProps } from './ConditionPanel';

export { PermissionPanel, PERMISSION_MODES, PERMISSION_MODE_LABELS, type PermissionPanelProps } from './PermissionPanel';
