/**
 * 文档特性端口（T9-04 / FR-DOC-01 ~ 06）。
 *
 * 冻结契约：外壳（Wave 9/10 装配）把 `@ec/core` 的 `DocService` + SQLite 适配实现
 * 注入到 `globalThis.__EC_DOCS__`；渲染层只经本端口访问文档，**不 import
 * `@ec/data` / `@ec/memory`**（better-sqlite3 会打挂浏览器构建）。
 *
 * 未注入时组件展示装配引导而不是崩溃（与 features/memory、features/package 同一套做法）。
 */

import { createContext, useContext, type ReactNode } from 'react';

import type {
  ConvertDraft,
  DocFormat,
  DocMemoryLink,
  DocMemoryNode,
  DocLinkType,
  DocMemoryScope,
  DocSummary,
  DocUpdateStatus,
  DocVersionSummary,
  ImportDocumentInput,
  UpdateDocumentInput,
} from '@ec/core';

/** 文档端口：全部方法返回 Promise（外壳侧是异步 IO） */
export interface DocsApi {
  listDocuments(projectId: string, opts?: { includeDeleted?: boolean }): Promise<DocSummary[]>;
  getDocument(id: string): Promise<DocSummary | null>;
  importDocument(input: ImportDocumentInput): Promise<DocSummary>;
  /**
   * 从本地文件路径导入（docx / pdf / image）：渲染层无法读字节，
   * 由外壳读文件并经解析器注册表解析后入档。
   */
  importFromFile(input: {
    projectId: string;
    format: DocFormat;
    filePath: string;
    title?: string;
    kind?: DocSummary['kind'];
  }): Promise<DocSummary>;
  updateDocument(input: UpdateDocumentInput): Promise<DocSummary>;
  /** 删除 → 进回收站（二次确认由 UI 负责） */
  deleteDocument(id: string): Promise<void>;
  restoreDocument(id: string): Promise<void>;
  /** 彻底删除（物理删行，UI 需再次二次确认） */
  purgeDocument(id: string): Promise<void>;

  listVersions(id: string): Promise<DocVersionSummary[]>;
  /** 忽略"文档已更新"提示（针对指定版本，FR-DOC-05） */
  ignoreVersion(id: string, version: number): Promise<void>;
  evaluateUpdateStatus(id: string): Promise<DocUpdateStatus>;

  /** 可关联的记忆节点（五类 scope） */
  listMemoryNodes(projectId: string | null): Promise<DocMemoryNode[]>;
  listDocLinks(documentId: string): Promise<DocMemoryLink[]>;
  /** 反查：某记忆被哪些文档引用（双向跳转的反向入口） */
  listMemoryRefs(memoryId: string): Promise<DocMemoryLink[]>;
  linkToMemory(input: {
    memoryId: string;
    documentId: string;
    linkType: DocLinkType;
  }): Promise<DocMemoryLink>;
  removeLink(id: string): Promise<void>;
  /** 记忆卡片"📎 N 篇关联文档"：批量取关联数 */
  countLinksForMemories(memoryIds: string[]): Promise<Record<string, number>>;

  /** 一键转记忆：AI 摘要草稿（端口缺失时 crate 侧抛错，UI 展示引导） */
  previewConvertToMemory(input: {
    docId: string;
    scope: DocMemoryScope;
    anchor?: string;
  }): Promise<ConvertDraft>;
  commitConvertToMemory(input: {
    projectId: string;
    draft: ConvertDraft;
    scope?: DocMemoryScope;
  }): Promise<DocMemoryNode>;

  /** 当前环境可解析的格式（浏览器端仅 markdown/txt；docx/pdf 由外壳在 Node 侧解析） */
  supportedFormats(): DocFormat[];
}

const DocsContext = createContext<DocsApi | null>(null);

export interface DocsProviderProps {
  api: DocsApi | null;
  children: ReactNode;
}

export function DocsProvider({ api, children }: DocsProviderProps): JSX.Element {
  return <DocsContext.Provider value={api}>{children}</DocsContext.Provider>;
}

/** 允许为空的读取（未注入时组件自行展示引导） */
export function useDocsOptional(): DocsApi | null {
  return useContext(DocsContext);
}

/** 必须已注入的读取（调用方需自行保证在已装配分支内） */
export function useDocs(): DocsApi {
  const api = useContext(DocsContext);
  if (!api) {
    throw new Error('文档端口未注入：请先在外壳中装配 globalThis.__EC_DOCS__');
  }
  return api;
}

/** 装配引导（未注入端口时展示） */
export function DocsUnavailable(): JSX.Element {
  return (
    <div className="ec-docs">
      <p className="ec-docs__hint">
        文档中心尚未连接本地数据库。完成初始化后，这里可以导入 Markdown / Word / PDF / TXT
        文档并关联到记忆。
      </p>
    </div>
  );
}

/** 从全局读取端口（外壳装配点） */
export function readInjectedDocsApi(): DocsApi | null {
  const injected = (globalThis as { __EC_DOCS__?: DocsApi }).__EC_DOCS__;
  return injected ?? null;
}
