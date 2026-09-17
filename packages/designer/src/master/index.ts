/**
 * 母版与实例同步（T3-11）公共 API。
 */
export { MasterPanel, type MasterPanelProps } from './MasterPanel';

export {
  MasterRegistry,
  collectMasterInstances,
  detachInstance,
  instantiateMaster,
  masterUsage,
  reattachInstance,
  syncInstances,
  type MasterDefinition,
  type MasterInstanceRef,
  type SyncResult,
} from './master-sync';
