/**
 * @ec/data —— 数据层 schema
 *
 * 每张表对应：TS interface（行形状）+ zod schema（运行时校验）。
 * 字段与 `migrations/0001_init.sql` 的 DDL 一一对应。
 * `TABLE_COLUMNS` 为主数据源，供 `schema.test.ts` 校验各表字段完备性。
 */
import { z } from 'zod';

/* ----------------------------- 枚举 ----------------------------- */

const userRole = z.enum(['owner', 'admin', 'member']);
const projectStatus = z.enum(['active', 'archived']);
const featureStatus = z.enum(['planned', 'in_progress', 'done']);
const noteKind = z.enum(['design', 'note', 'comment']);
const documentKind = z.enum(['requirement', 'tech', 'design', 'api', 'imported']);
const docFormat = z.enum(['markdown', 'docx', 'pdf', 'txt', 'image']);
/** 项目来源（T9-01 四类新建来源） */
const projectSourceKind = z.enum(['blank', 'template', 'git_import', 'doc_import']);
/** 文档版本创建者：用户编辑 / 流水线产物 / 导入 */
const docVersionCreator = z.enum(['user', 'pipeline', 'import']);
const memoryScope = z.enum(['longterm', 'project', 'feature', 'page', 'issue']);
const sourceType = z.enum(['manual', 'auto_chat', 'auto_design', 'doc_import', 'ai_summary']);
const memoryStatus = z.enum(['active', 'archived', 'superseded']);
const anchorKind = z.enum(['controller', 'service', 'dto', 'repo', 'sql', 'test', 'route']);
const pipelineStage = z.enum(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
const runStatus = z.enum(['pending', 'running', 'awaiting_confirm', 'confirmed', 'stale']);
const artifactType = z.enum(['requirement_doc', 'design_dsl', 'tech_doc', 'code_patch']);
const entityType = z.enum(['element', 'page', 'feature']);
const syncState = z.enum(['synced', 'drift_detected', 'conflict']);
const occurrenceKind = z.enum(['code', 'doc', 'memory', 'logic']);
const riskLevel = z.enum(['auto', 'confirm', 'warn']);
const occurrenceStatus = z.enum(['active', 'stale']);
const renameScope = z.enum(['project', 'cross_project']);
const packageDirection = z.enum(['export', 'import']);
const packageStatus = z.enum(['running', 'success', 'partial', 'failed']);
const providerProtocol = z.enum(['openai', 'anthropic']);
const linkType = z.enum(['supports', 'derived_from', 'related']);
const secureKind = z.enum(['api_key', 'token', 'secret']);
/** 记忆变更日志动作（FR-MEM-12） */
const memoryChangeAction = z.enum([
  'auto_write',
  'manual_create',
  'manual_edit',
  'undo',
  'conflict_resolve',
  'status_change',
  'layer_move',
  'import',
  'delete',
]);
const blobOrNull = z.instanceof(Uint8Array).nullable();

/* ----------------------------- user ----------------------------- */

export interface UserRow {
  id: string;
  login: string;
  display_name: string;
  avatar_ref: string | null;
  role: z.infer<typeof userRole>;
  settings_json: string | null;
  created_at: number;
  updated_at: number;
}
export const userSchema = z.object({
  id: z.string(),
  login: z.string(),
  display_name: z.string(),
  avatar_ref: z.string().nullable(),
  role: userRole,
  settings_json: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* --------------------------- workspace -------------------------- */

export interface WorkspaceRow {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  config_json: string | null;
  created_at: number;
  updated_at: number;
}
export const workspaceSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  kind: z.string(),
  config_json: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* --------------------------- project ---------------------------- */

export interface ProjectRow {
  id: string;
  user_id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  tech_stack_json: string | null;
  status: z.infer<typeof projectStatus>;
  /** 目标端（七端多选），JSON 数组文本，如 '["web","android"]' */
  target_platforms: string;
  /** 技术栈指纹（各端方案 + 前后端 + 数据库），JSON 文本 */
  tech_stack_fingerprint: string | null;
  /** 关联 Git 远程地址 */
  git_remote: string | null;
  /** 收藏置顶（1 = 置顶） */
  pinned: 0 | 1;
  /** 最近打开时间（毫秒时间戳，未打开过为 null） */
  last_opened_at: number | null;
  /** 回收站：删除时间（保留 30 天，null = 未删除） */
  deleted_at: number | null;
  /** 来源：空白 / 模板 / Git 导入 / 文档导入 */
  source_kind: z.infer<typeof projectSourceKind>;
  /** 来源引用（模板 id / Git URL / 文档 id） */
  source_ref: string | null;
  created_at: number;
  updated_at: number;
}
export const projectSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  workspace_id: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  tech_stack_json: z.string().nullable(),
  status: projectStatus,
  target_platforms: z.string(),
  tech_stack_fingerprint: z.string().nullable(),
  git_remote: z.string().nullable(),
  pinned: z.union([z.literal(0), z.literal(1)]),
  last_opened_at: z.number().int().nullable(),
  deleted_at: z.number().int().nullable(),
  source_kind: projectSourceKind,
  source_ref: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* --------------------------- feature ---------------------------- */

export interface FeatureRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  status: z.infer<typeof featureStatus>;
  created_at: number;
  updated_at: number;
}
export const featureSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: featureStatus,
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* ----------------------------- page ----------------------------- */

export interface PageRow {
  id: string;
  project_id: string;
  feature_id: string | null;
  name: string;
  route: string | null;
  dsl_ref: string | null;
  created_at: number;
  updated_at: number;
}
export const pageSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  feature_id: z.string().nullable(),
  name: z.string(),
  route: z.string().nullable(),
  dsl_ref: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* ----------------------------- note ----------------------------- */

export interface NoteRow {
  id: string;
  project_id: string;
  page_id: string | null;
  title: string | null;
  content: string | null;
  kind: z.infer<typeof noteKind>;
  created_at: number;
  updated_at: number;
}
export const noteSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  page_id: z.string().nullable(),
  title: z.string().nullable(),
  content: z.string().nullable(),
  kind: noteKind,
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* --------------------------- element ---------------------------- */

export interface ElementRow {
  id: string;
  page_id: string;
  parent_id: string | null;
  type: string;
  name: string;
  props_json: string | null;
  style_json: string | null;
  feature_ref: string | null;
  note_id: string | null;
  order_index: number;
  anchor_json: string | null;
  created_at: number;
  updated_at: number;
}
export const elementSchema = z.object({
  id: z.string(),
  page_id: z.string(),
  parent_id: z.string().nullable(),
  type: z.string(),
  name: z.string(),
  props_json: z.string().nullable(),
  style_json: z.string().nullable(),
  feature_ref: z.string().nullable(),
  note_id: z.string().nullable(),
  order_index: z.number().int(),
  anchor_json: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* --------------------------- document --------------------------- */

export interface DocumentRow {
  id: string;
  project_id: string;
  kind: z.infer<typeof documentKind>;
  title: string;
  content_ref: string | null;
  version: number;
  /** 文档格式（FR-DOC-01：markdown / docx / pdf / txt / image） */
  format: z.infer<typeof docFormat>;
  /** 解析后的全文（导入时提取） */
  content_text: string | null;
  /** 标题层级结构 [{level,heading,anchor,text}]，JSON 文本 */
  sections_json: string | null;
  /** 导入来源路径 */
  source_ref: string | null;
  /** 回收站：删除时间（null = 未删除） */
  deleted_at: number | null;
  /** 已忽略的版本提示（忽略后不再提醒该版本，FR-DOC-05） */
  ignored_version: number | null;
  created_at: number;
  updated_at: number;
}
export const documentSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  kind: documentKind,
  title: z.string(),
  content_ref: z.string().nullable(),
  version: z.number().int(),
  format: docFormat,
  content_text: z.string().nullable(),
  sections_json: z.string().nullable(),
  source_ref: z.string().nullable(),
  deleted_at: z.number().int().nullable(),
  ignored_version: z.number().int().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* -------------------------- doc_version ------------------------- */

export interface DocVersionRow {
  id: string;
  document_id: string;
  version: number;
  title: string;
  content_text: string | null;
  sections_json: string | null;
  /** 创建者：用户编辑 / 流水线产物 / 导入 */
  created_by: z.infer<typeof docVersionCreator>;
  created_at: number;
}
export const docVersionSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  version: z.number().int(),
  title: z.string(),
  content_text: z.string().nullable(),
  sections_json: z.string().nullable(),
  created_by: docVersionCreator,
  created_at: z.number().int(),
});

/* -------------------------- memory_item ------------------------- */

export interface MemoryItemRow {
  id: string;
  user_id: string;
  scope: z.infer<typeof memoryScope>;
  project_id: string | null;
  feature_id: string | null;
  page_id: string | null;
  element_id: string | null;
  issue_id: string | null;
  title: string;
  content: string;
  structured: string | null;
  tags: string;
  source_type: z.infer<typeof sourceType>;
  source_ref: string | null;
  confidence: number;
  importance: number;
  status: z.infer<typeof memoryStatus>;
  pinned: number;
  version: number;
  created_at: number;
  updated_at: number;
  embedding: Uint8Array | null;
  issue_status: string | null;
}
export const memoryItemSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  scope: memoryScope,
  project_id: z.string().nullable(),
  feature_id: z.string().nullable(),
  page_id: z.string().nullable(),
  element_id: z.string().nullable(),
  issue_id: z.string().nullable(),
  title: z.string(),
  content: z.string(),
  structured: z.string().nullable(),
  tags: z.string(),
  source_type: sourceType,
  source_ref: z.string().nullable(),
  confidence: z.number(),
  importance: z.number().int(),
  status: memoryStatus,
  pinned: z.number().int(),
  version: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  embedding: blobOrNull,
  issue_status: z.string().nullable(),
});

