/**
 * T3-08 页面状态与数据绑定 —— 公共 API。
 * 主会话据此接线 `packages/designer/src/index.ts`。
 */

export { StateStore } from './StateStore';
export type { StateListener, Unsubscribe } from './StateStore';

export { StateEditor, validateStateVar, STATE_TYPE_LABELS } from './StateEditor';
export type { StateEditorProps, StateVarDraft } from './StateEditor';

export { BindingPicker, expandStateShape, valueToField, listAllBindingPaths } from './BindingPicker';
export type { BindingPickerProps } from './BindingPicker';

export { StatePanel } from './StatePanel';
export type { StatePanelProps } from './StatePanel';
