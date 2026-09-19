/**
 * 文档特性测试夹具：**真实 DocService + 内存端口**（不碰 SQLite）。
 *
 * 分工说明：
 * - markdown / txt 走 core 的真实解析器（`createBrowserParserRegistry`），验证真实层级解析；
 * - docx / pdf「文件导入」在真实装配中由外壳读文件并解析，此处假实现按路径生成 sections，
 *   模拟"外壳已完成解析后交给服务层"的契约（不伪造解析结果本身）。
 */

import {
  DocService,
  createBrowserParserRegistry,
  serializeSections,
  type ConvertDraft,
  type DocFormat,
  type DocMemoryLink as DocMemoryLinkModel,
  type DocMemoryNode,
  type DocLinkType,
  type DocMemoryScope,
  type DocParserRegistry,
  type DocSection,
  type DocSummary,
  type DocStore,
  type DocVersionRowSnapshot,
  type DocumentRowSnapshot,
  type DocUpdateStatus,
  type DocVersionSummary,
  type DocVersionAuthor,
  type ImportDocumentInput,
  type UpdateDocumentInput,
  type DocMemoryPort,
  type MemoryDocLinkRowSnapshot,
  type MemoryExtractionPort,
  newDocId,
  deserializeSections,
  sectionsToText,
  evaluateUpdateStatus,
  linkRowToSummary,
} from '@ec/core';

import type { DocsApi } from '../docs-api';

/** 内存文档存储 */
export class FakeDocStore implements DocStore {
  readonly docs = new Map<string, DocumentRowSnapshot>();
  readonly versions = new Map<string, DocVersionRowSnapshot[]>();

  loadAll(projectId: string): Promise<DocumentRowSnapshot[]> {
    return Promise.resolve(
      [...this.docs.values()]
        .filter((row) => row.project_id === projectId)
        .map((row) => ({ ...row })),
    );
  }

  loadById(id: string): Promise<DocumentRowSnapshot | null> {
    const row = this.docs.get(id);
    return Promise.resolve(row ? { ...row } : null);
  }

  insert(row: DocumentRowSnapshot): Promise<void> {
    this.docs.set(row.id, { ...row });
    return Promise.resolve();
  }

  update(id: string, patch: Partial<DocumentRowSnapshot>): Promise<void> {
    const current = this.docs.get(id);
    if (!current) throw new Error(`文档行不存在：${id}`);
    this.docs.set(id, { ...current, ...patch });
    return Promise.resolve();
  }

  deleteRow(id: string): Promise<void> {
    this.docs.delete(id);
    this.versions.delete(id);
    return Promise.resolve();
  }

  saveVersion(row: DocVersionRowSnapshot): Promise<void> {
    const list = this.versions.get(row.document_id) ?? [];
    list.push({ ...row });
    this.versions.set(row.document_id, list);
    return Promise.resolve();
  }

  loadVersions(documentId: string): Promise<DocVersionRowSnapshot[]> {
    return Promise.resolve((this.versions.get(documentId) ?? []).map((row) => ({ ...row })));
  }
}

/** 内存记忆端口（五类节点 + 关联） */
export class FakeDocMemoryPort implements DocMemoryPort {
  readonly nodes = new Map<string, DocMemoryNode>();
  readonly links = new Map<string, MemoryDocLinkRowSnapshot>();

  seedNode(node: DocMemoryNode): void {
    this.nodes.set(node.id, { ...node });
  }

  listMemoryNodes(projectId: string | null): Promise<DocMemoryNode[]> {
    void projectId;
    return Promise.resolve([...this.nodes.values()].map((node) => ({ ...node })));
  }

  createMemory(input: {
    projectId: string;
    scope: DocMemoryScope;
    title: string;
    content: string;
    sourceRef?: { docId: string; anchor?: string | null; page?: number | null } | null;
  }): Promise<DocMemoryNode> {
    const node: DocMemoryNode = { id: newDocId(), scope: input.scope, title: input.title };
    this.nodes.set(node.id, node);
    return Promise.resolve(node);
  }

  link(input: {
    memoryId: string;
    documentId: string;
    linkType: DocLinkType;
  }): Promise<DocMemoryLinkModel> {
    const row: MemoryDocLinkRowSnapshot = {
      id: newDocId(),
      memory_id: input.memoryId,
      document_id: input.documentId,
      link_type: input.linkType,
      created_at: Date.now(),
    };
    this.links.set(row.id, row);
    return Promise.resolve(linkRowToSummary(row));
  }

  listLinksByDoc(documentId: string): Promise<DocMemoryLinkModel[]> {
    return Promise.resolve(
      [...this.links.values()]
        .filter((row) => row.document_id === documentId)
        .map(linkRowToSummary),
    );
  }

  listLinksByMemory(memoryId: string): Promise<DocMemoryLinkModel[]> {
    return Promise.resolve(
      [...this.links.values()].filter((row) => row.memory_id === memoryId).map(linkRowToSummary),
    );
  }

  removeLink(id: string): Promise<void> {
    this.links.delete(id);
    return Promise.resolve();
  }
}

/** AI 摘要端口（可开关：关掉即验证"端口缺失如实报错"） */
export class FakeExtraction implements MemoryExtractionPort {
  calls: Array<{ title: string; text: string; scope: DocMemoryScope }> = [];

  summarize(input: {
    title: string;
    text: string;
    scope: DocMemoryScope;
    sourceRef?: { docId: string; anchor?: string | null; page?: number | null } | null;
  }): Promise<{ title: string; content: string }> {
    this.calls.push({ title: input.title, text: input.text, scope: input.scope });
    return Promise.resolve({
      title: `${input.title}：结构化摘要`,
      content: `摘要要点：${input.text.slice(0, 30)}…`,
    });
  }
}