/* ------------------------ memory_doc_link ----------------------- */

export interface MemoryDocLinkRow {
  id: string;
  memory_id: string;
  document_id: string;
  link_type: z.infer<typeof linkType>;
  created_at: number;
}
export const memoryDocLinkSchema = z.object({
  id: z.string(),
  memory_id: z.string(),
  document_id: z.string(),
  link_type: linkType,
  created_at: z.number().int(),
});

/* -------------------------- code_anchor ------------------------- */

export interface CodeAnchorRow {
  id: string;
  project_id: string;
  element_id: string | null;
  page_id: string | null;
  feature_id: string | null;
  file_path: string;
  symbol: string | null;
  start_line: number | null;
  end_line: number | null;
  kind: z.infer<typeof anchorKind>;
  commit_sha: string | null;
  created_at: number;
  updated_at: number;
}
export const codeAnchorSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  element_id: z.string().nullable(),
  page_id: z.string().nullable(),
  feature_id: z.string().nullable(),
  file_path: z.string(),
  symbol: z.string().nullable(),
  start_line: z.number().int().nullable(),
  end_line: z.number().int().nullable(),
  kind: anchorKind,
  commit_sha: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* -------------------------- pipeline_run ------------------------ */

export interface PipelineRunRow {
  id: string;
  project_id: string;
  stage: z.infer<typeof pipelineStage>;
  status: z.infer<typeof runStatus>;
  artifact_type: z.infer<typeof artifactType>;
  version: number;
  content_ref: string | null;
  diff_ref: string | null;
  created_at: number;
  updated_at: number;
}
export const pipelineRunSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  stage: pipelineStage,
  status: runStatus,
  artifact_type: artifactType,
  version: z.number().int(),
  content_ref: z.string().nullable(),
  diff_ref: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* ------------------------- stage_artifact ----------------------- */

