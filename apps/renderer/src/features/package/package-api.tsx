/**
 * 归档与迁移渲染层端口（Wave 8：T8-02 / T8-03 / T8-04）。
 *
 * 与 `RenameApi` / `PipelineApi` 同一套做法：渲染层只认这个 `PackageApi` 接口，
 * 真实实现由外壳经 `globalThis.__EC_PACKAGE__` 注入。渲染层**绝不**直接
 * `import '@ec/package-kit'`（ZIP/加密/healing 是 Node 侧能力）。
 *
 * 类型为本包镜像（避免渲染层运行时依赖 Node 包）；字段与 `@ec/package-kit`
 * 的 `export-types.ts` / `import-types.ts` 对齐，装配时结构天然兼容。
 *
 * 硬约束：
 * - 全程 UI 操作、无命令行（FR-PKG-12）：进度 / 计数 / 错误清单全部结构化回显；
 * - 冲突条目默认不覆盖、必须用户决策（E2E-14）：`decisions` 为空时导入必须拒绝；
 * - 破坏性操作（完整恢复覆盖同名项目、从快照回滚）由 UI 二次确认。
 */

import { createContext, useContext, type ReactNode } from 'react';

/** 端口注入键（外壳装配时写入） */
export const PACKAGE_API_GLOBAL_KEY = '__EC_PACKAGE__';

/* ------------------------------ 镜像类型（导出） ------------------------------ */

export type ExportScopeKind = 'all' | 'project' | 'selected';

export interface MemoryLayerSelection {
  longterm: boolean;
  project: boolean;
  feature: boolean;
  page: boolean;
  issue: boolean;
}

export interface ContentSelection {
  memory: MemoryLayerSelection;
  documents: boolean;
  code: boolean;
  pipeline: boolean;
  anchors: boolean;
  registry: boolean;
  attachments: boolean;
}

export interface ExportSelection {
  scope: ExportScopeKind;
  projectIds: string[];
  content: ContentSelection;
}

export interface ExportPlanPreset {
  name: string;
  selection: ExportSelection;
  useDefaultExcludes: boolean;
  redact: boolean;
  savedAt: number;
}

export interface ExcludeStats {
  excludedFiles: number;
  excludedBytes: number;
  totalFiles: number;
  totalBytes: number;
  reductionRatio: number;
  hitsByPattern: Array<{ pattern: string; files: number; bytes: number }>;
}

export interface RedactionFinding {
  path: string;
  ruleId: string;
  line: number | null;
  preview: string;
}

export type ExportStage = 'enumerating' | 'excluding' | 'redacting' | 'writing' | 'encrypting' | 'done' | 'failed';

export interface ExportFailure {
  path: string;
  reason: string;
}

export interface ExportProgressSnapshot {
  stage: ExportStage;
  processed: number;
  total: number;
  currentFile: string | null;
  counts: { projects: number; memoryItems: number; documents: number; pages: number; codeFiles: number; attachments: number };
  failures: ExportFailure[];
  excludeStats: ExcludeStats | null;
  redactionFindings: RedactionFinding[];
  elapsedMs: number;
}

export interface ExportJobResult {
  outputPath: string;
  archiveSizeBytes: number;
  rawSizeBytes: number;
  durationMs: number;
  counts: ExportProgressSnapshot['counts'];
  excludeStats: ExcludeStats;
  redacted: boolean;
  redactionFindings: RedactionFinding[];
  selfCheckFindings: RedactionFinding[];
  encrypted: boolean;
  warnings: string[];
}

export interface ExportJobRequest {
  outputPath: string;
  selection: ExportSelection;
  useDefaultExcludes?: boolean;
  extraExcludes?: string[];
  redact?: boolean;
  password?: string;
  onProgress?: ((snapshot: ExportProgressSnapshot) => void) | undefined;
}

/* ------------------------------ 镜像类型（导入） ------------------------------ */

export type ImportMode = 'full-restore' | 'merge' | 'memory-only' | 'documents-only' | 'code-only';

export type PackageObjectType = 'memory' | 'document' | 'design' | 'registry' | 'code' | 'anchor' | 'pipeline';

export type PackageDiffClassification = 'added' | 'conflicted' | 'unchanged' | 'missing';

export interface PackageDiffItem {
  incoming: {
    id: string;
    type: PackageObjectType;
    projectId: string | null;
    name: string;
    updatedAt: number;
  };
  local: { id: string; name: string; updatedAt: number } | null;
  classification: PackageDiffClassification;
}

export interface PackageDiffPreview {
  items: PackageDiffItem[];
  counts: Record<PackageDiffClassification, number>;
  missingLocals: Array<{ id: string; name: string; updatedAt: number }>;
}

export type ConflictResolution = 'keepLocal' | 'takeNew' | 'keepBoth';

export interface ConflictDecision {
  id: string;
  resolution: ConflictResolution;
}

export interface VerificationReport {
  ok: boolean;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
  failureCode: 'version' | 'integrity' | 'signature' | 'password' | 'structure' | null;
  failureMessage: string | null;
}

export interface ModePreview {
  mode: ImportMode;
  toApply: number;
  toOverwrite: number;
  toSkip: number;
  summary: string;
}

