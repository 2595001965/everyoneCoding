/**
 * 多端一致性校验（T3-11）公共 API。
 */
export {
  ConsistencyPanel,
  CONSISTENCY_CODE_LABELS,
  type ConsistencyPanelProps,
} from './ConsistencyPanel';

export {
  checkConsistency,
  groupByFeature,
  skeletonSignature,
  structureSignature,
  workbenchHint,
  type ConsistencyInput,
  type ConsistencyIssue,
  type ConsistencyIssueCode,
  type ConsistencyReport,
} from './consistency-check';