export interface StageArtifactRow {
  id: string;
  run_id: string;
  project_id: string;
  stage: z.infer<typeof pipelineStage>;
  artifact_type: z.infer<typeof artifactType>;
  version: number;
  content_ref: string | null;
  diff_ref: string | null;
  created_at: number;
}
export const stageArtifactSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  project_id: z.string(),
  stage: pipelineStage,
  artifact_type: artifactType,
  version: z.number().int(),
  content_ref: z.string().nullable(),
  diff_ref: z.string().nullable(),
  created_at: z.number().int(),
});

/* --------------------------- provider --------------------------- */

export interface ProviderRow {
  id: string;
  user_id: string;
  name: string;
  protocol: z.infer<typeof providerProtocol>;
  base_url: string;
  api_key_ref: string | null;
  headers_json: string | null;
  default_timeout: number;
  supports_stream: number;
  supports_tools: number;
  supports_vision: number;
  /** 启用状态（T1-01）；0 = 停用，不参与调度 */
  enabled: number;
  /** 用途绑定与容灾的选择顺序（升序） */
  sort_order: number;
  /** 乐观锁版本号（T1-01 Repository.update 使用） */
  version: number;
  /** /models 不可用时的用户手填模型列表（JSON string[]） */
  manual_models_json: string | null;
  created_at: number;
  updated_at: number;
}
export const providerSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  protocol: providerProtocol,
  base_url: z.string(),
  api_key_ref: z.string().nullable(),
  headers_json: z.string().nullable(),
  default_timeout: z.number().int(),
  supports_stream: z.number().int(),
  supports_tools: z.number().int(),
  supports_vision: z.number().int(),
  enabled: z.number().int(),
  sort_order: z.number().int(),
  version: z.number().int(),
  manual_models_json: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* ----------------------------- model ---------------------------- */

