/**
 * 文档域类型与端口（T9-04 / FR-DOC-01 ~ 06）。
 *
 * 约束（对齐 `project/project-types.ts` 与 Wave 7 注册表做法）：
 * - 本域为 core 的浏览器可达模块：禁止运行时依赖 `@ec/data` / `@ec/memory` / `@ec/designer`
 *   （better-sqlite3 / node:fs 会污染渲染层浏览器构建）。
 * - 存储经 `DocStore` 端口注入；行结构与 `@ec/data` 的 `document` / `doc_version` /
 *   `memory_doc_link` 对齐（手工镜像），外壳装配时适配到 SQLite Repository。
 * - 记忆节点与"转记忆"写入经 `DocMemoryPort` 注入；AI 摘要经 `MemoryExtractionPort` 注入。
 * - 五类记忆 scope 是 `@ec/memory` 的落库值镜像（longterm / project / feature / page / issue），
 *   不直接 import `@ec/memory`，避免把其运行时拉进浏览器包。
 * - `newUlid` 仅取自 `@ec/data` 的 browser 安全入口（ids 纯函数）。
 */

import { newUlid } from '@ec/data';

/* ------------------------------- 枚举镜像 ------------------------------- */

/** 文档格式（与迁移 `document.format` 一致） */
export const DOC_FORMATS = ['markdown', 'docx', 'pdf', 'txt', 'image'] as const;
export type DocFormat = (typeof DOC_FORMATS)[number];

export const DOC_FORMAT_LABELS: Record<DocFormat, string> = {
  markdown: 'Markdown',
  docx: 'Word 文档',
  pdf: 'PDF',
  txt: '纯文本',
  image: '图片（OCR）',
};