export interface ImportReportData {
  mode: ImportMode;
  counts: { added: number; conflicted: number; unchanged: number; missing: number };
  applied: {
    createdProjects: number;
    updatedProjects: number;
    createdObjects: number;
    updatedObjects: number;
    keptBothObjects: number;
    memoryCreated: number;
    memoryUpdated: number;
    memorySuperseded: number;
    filesWritten: number;
  };
  resolutions: { keepLocal: number; takeNew: number; keepBoth: number };
  failures: Array<{ path: string; reason: string }>;
  reportPath: string | null;
  durationMs: number;
}

export interface ImportJobRequest {
  packagePath: string;
  mode: ImportMode;
  password?: string;
  signaturePublicKeyPem?: string;
  decisions: ConflictDecision[];
  batchDecisions?: Partial<Record<PackageObjectType, ConflictResolution>>;
  onProgress?: ((stage: string, processed: number, total: number, currentFile: string | null) => void) | undefined;
}

/* ------------------------------ 镜像类型（T8-04） ------------------------------ */

export interface HealingAnchorOutcome {
  anchorId: string;
  symbol: string | null;
  oldFilePath: string;
  newFilePath: string | null;
  status: 'relocated' | 'unchanged' | 'ambiguous' | 'missing';
  reason: string;
  /** ambiguous 时的候选（供 UI 逐条采纳） */
  candidates?: Array<{ filePath: string; symbol: string; startLine: number; endLine: number }>;
}

export interface HealingLinkOutcome {
  linkId: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  status: 'ok' | 'fixed' | 'unresolvable';
  newTargetId?: string | null;
  detail: string;
}

export interface HealingAttachmentIssue {
  hashName: string;
  status: 'missing' | 'corrupted';
  detail: string;
}

export interface HealingReportData {
  anchors: { outcomes: HealingAnchorOutcome[]; total: number; successRate: number };
  links: { outcomes: HealingLinkOutcome[]; fixedCount: number; unresolvableCount: number };
  attachments: { issues: HealingAttachmentIssue[]; checked: number };
  suggestions: string[];
}

export type BackupFrequency = 'daily' | 'weekly';

export interface BackupSettingsData {
  enabled: boolean;
  frequency: BackupFrequency;
  /** 触发时间（HH:mm，本地时区） */
  timeOfDay: string;
  targetDir: string;
  keepCount: number;
}

export interface SnapshotInfo {
  fileName: string;
  path: string;
  createdAt: number;
  sizeBytes: number;
  scope: string;
}

/** 渲染层端口接口（外壳注入实现） */
export interface PackageApi {
  /* -------- 导出（T8-02） -------- */
  /** 打开系统文件对话框选导出路径（返回用户选择的绝对路径；取消为 null） */
  pickExportPath(defaultName: string): Promise<string | null>;
  exportPackage(request: ExportJobRequest): Promise<ExportJobResult>;
  listExportPresets(): Promise<ExportPlanPreset[]>;
  saveExportPreset(preset: ExportPlanPreset): Promise<void>;
  deleteExportPreset(name: string): Promise<void>;

  /* -------- 导入（T8-03） -------- */
  /** 打开系统文件对话框选 .ecpkg 文件（取消为 null） */
  pickPackagePath(): Promise<string | null>;
  /** 导入前校验（版本→完整性→签名→解密），全过才允许进差异预览 */
  verifyPackage(packagePath: string, password?: string, publicKeyPem?: string): Promise<VerificationReport>;
  /** 差异预览（四类统计；conflicted 条目默认不覆盖） */
  previewImport(packagePath: string, password?: string): Promise<PackageDiffPreview>;
  /** 模式影响预览 */
  previewMode(packagePath: string, mode: ImportMode, password?: string): Promise<ModePreview>;
  /** 执行导入（decisions 必须覆盖全部 conflicted 条目，否则实现方应拒绝） */
  importPackage(request: ImportJobRequest): Promise<ImportReportData>;

  /* -------- 自愈（T8-04） -------- */
  runHealing(projectId: string | null): Promise<HealingReportData>;
  /** 对 ambiguous 状态锚点采纳某个候选（返回是否成功） */
  adoptAnchorCandidate(anchorId: string, filePath: string, symbol: string): Promise<boolean>;

  /* -------- 定时备份（T8-04） -------- */
  getBackupSettings(): Promise<BackupSettingsData>;
  saveBackupSettings(settings: BackupSettingsData): Promise<void>;
  /** 立即创建一次备份快照 */
  createBackupNow(): Promise<SnapshotInfo>;
  listSnapshots(): Promise<SnapshotInfo[]>;
  /** 从快照回滚工作区（回滚前实现方自动备份当前状态；UI 二次确认后调用） */
  restoreFromSnapshot(path: string): Promise<ImportReportData>;
}

declare global {
  // eslint-disable-next-line no-var
  var __EC_PACKAGE__: PackageApi | undefined;
}

/** 读取外壳注入的端口；未注入返回 null（页面展示装配引导，而不是崩溃） */
export function readInjectedPackageApi(): PackageApi | null {
  return globalThis.__EC_PACKAGE__ ?? null;
}

const PackageApiContext = createContext<PackageApi | null>(null);

export function PackageApiProvider({ api, children }: { api: PackageApi | null; children: ReactNode }) {
  return <PackageApiContext.Provider value={api}>{children}</PackageApiContext.Provider>;
}

/** 组件内取端口；未注入时为 null，调用方渲染引导页 */
export function usePackageApi(): PackageApi | null {
  return useContext(PackageApiContext);
}
