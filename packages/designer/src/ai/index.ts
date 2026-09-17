/**
 * AI 生成界面（T3-11）公共 API。
 */
export { GeneratePanel, type GeneratePanelProps } from './GeneratePanel';

export {
  countElements,
  createFallbackDsl,
  dslFromAi,
  dslFromAiText,
  extractJson,
  normalizeCandidate,
  type AiDslIssue,
  type AiDslIssueKind,
  type AiDslResult,
  type DslFromAiContext,
} from './dsl-from-ai';

export {
  MAX_SKETCH_BYTES,
  SUPPORTED_SKETCH_TYPES,
  createSketchFromDataUrl,
  createSketchFromPath,
  dataUrlByteLength,
  describeSketch,
  isVisionSupported,
  readSketchFile,
  validateSketchFile,
  type SketchFileLike,
  type SketchPayload,
  type SketchPayloadKind,
  type SketchValidation,
} from './sketch-import';