/** 文档来源 kind（0001 基表默认 requirement，Wave 9 扩展 imported） */
export const DOC_KINDS = ['requirement', 'design', 'imported'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** 五类记忆节点 scope（与 @ec/memory MEMORY_SCOPES 逐字面量对齐，防漂移） */
export const DOC_MEMORY_SCOPES = ['longterm', 'project', 'feature', 'page', 'issue'] as const;
export type DocMemoryScope = (typeof DOC_MEMORY_SCOPES)[number];

export const DOC_MEMORY_SCOPE_LABELS: Record<DocMemoryScope, string> = {
  longterm: '长期记忆',
  project: '项目记忆',
  feature: '功能记忆',
  page: '页面记忆',
  issue: '问题记忆',
};

/** 文档-记忆关联类型（与 memory_doc_link.link_type 一致） */
export const DOC_LINK_TYPES = ['related', 'supports', 'derived_from'] as const;
export type DocLinkType = (typeof DOC_LINK_TYPES)[number];

export const DOC_LINK_TYPE_LABELS: Record<DocLinkType, string> = {
  related: '相关',
  supports: '支撑',
  derived_from: '派生自',
};

/** 版本创建方（与 doc_version.created_by 一致） */
export type DocVersionAuthor = 'user' | 'pipeline' | 'import';

/* ------------------------------- 领域对象 ------------------------------- */

/** 单个标题层级（保留层级供大纲与跳转定位） */
export interface DocSection {
  /** 0-based 顺序（同一文档内唯一） */
  index: number;
  /** 标题层级：1~3 为识别出的标题，0 表示无标题正文块 */
  level: number;
  /** 标题文本（无标题 section 为空串） */
  heading: string;
  /** 跳转锚点：Markdown 用 slug；其它格式用 sec-<index> */
  anchor: string;
  /** 该 section 的正文（不含子级标题行） */
  text: string;
  /** PDF 页码（1-based）；其它格式不填 */
  page?: number | undefined;
}

/** 解析结果（解析器输出） */
export interface ParsedDocument {
  title: string;
  sections: DocSection[];
  /** PDF 逐页文本（供页码定位） */
  pages?: Array<{ index: number; text: string }> | undefined;
}

/** 原文链接（一键转记忆保留 docId + 段落锚点 / 页码） */
export interface DocSourceRef {
  docId: string;
  anchor?: string | null;
  page?: number | null;
}

/** 文档领域对象（解析后的行 + 展示辅助字段） */
export interface DocSummary {
  id: string;
  projectId: string;
  kind: DocKind;
  title: string;
  format: DocFormat;
  /** 提取正文（标题 + 正文拼接，供摘要与检索） */
  contentText: string;
  sections: DocSection[];
  sourceRef: string | null;
  version: number;
  /** 已忽略提示的版本号（FR-DOC-05） */
  ignoredVersion: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 版本摘要 */
export interface DocVersionSummary {
  id: string;
  documentId: string;
  version: number;
  title: string;
  sections: DocSection[];
  contentText: string | null;
  createdBy: DocVersionAuthor;
  createdAt: number;
}

/* ------------------------------- 行快照镜像 ------------------------------- */

/** document 表完整列（0001 基表 + 0005 扩展），snake_case 序列化文本 */
export const DOCUMENT_COLUMNS = [
  'id',
  'project_id',
  'kind',
  'title',
  'content_ref',
  'version',
  'created_at',
  'updated_at',
  'format',
  'content_text',
  'sections_json',
  'source_ref',
  'deleted_at',
  'ignored_version',
] as const;

export const DOC_VERSION_COLUMNS = [
  'id',
  'document_id',
  'version',
  'title',
  'content_text',
  'sections_json',
  'created_by',
  'created_at',
] as const;

export const MEMORY_DOC_LINK_COLUMNS = [
  'id',
  'memory_id',
  'document_id',
  'link_type',
  'created_at',
] as const;

export interface DocumentRowSnapshot {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  content_ref: string | null;
  format: string;
  content_text: string | null;
  sections_json: string | null;
  source_ref: string | null;
  version: number;
  ignored_version: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DocVersionRowSnapshot {
  id: string;
  document_id: string;
  version: number;
  title: string;
  content_text: string | null;
  sections_json: string | null;
  created_by: string;
  created_at: number;
}

export interface MemoryDocLinkRowSnapshot {
  id: string;
  memory_id: string;
  document_id: string;
  link_type: string;
  created_at: number;
}

/* ------------------------------- 端口 ------------------------------- */

/** 解析器：把原始字节/文本转为结构化文档 */
export interface DocParser {
  format: DocFormat;
  parse(input: {
    raw: string | Uint8Array;
    fileName?: string | undefined;
  }): ParsedDocument | Promise<ParsedDocument>;
}

/** 解析器注册表（外壳注入实现，或默认用 core 提供的工厂） */
export interface DocParserRegistry {
  get(format: DocFormat): DocParser | null;
  supported(): DocFormat[];
}

/** 存储端口：由外壳适配到 SQLite（行结构见上方镜像类型） */
export interface DocStore {
  /** 读取某项目全部文档行（含已进回收站的） */
  loadAll(projectId: string): Promise<DocumentRowSnapshot[]>;
  loadById(id: string): Promise<DocumentRowSnapshot | null>;
  insert(row: DocumentRowSnapshot): Promise<void>;
  update(id: string, patch: Partial<DocumentRowSnapshot>): Promise<void>;
  /** 物理删除单条文档行（彻底删除时调用） */
  deleteRow(id: string): Promise<void>;
  saveVersion(row: DocVersionRowSnapshot): Promise<void>;
  loadVersions(documentId: string): Promise<DocVersionRowSnapshot[]>;
}

/** 记忆节点（五类之一） */
export interface DocMemoryNode {
  id: string;
  scope: DocMemoryScope;
  title: string;
}

/** 文档-记忆关联 */
export interface DocMemoryLink {
  id: string;
  memoryId: string;
  documentId: string;
  linkType: DocLinkType;
  createdAt: number;
}

/** 记忆端口：关联、反查、转记忆时创建记忆节点 */
export interface DocMemoryPort {
  /** 列出可关联的记忆节点（供选择器；projectId 为 null 时取长期记忆等跨项目节点） */
  listMemoryNodes(projectId: string | null): Promise<DocMemoryNode[]>;
  /** 转记忆：创建一个记忆节点（content 已含原文链接；sourceRef 供记忆侧展示） */
  createMemory(input: {
    projectId: string;
    scope: DocMemoryScope;
    title: string;
    content: string;
    sourceRef?: DocSourceRef | null;
  }): Promise<DocMemoryNode>;
  /** 建立文档-记忆关联 */
  link(input: {
    memoryId: string;
    documentId: string;
    linkType: DocLinkType;
  }): Promise<DocMemoryLink>;
  listLinksByDoc(documentId: string): Promise<DocMemoryLink[]>;
  listLinksByMemory(memoryId: string): Promise<DocMemoryLink[]>;
  removeLink(id: string): Promise<void>;
}

/** OCR 端口：图片文档走 OCR，不可用时外壳可不注入 */
export interface OcrPort {
  recognize(input: {
    raw: Uint8Array;
    fileName?: string | undefined;
  }): Promise<{ title: string; sections: DocSection[] }>;
}

/** 记忆抽取（AI 摘要）：缺失时如实报错并给引导，不内置模板顶替 */
export interface MemoryExtractionPort {
  summarize(input: {
    title: string;
    text: string;
    scope: DocMemoryScope;
    sourceRef?: DocSourceRef | null;
  }): Promise<{ title: string; content: string }>;
}

/* ------------------------------- 错误 ------------------------------- */

export type DocDomainErrorCode =
  | 'not_found'
  | 'empty_content'
  | 'unsupported_format'
  | 'parser_missing'
  | 'ocr_unsupported'
  | 'extraction_unavailable';

export class DocDomainError extends Error {
  readonly code: DocDomainErrorCode;

  constructor(code: DocDomainErrorCode, message: string) {
    super(message);
    this.name = 'DocDomainError';
    this.code = code;
  }
}

/* ------------------------------- 序列化辅助 ------------------------------- */

/** sections <-> JSON（宽容解析：坏 JSON 退化为单 section，不让脏数据炸 UI） */
export function serializeSections(sections: DocSection[]): string {
  return JSON.stringify(sections);
}

export function deserializeSections(json: string | null): DocSection[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.map((raw, index): DocSection => {
        const obj = (raw ?? {}) as Record<string, unknown>;
        const heading = typeof obj.heading === 'string' ? obj.heading : '';
        const anchor = typeof obj.anchor === 'string' && obj.anchor ? obj.anchor : `sec-${index}`;
        return {
          index: typeof obj.index === 'number' ? obj.index : index,
          level: typeof obj.level === 'number' ? obj.level : 0,
          heading,
          anchor,
          text: typeof obj.text === 'string' ? obj.text : '',
          page: typeof obj.page === 'number' ? obj.page : undefined,
        };
      });
    }
  } catch {
    /* 忽略损坏数据，返回空 */
  }
  return [];
}

/** 由 sections 拼出提取正文（标题 + 正文），供摘要与检索 */
export function sectionsToText(sections: DocSection[]): string {
  return sections
    .map((section) =>
      (section.heading ? `${section.heading}\n${section.text}` : section.text).trimEnd(),
    )
    .join('\n\n')
    .trim();
}

/** 新 id 生成（默认 ULID） */
export function newDocId(now: number = Date.now(), random: () => number = Math.random): string {
  return newUlid(now, random);
}
