/**
 * 导出流水线契约类型（T8-02）。
 *
 * 本文件是**冻结接口**：T8-02 实现与 T8-04（增量/备份）都依赖这里的签名，
 * 字段名与结构不得改动（需要扩展只能加可选字段）。
 *
 * 数据访问一律经 `ExportSourcePort` 注入——package-kit 不直接依赖
 * `@ec/data` / `@ec/memory` 的存储层（外壳装配时由 Node 侧适配器实现端口）。
 */

/** 导出范围种类（对齐 manifest.scope） */
export type ExportScopeKind = 'all' | 'project' | 'selected';

/** 记忆层级勾选（FR-PKG-02：自定义勾选记忆层级） */
export interface MemoryLayerSelection {
  longterm: boolean;
  project: boolean;
  feature: boolean;
  page: boolean;
  issue: boolean;
}

/** 内容勾选（FR-PKG-02：记忆层级、文档、代码、流水线产物、锚点、附件） */
export interface ContentSelection {
  memory: MemoryLayerSelection;
  documents: boolean;
  code: boolean;
  pipeline: boolean;
  anchors: boolean;
  registry: boolean;
  attachments: boolean;
}

export const FULL_CONTENT_SELECTION: ContentSelection = {
  memory: { longterm: true, project: true, feature: true, page: true, issue: true },
  documents: true,
  code: true,
  pipeline: true,
  anchors: true,
  registry: true,
  attachments: true,
};

/**
 * 导出选择：范围 + 内容勾选 + 项目/文档限定。
 * 可保存为命名"导出方案"（ExportPlanPreset）供复用（FR-PKG-02 验收）。
 */
export interface ExportSelection {
  scope: ExportScopeKind;
  /** scope = project 时限定单项目；scope = selected 时为勾选的项目集合 */
  projectIds: string[];
  content: ContentSelection;
}

/** 可复用的命名导出方案 */
export interface ExportPlanPreset {
  name: string;
  selection: ExportSelection;
  /** 默认排除规则是否启用 */
  useDefaultExcludes: boolean;
  /** 是否脱敏（默认 true；显式关闭需二次确认——由 UI 层保证） */
  redact: boolean;
  savedAt: number;
}

/* ------------------------------ 排除规则 ------------------------------ */

/** 单条排除规则（gitignore 风格的 pattern） */
export interface ExcludeRule {
  pattern: string;
  /** 是否来自默认规则（统计区分） */
  builtin: boolean;
}

/** 排除统计（FR-PKG-06 验收：体积下降 ≥60% 的实测依据） */
export interface ExcludeStats {
  /** 被排除的文件数 */
  excludedFiles: number;
  /** 被排除的字节数 */
  excludedBytes: number;
  /** 参与统计的文件总数（排除前） */
  totalFiles: number;
  /** 排除前总字节数 */
  totalBytes: number;
  /** 体积下降率 0–1（= excludedBytes / totalBytes） */
  reductionRatio: number;
  /** 每条默认规则的命中统计（报告展示） */
  hitsByPattern: Array<{ pattern: string; files: number; bytes: number }>;
}

/* ------------------------------ 脱敏 ------------------------------ */

/** 脱敏命中（自检与导出报告用） */
export interface RedactionFinding {
  /** 包内路径 */
  path: string;
  /** 命中的规则 id（复用 @ec/core 的规则 id） */
  ruleId: string;
  /** 行号（1 起；二进制文件为 null） */
  line: number | null;
  /** 打码后的预览（不含明文） */
  preview: string;
}

/* ------------------------------ 进度 ------------------------------ */

export type ExportStage =
  'enumerating' | 'excluding' | 'redacting' | 'writing' | 'encrypting' | 'done' | 'failed';

/** 导出进度快照（进度条 / 计数 / 错误清单，UI 轮询或订阅） */
export interface ExportProgressSnapshot {
  stage: ExportStage;
  /** 已处理条目数 */
  processed: number;
  /** 总条目数（enumerating 完成后有效；-1 表示尚在统计） */
  total: number;
  /** 当前处理的包内路径 */
  currentFile: string | null;
  /** 各类对象计数 */
  counts: {
    projects: number;
    memoryItems: number;
    documents: number;
    pages: number;
    codeFiles: number;
    attachments: number;
  };
  /** 失败条目（可重试） */
  failures: ExportFailure[];
  /** 排除统计（excluding 阶段后有效） */
  excludeStats: ExcludeStats | null;
  /** 脱敏命中（redacting 阶段后有效；redact 关闭时为 null） */
  redactionFindings: RedactionFinding[];
  /** 已用毫秒 */
  elapsedMs: number;
}

export interface ExportFailure {
  path: string;
  reason: string;
}