export interface ModelRow {
  id: string;
  provider_id: string;
  name: string;
  /** 展示名；未设置时 UI 回落到 name */
  display_name: string | null;
  context_window: number | null;
  max_output: number | null;
  /** 能力矩阵（工具 / 视觉 / 单价 / 人工修正标记） */
  capabilities_json: string | null;
  /** 乐观锁版本号 */
  version: number;
  created_at: number;
  updated_at: number;
}
export const modelSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  name: z.string(),
  display_name: z.string().nullable(),
  context_window: z.number().int().nullable(),
  max_output: z.number().int().nullable(),
  capabilities_json: z.string().nullable(),
  version: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* -------------------------- usage_record ------------------------ */

export interface UsageRecordRow {
  id: string;
  user_id: string;
  provider_id: string | null;
  model_id: string | null;
  project_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number | null;
  /** 用途（requirement / interface / techdoc / code / memory-extract / commit-msg） */
  purpose: string | null;
  /** 端到端耗时（毫秒） */
  latency_ms: number | null;
  created_at: number;
}
export const usageRecordSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  provider_id: z.string().nullable(),
  model_id: z.string().nullable(),
  project_id: z.string().nullable(),
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  total_tokens: z.number().int(),
  cost: z.number().nullable(),
  purpose: z.string().nullable(),
  latency_ms: z.number().int().nullable(),
  created_at: z.number().int(),
});

/* ------------------------ ai_model_config ----------------------- */

export interface AiModelConfigRow {
  id: string;
  user_id: string;
  /** 六类用途 → modelId 的映射（JSON 对象） */
  purpose_bindings_json: string;
  /** "全部使用默认模型"开关 */
  use_default_for_all: number;
  /** 默认模型（开关打开或某用途未绑定时使用） */
  default_model_id: string | null;
  created_at: number;
  updated_at: number;
}
export const aiModelConfigSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  purpose_bindings_json: z.string(),
  use_default_for_all: z.number().int(),
  default_model_id: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* ---------------------- remote_config_source -------------------- */

export const remoteConfigStatus = z.enum([
  'idle',
  'success',
  'signature_failed',
  'unreachable',
  'invalid',
]);

export interface RemoteConfigSourceRow {
  id: string;
  user_id: string;
  name: string;
  url: string;
  /** Ed25519 公钥（PEM / base64）；为空则跳过签名校验 */
  public_key: string | null;
  enabled: number;
  update_interval_min: number;
  last_fetch_at: number | null;
  last_status: string | null;
  last_error: string | null;
  last_payload_json: string | null;
  applied_revision: string | null;
  /** 用户已确认过的版本号，用于"拒绝后不再弹窗" */
  acked_revision: string | null;
  created_at: number;
  updated_at: number;
}
export const remoteConfigSourceSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  url: z.string(),
  public_key: z.string().nullable(),
  enabled: z.number().int(),
  update_interval_min: z.number().int(),
  last_fetch_at: z.number().int().nullable(),
  last_status: z.string().nullable(),
  last_error: z.string().nullable(),
  last_payload_json: z.string().nullable(),
  applied_revision: z.string().nullable(),
  acked_revision: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* -------------------------- registry_entry ---------------------- */

