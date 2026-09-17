/**
 * 导航特性（T6-07）统一出口。
 */
export {
  NavApiProvider,
  useNavApi,
  useNavApiOptional,
  readInjectedNavApi,
  useHoverJump,
  NAV_API_GLOBAL_KEY,
  type NavApi,
  type NavJumpRequest,
  type DataFlowStep,
  type JumpStats,
  type HoverJumpState,
} from './nav-api';

export { JumpOverlay } from './JumpOverlay';
export { RelationGraphView } from './RelationGraphView';
export { DataFlowOverlay } from './DataFlowOverlay';
export { NavWorkspace } from './NavWorkspace';
