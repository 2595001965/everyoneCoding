/**
 * 动作流编辑器（T3-09）公共 API。
 * 主会话据此接线 `packages/designer/src/index.ts`。
 */
export { FlowEditor, type FlowEditorProps } from './FlowEditor';
export { NodePalette, type NodePaletteProps } from './NodePalette';
/** 节点视图组件：与 `dsl/types` 的 ActionNode（动作节点类型）区分，导出时改名为 ActionNodeView */
export { ActionNode as ActionNodeView, type ActionNodeViewProps } from './ActionNode';
export { EdgeLayer, NODE_HEIGHT, NODE_WIDTH, type EdgeLayerProps, type OutPort } from './EdgeLayer';

export {
  ACTION_LABELS,
  FLOW_NODE_SPECS,
  actionToNode,
  createEmptyFlow,
  createFlowNode,
  nodeToAction,
  parseFlow,
  serializeFlow,
  type CreateFlowNodeOptions,
  type FlowNode,
  type FlowNodeSpec,
} from './flow-schema';

export {
  detectCycles,
  findOrphanNodes,
  validateFlow,
  type FlowIssue,
  type FlowIssueCode,
  type FlowIssueSeverity,
  type ValidateFlowInput,
} from './flow-validator';

export {
  createFlowRuntime,
  type CreateFlowRuntimeOptions,
  type FlowNavigation,
  type FlowNotification,
  type FlowRunContext,
  type FlowRunResult,
  type FlowRuntime,
} from './flow-runtime';