export interface RegistryEntryRow {
  id: string;
  project_id: string;
  entity_type: z.infer<typeof entityType>;
  entity_id: string;
  canonical_name: string;
  projections_json: string | null;
  aliases_json: string | null;
  naming_rule_id: string | null;
  name_history_json: string | null;
  sync_state: z.infer<typeof syncState>;
  created_at: number;
  updated_at: number;
}
export const registryEntrySchema = z.object({
  id: z.string(),
  project_id: z.string(),
  entity_type: entityType,
  entity_id: z.string(),
  canonical_name: z.string(),
  projections_json: z.string().nullable(),
  aliases_json: z.string().nullable(),
  naming_rule_id: z.string().nullable(),
  name_history_json: z.string().nullable(),
  sync_state: syncState,
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* --------------------------- occurrence ------------------------- */

export interface OccurrenceRow {
  id: string;
  registry_id: string;
  kind: z.infer<typeof occurrenceKind>;
  ref_path: string;
  locator: string | null;
  matched_symbol: string | null;
  confidence: number;
  risk_level: z.infer<typeof riskLevel>;
  status: z.infer<typeof occurrenceStatus>;
  created_at: number;
  updated_at: number;
}
export const occurrenceSchema = z.object({
  id: z.string(),
  registry_id: z.string(),
  kind: occurrenceKind,
  ref_path: z.string(),
  locator: z.string().nullable(),
  matched_symbol: z.string().nullable(),
  confidence: z.number(),
  risk_level: riskLevel,
  status: occurrenceStatus,
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* -------------------------- rename_event ------------------------ */

export interface RenameEventRow {
  id: string;
  project_id: string;
  registry_id: string;
  old_name: string;
  new_name: string;
  changeset_json: string | null;
  scope: z.infer<typeof renameScope>;
  commit_sha: string | null;
  undone: number;
  created_at: number;
}
export const renameEventSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  registry_id: z.string(),
  old_name: z.string(),
  new_name: z.string(),
  changeset_json: z.string().nullable(),
  scope: renameScope,
  commit_sha: z.string().nullable(),
  undone: z.number().int(),
  created_at: z.number().int(),
});

/* -------------------------- package_job ------------------------- */

export interface PackageJobRow {
  id: string;
  direction: z.infer<typeof packageDirection>;
  scope: string | null;
  includes_json: string | null;
  excludes_json: string | null;
  file_path: string | null;
  format_version: string | null;
  encryption: string | null;
  redacted: number;
  status: z.infer<typeof packageStatus>;
  counts_json: string | null;
  error_log_ref: string | null;
  created_at: number;
  updated_at: number;
}
export const packageJobSchema = z.object({
  id: z.string(),
  direction: packageDirection,
  scope: z.string().nullable(),
  includes_json: z.string().nullable(),
  excludes_json: z.string().nullable(),
  file_path: z.string().nullable(),
  format_version: z.string().nullable(),
  encryption: z.string().nullable(),
  redacted: z.number().int(),
  status: packageStatus,
  counts_json: z.string().nullable(),
  error_log_ref: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* ---------------------------- setting --------------------------- */

export interface SettingRow {
  id: string;
  user_id: string;
  key: string;
  value_json: string | null;
  value_text: string | null;
  created_at: number;
  updated_at: number;
}
export const settingSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  key: z.string(),
  value_json: z.string().nullable(),
  value_text: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* --------------------------- secure_ref ------------------------- */

export interface SecureRefRow {
  id: string;
  user_id: string;
  kind: z.infer<typeof secureKind>;
  ref_path: string;
  digest: string | null;
  created_at: number;
  updated_at: number;
}
export const secureRefSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: secureKind,
  ref_path: z.string(),
  digest: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/* ----------------------- memory_change_log ---------------------- */

export interface MemoryChangeLogRow {
  id: string;
  user_id: string;
  memory_id: string;
  action: z.infer<typeof memoryChangeAction>;
  policy: string | null;
  source_type: string | null;
  source_conversation_id: string | null;
  source_snippet: string | null;
  before_json: string | null;
  after_json: string | null;
  detail_json: string | null;
  created_at: number;
}
export const memoryChangeLogSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  memory_id: z.string(),
  action: memoryChangeAction,
  policy: z.string().nullable(),
  source_type: z.string().nullable(),
  source_conversation_id: z.string().nullable(),
  source_snippet: z.string().nullable(),
  before_json: z.string().nullable(),
  after_json: z.string().nullable(),
  detail_json: z.string().nullable(),
  created_at: z.number().int(),
});

/* --------------------- memory_struct_revision ------------------- */

export interface MemoryStructRevisionRow {
  id: string;
  memory_id: string;
  page_id: string;
  revision: number;
  token_estimate: number;
  truncated: number;
  summary_json: string;
  diff_json: string | null;
  created_at: number;
}
export const memoryStructRevisionSchema = z.object({
  id: z.string(),
  memory_id: z.string(),
  page_id: z.string(),
  revision: z.number().int(),
  token_estimate: z.number().int(),
  truncated: z.number().int(),
  summary_json: z.string(),
  diff_json: z.string().nullable(),
  created_at: z.number().int(),
});

/* ---------------------- TABLE_COLUMNS / SCHEMAS ----------------- */

export const TABLE_COLUMNS = {
  user: [
    'id',
    'login',
    'display_name',
    'avatar_ref',
    'role',
    'settings_json',
    'created_at',
    'updated_at',
  ],
  workspace: ['id', 'user_id', 'name', 'kind', 'config_json', 'created_at', 'updated_at'],
  project: [
    'id',
    'user_id',
    'workspace_id',
    'name',
    'description',
    'tech_stack_json',
    'status',
    'target_platforms',
    'tech_stack_fingerprint',
    'git_remote',
    'pinned',
    'last_opened_at',
    'deleted_at',
    'source_kind',
    'source_ref',
    'created_at',
    'updated_at',
  ],
  feature: ['id', 'project_id', 'name', 'description', 'status', 'created_at', 'updated_at'],
  page: ['id', 'project_id', 'feature_id', 'name', 'route', 'dsl_ref', 'created_at', 'updated_at'],
  note: ['id', 'project_id', 'page_id', 'title', 'content', 'kind', 'created_at', 'updated_at'],
  element: [
    'id',
    'page_id',
    'parent_id',
    'type',
    'name',
    'props_json',
    'style_json',
    'feature_ref',
    'note_id',
    'order_index',
    'anchor_json',
    'created_at',
    'updated_at',
  ],
  document: [
    'id',
    'project_id',
    'kind',
    'title',
    'content_ref',
    'version',
    'format',
    'content_text',
    'sections_json',
    'source_ref',
    'deleted_at',
    'ignored_version',
    'created_at',
    'updated_at',
  ],
  doc_version: [
    'id',
    'document_id',
    'version',
    'title',
    'content_text',
    'sections_json',
    'created_by',
    'created_at',
  ],
  memory_item: [
    'id',
    'user_id',
    'scope',
    'project_id',
    'feature_id',
    'page_id',
    'element_id',
    'issue_id',
    'title',
    'content',
    'structured',
    'tags',
    'source_type',
    'source_ref',
    'confidence',
    'importance',
    'status',
    'pinned',
    'version',
    'created_at',
    'updated_at',
    'embedding',
    'issue_status',
  ],
  memory_doc_link: ['id', 'memory_id', 'document_id', 'link_type', 'created_at'],
  code_anchor: [
    'id',
    'project_id',
    'element_id',
    'page_id',
    'feature_id',
    'file_path',
    'symbol',
    'start_line',
    'end_line',
    'kind',
    'commit_sha',
    'created_at',
    'updated_at',
  ],
  pipeline_run: [
    'id',
    'project_id',
    'stage',
    'status',
    'artifact_type',
    'version',
    'content_ref',
    'diff_ref',
    'created_at',
    'updated_at',
  ],
  stage_artifact: [
    'id',
    'run_id',
    'project_id',
    'stage',
    'artifact_type',
    'version',
    'content_ref',
    'diff_ref',
    'created_at',
  ],
  provider: [
    'id',
    'user_id',
    'name',
    'protocol',
    'base_url',
    'api_key_ref',
    'headers_json',
    'default_timeout',
    'supports_stream',
    'supports_tools',
    'supports_vision',
    'enabled',
    'sort_order',
    'version',
    'manual_models_json',
    'created_at',
    'updated_at',
  ],
  model: [
    'id',
    'provider_id',
    'name',
    'display_name',
    'context_window',
    'max_output',
    'capabilities_json',
    'version',
    'created_at',
    'updated_at',
  ],
  usage_record: [
    'id',
    'user_id',
    'provider_id',
    'model_id',
    'project_id',
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'cost',
    'purpose',
    'latency_ms',
    'created_at',
  ],
  ai_model_config: [
    'id',
    'user_id',
    'purpose_bindings_json',
    'use_default_for_all',
    'default_model_id',
    'created_at',
    'updated_at',
  ],
  remote_config_source: [
    'id',
    'user_id',
    'name',
    'url',
    'public_key',
    'enabled',
    'update_interval_min',
    'last_fetch_at',
    'last_status',
    'last_error',
    'last_payload_json',
    'applied_revision',
    'acked_revision',
    'created_at',
    'updated_at',
  ],
  registry_entry: [
    'id',
    'project_id',
    'entity_type',
    'entity_id',
    'canonical_name',
    'projections_json',
    'aliases_json',
    'naming_rule_id',
    'name_history_json',
    'sync_state',
    'created_at',
    'updated_at',
  ],
  occurrence: [
    'id',
    'registry_id',
    'kind',
    'ref_path',
    'locator',
    'matched_symbol',
    'confidence',
    'risk_level',
    'status',
    'created_at',
    'updated_at',
  ],
  rename_event: [
    'id',
    'project_id',
    'registry_id',
    'old_name',
    'new_name',
    'changeset_json',
    'scope',
    'commit_sha',
    'undone',
    'created_at',
  ],
  package_job: [
    'id',
    'direction',
    'scope',
    'includes_json',
    'excludes_json',
    'file_path',
    'format_version',
    'encryption',
    'redacted',
    'status',
    'counts_json',
    'error_log_ref',
    'created_at',
    'updated_at',
  ],
  setting: ['id', 'user_id', 'key', 'value_json', 'value_text', 'created_at', 'updated_at'],
  secure_ref: ['id', 'user_id', 'kind', 'ref_path', 'digest', 'created_at', 'updated_at'],
  memory_change_log: [
    'id',
    'user_id',
    'memory_id',
    'action',
    'policy',
    'source_type',
    'source_conversation_id',
    'source_snippet',
    'before_json',
    'after_json',
    'detail_json',
    'created_at',
  ],
  memory_struct_revision: [
    'id',
    'memory_id',
    'page_id',
    'revision',
    'token_estimate',
    'truncated',
    'summary_json',
    'diff_json',
    'created_at',
  ],
} as const;

export const TABLE_SCHEMAS = {
  user: userSchema,
  workspace: workspaceSchema,
  project: projectSchema,
  feature: featureSchema,
  page: pageSchema,
  note: noteSchema,
  element: elementSchema,
  document: documentSchema,
  doc_version: docVersionSchema,
  memory_item: memoryItemSchema,
  memory_doc_link: memoryDocLinkSchema,
  code_anchor: codeAnchorSchema,
  pipeline_run: pipelineRunSchema,
  stage_artifact: stageArtifactSchema,
  provider: providerSchema,
  model: modelSchema,
  usage_record: usageRecordSchema,
  ai_model_config: aiModelConfigSchema,
  remote_config_source: remoteConfigSourceSchema,
  registry_entry: registryEntrySchema,
  occurrence: occurrenceSchema,
  rename_event: renameEventSchema,
  package_job: packageJobSchema,
  setting: settingSchema,
  secure_ref: secureRefSchema,
  memory_change_log: memoryChangeLogSchema,
  memory_struct_revision: memoryStructRevisionSchema,
} as const;

export type TableName = keyof typeof TABLE_COLUMNS;