export interface FakeDocsEnvironment {
  api: DocsApi;
  store: FakeDocStore;
  memory: FakeDocMemoryPort;
  extraction: FakeExtraction;
  service: DocService;
  /** 记录 importFromFile 调用（验证"文件导入走外壳"契约） */
  fileImports: Array<{ format: DocFormat; filePath: string }>;
}

/** 构造真实引擎 + 内存端口的文档端口 */
export function createFakeDocsApi(
  options: { withExtraction?: boolean; parsers?: DocParserRegistry } = {},
): FakeDocsEnvironment {
  const store = new FakeDocStore();
  const memory = new FakeDocMemoryPort();
  const extraction = new FakeExtraction();
  const fileImports: Array<{ format: DocFormat; filePath: string }> = [];
  const parsers = options.parsers ?? createBrowserParserRegistry();

  const withExtraction = options.withExtraction ?? true;
  const service = new DocService({
    store,
    parsers,
    memory,
    ...(withExtraction ? { extraction } : {}),
  });

  const api: DocsApi = {
    listDocuments: (projectId, opts) => service.listDocuments(projectId, opts ?? {}),
    getDocument: (id) => service.getDocument(id),
    importDocument: (input: ImportDocumentInput) => service.importDocument(input),
    importFromFile: async (input) => {
      fileImports.push({ format: input.format, filePath: input.filePath });
      if (input.filePath.includes('不存在') || input.filePath.includes('notfound')) {
        throw new Error(`文件不存在：${input.filePath}`);
      }
      // 模拟外壳解析结果（真实装配为 core 的 docx / pdf 解析器）
      const sections: DocSection[] =
        input.format === 'pdf'
          ? [
              {
                index: 0,
                level: 1,
                heading: 'PDF 第一章',
                anchor: 'sec-0',
                text: '第一章正文',
                page: 1,
              },
              {
                index: 1,
                level: 1,
                heading: 'PDF 第二章',
                anchor: 'sec-1',
                text: '第二章正文',
                page: 3,
              },
            ]
          : [
              { index: 0, level: 1, heading: 'Word 标题一', anchor: 'sec-0', text: '正文一' },
              { index: 1, level: 2, heading: 'Word 子标题', anchor: 'sec-1', text: '正文二' },
            ];
      const now = Date.now();
      const row: DocumentRowSnapshot = {
        id: newDocId(),
        project_id: input.projectId,
        kind: input.kind ?? 'imported',
        title: input.title ?? sections[0]!.heading,
        content_ref: null,
        format: input.format,
        content_text: sectionsToText(sections),
        sections_json: serializeSections(sections),
        source_ref: input.filePath,
        version: 1,
        ignored_version: null,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      };
      await store.insert(row);
      return {
        id: row.id,
        projectId: row.project_id,
        kind: 'imported',
        title: row.title,
        format: input.format,
        contentText: row.content_text ?? '',
        sections,
        sourceRef: row.source_ref,
        version: 1,
        ignoredVersion: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
    },
    updateDocument: (input: UpdateDocumentInput) => service.updateDocument(input),
    deleteDocument: (id) => service.deleteDocument(id),
    restoreDocument: (id) => service.restoreDocument(id),
    purgeDocument: (id) => service.purgeDocument(id),
    listVersions: (id): Promise<DocVersionSummary[]> => service.listVersions(id),
    ignoreVersion: (id, version) => service.ignoreVersion(id, version),
    evaluateUpdateStatus: (id): Promise<DocUpdateStatus> => service.evaluateDocUpdateStatus(id),
    listMemoryNodes: (projectId) => service.listMemoryNodes(projectId),
    listDocLinks: (documentId) => service.listDocLinks(documentId),
    listMemoryRefs: (memoryId) => service.listMemoryRefs(memoryId),
    linkToMemory: (input) => service.linkToMemory(input),
    removeLink: (id) => service.removeLink(id),
    countLinksForMemories: async (memoryIds) => {
      const result: Record<string, number> = {};
      for (const memoryId of memoryIds) {
        const links = await service.listMemoryRefs(memoryId);
        result[memoryId] = links.length;
      }
      return result;
    },
    previewConvertToMemory: (input) => service.previewConvertToMemory(input),
    commitConvertToMemory: (input) => service.commitConvertToMemory(input),
    supportedFormats: () => parsers.supported(),
  };

  return { api, store, memory, extraction, service, fileImports };
}

/** 断言辅助：把行快照直接塞进 store（构造"已存在文档"场景） */
export async function seedDocument(
  store: FakeDocStore,
  params: {
    projectId: string;
    title: string;
    markdown: string;
    format?: DocFormat;
    version?: number;
    ignoredVersion?: number | null;
    deletedAt?: number | null;
  },
): Promise<string> {
  const parsers = createBrowserParserRegistry();
  const parser = parsers.get(params.format ?? 'markdown');
  const parsed = (await parser!.parse({ raw: params.markdown })) as {
    title: string;
    sections: DocSection[];
  };
  const id = newDocId();
  const now = Date.now();
  await store.insert({
    id,
    project_id: params.projectId,
    kind: 'requirement',
    title: params.title || parsed.title,
    content_ref: null,
    format: params.format ?? 'markdown',
    content_text: sectionsToText(parsed.sections),
    sections_json: serializeSections(parsed.sections),
    source_ref: null,
    version: params.version ?? 1,
    ignored_version: params.ignoredVersion ?? null,
    deleted_at: params.deletedAt ?? null,
    created_at: now,
    updated_at: now,
  });
  return id;
}

export { deserializeSections, evaluateUpdateStatus };
export type { ConvertDraft, DocSummary, DocVersionAuthor };