/* ------------------------------ 数据源端口 ------------------------------ */

/** 项目元信息（meta.json 内容由外壳提供） */
export interface ExportProjectMeta {
  id: string;
  name: string;
  metaJson: string;
}

/** 一份待导出的记忆条目（MemoryItem 的结构镜像，避免运行时依赖 @ec/memory） */
export interface ExportMemoryItem {
  id: string;
  layer: 'longterm' | 'project' | 'feature' | 'page' | 'issue';
  projectId: string | null;
  updatedAt: number;
  /** JSONL 行内容（外壳序列化好的 MemoryItem JSON） */
  json: string;
}

/** 文档元信息 */
export interface ExportDocumentMeta {
  id: string;
  name: string;
  projectId: string | null;
  updatedAt: number;
}

/**
 * 导出数据源端口（外壳装配；测试用内存假实现）。
 *
 * 约定：所有方法同步返回可用清单，文件内容由调用方再取（流式，避免一次性入内存）。
 */
export interface ExportSourcePort {
  listProjects(): ExportProjectMeta[];
  /** 记忆条目（按勾选层级过滤；仅返回 scope 命中的项目） */
  listMemory(projectIds: string[] | null, layers: MemoryLayerSelection): ExportMemoryItem[];
  /** 记忆 ↔ 文档关联（memory/projects/<id>/links.json 内容） */
  listMemoryLinks(projectIds: string[] | null): Array<{ projectId: string; linksJson: string }>;
  listDocuments(projectIds: string[] | null): ExportDocumentMeta[];
  /** 读取文档原始文件（返回完整内容；文档一般不大） */
  readDocument(docId: string, fileName: string): { content: Buffer } | null;
  /** 列出项目代码文件（相对项目代码根的路径） */
  listCodeFiles(projectId: string): string[];
  /** 读取项目代码文件 */
  readCodeFile(projectId: string, relativePath: string): Buffer | null;
  /** 锚点映射表（anchors.json 内容） */
  readAnchors(projectId: string): string | null;
  /** 流水线产物清单（包内相对路径如 pipeline/S1/需求文档.v1.json） */
  listPipelineFiles(projectId: string): string[];
  readPipelineFile(projectId: string, relativePath: string): Buffer | null;
  /** 注册表（registry.json 内容） */
  readRegistry(projectId: string): string | null;
  /** 设计器产物：页面 DSL 与组件 */
  listDesignPages(projectId: string): string[];
  readDesignPage(projectId: string, fileName: string): string | null;
  listDesignComponents(projectId: string): string[];
  readDesignComponent(projectId: string, fileName: string): string | null;
  /** 附件（内容寻址：<sha256>.<ext>），返回流式读取的磁盘路径 */
  listAttachments(): Array<{ hashName: string; sourcePath: string }>;
  /** 项目级 .ecignore 内容（无则 null） */
  readEcignore(projectId: string): string | null;
}

/* ------------------------------ 导出结果 ------------------------------ */

export interface ExportJobResult {
  outputPath: string;
  /** 归档文件字节数 */
  archiveSizeBytes: number;
  /** 排除前工程字节总量（估算口径：命中条目 + 被排除条目） */
  rawSizeBytes: number;
  durationMs: number;
  counts: ExportProgressSnapshot['counts'];
  excludeStats: ExcludeStats;
  /** 是否执行了脱敏 */
  redacted: boolean;
  /** 脱敏命中清单（含被剔除/占位的密钥位置） */
  redactionFindings: RedactionFinding[];
  /** 导出后包内密钥自检结果（FR-PKG-07：全文检索零命中） */
  selfCheckFindings: RedactionFinding[];
  /** 是否加密 */
  encrypted: boolean;
  warnings: string[];
}

/** 导出请求（T8-02 的 ExportJob 输入） */
export interface ExportJobRequest {
  outputPath: string;
  selection: ExportSelection;
  /** 默认 true */
  useDefaultExcludes?: boolean | undefined;
  /** 项目级 .ecignore 之外的额外排除规则 */
  extraExcludes?: readonly string[] | undefined;
  /** 默认 true；显式 false 需 UI 二次确认（硬约束：脱敏默认开启） */
  redact?: boolean | undefined;
  /** 提供则加密导出 */
  password?: string | undefined;
  /** 提供则对 manifest 签名（可选 Ed25519） */
  signWithPrivateKeyPem?: string | undefined;
  /** 增量导出游标（T8-04）：只导出 updatedAt > updatedSince 的对象；缺省 = 全量 */
  updatedSince?: number | undefined;
  /** 进度回调 */
  onProgress?: ((snapshot: ExportProgressSnapshot) => void) | undefined;
}
