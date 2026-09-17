/**
 * 文档服务（T9-04 / FR-DOC-01 ~ 06）。
 *
 * 领域职责（纯逻辑，浏览器可达）：
 * - 文档 CRUD + 导入编排（解析 → 落库 → 首版本快照）
 * - 文档编辑 → 版本递增 + 新快照（FR-DOC-05）
 * - 关联记忆（建立/反查/移除）+ 双向跳转定位数据（FR-DOC-02 / 03）
 * - 一键转记忆：走 `MemoryExtractionPort` 调 AI 摘要，端口缺失如实报错；结果可编辑 + 保留原文链接（FR-DOC-04）
 * - 流水线产物自动入档（命名 `<项目>-需求文档-v<阶段版本>.md`）+ 自动关联对应记忆（FR-DOC-06）
 *
 * 全部经端口：`DocStore` / `DocParserRegistry` / `DocMemoryPort` / `MemoryExtractionPort`。
 * 存储行结构与 `@ec/data` 迁移对齐（见 `doc-types.ts` 镜像类型）。
 */

import {
  type DocFormat,
  DocDomainError,
  type DocKind,
  type DocLinkType,
  type DocMemoryLink,
  type DocMemoryNode,
  type DocMemoryScope,
  type DocParserRegistry,
  type DocSection,
  type DocSourceRef,
  type DocStore,
  type DocSummary,
  type DocVersionAuthor,
  type DocVersionRowSnapshot,
  type DocVersionSummary,
  type MemoryDocLinkRowSnapshot,
  deserializeSections,
  type DocumentRowSnapshot,
  type MemoryExtractionPort,
  type DocMemoryPort,
  newDocId,
  type ParsedDocument,
  serializeSections,
  sectionsToText,
} from './doc-types';
import { buildVersionSnapshot, evaluateUpdateStatus, nextVersion, type DocUpdateStatus } from './versioning';

/** 文档服务依赖 */
export interface DocServiceDeps {
  store: DocStore;
  parsers: DocParserRegistry;
  memory: DocMemoryPort;
  /** AI 摘要端口（一键转记忆）；缺失时转记忆操作如实报错并给引导 */
  extraction?: MemoryExtractionPort | undefined;
  clock?: () => number;
  newId?: () => string;
}

/** 一键转记忆的可编辑草稿（结果可编辑，保留原文链接） */
export interface ConvertDraft {
  docId: string;
  scope: DocMemoryScope;
  title: string;
  /** AI 生成的摘要正文（可编辑） */
  content: string;
  /** 原文链接：docId + 段落锚点 / 页码 */
  sourceRef: DocSourceRef;
}

/** 导入文档输入 */
export interface ImportDocumentInput {
  projectId: string;
  format: DocFormat;
  raw: string | Uint8Array;
  title?: string | undefined;
  kind?: DocKind | undefined;
  sourceRef?: string | null | undefined;
}

/** 编辑文档输入 */
export interface UpdateDocumentInput {
  id: string;
  raw?: string | Uint8Array | undefined;
  format?: DocFormat | undefined;
  title?: string | undefined;
  createdBy?: DocVersionAuthor | undefined;
}

/** 流水线产物入档输入 */
export interface ArchiveArtifactInput {
  projectId: string;
  projectName: string;
  stageVersion: string | number;
  content: string;
  /** 自动关联的记忆节点（如 S1 需求文档关联项目记忆） */
  memoryId?: string | undefined;
}

export class DocService {
  private readonly deps: Required<Pick<DocServiceDeps, 'store' | 'parsers' | 'memory' | 'clock' | 'newId'>> &
    Pick<DocServiceDeps, 'extraction'>;

  constructor(deps: DocServiceDeps) {
    this.deps = {
      store: deps.store,
      parsers: deps.parsers,
      memory: deps.memory,
      clock: deps.clock ?? Date.now,
      newId: deps.newId ?? newDocId,
      extraction: deps.extraction,
    };
  }

  /* ----------------------------- 行 ↔ 领域对象 ----------------------------- */

  private rowToSummary(row: DocumentRowSnapshot): DocSummary {
    return {
      id: row.id,
      projectId: row.project_id,
      kind: (['requirement', 'design', 'imported'] as const).includes(row.kind as DocKind)
        ? (row.kind as DocKind)
        : 'requirement',
      title: row.title,
      format: (row.format as DocFormat) ?? 'markdown',
      contentText: row.content_text ?? '',
      sections: deserializeSections(row.sections_json),
      sourceRef: row.source_ref,
      version: row.version,
      ignoredVersion: row.ignored_version,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private versionRowToSummary(row: DocVersionRowSnapshot): DocVersionSummary {
    return {
      id: row.id,
      documentId: row.document_id,
      version: row.version,
      title: row.title,
      sections: deserializeSections(row.sections_json),
      contentText: row.content_text,
      createdBy: (['user', 'pipeline', 'import'] as const).includes(row.created_by as DocVersionAuthor)
        ? (row.created_by as DocVersionAuthor)
        : 'user',
      createdAt: row.created_at,
    };
  }

  private async parseToRow(
    parsed: ParsedDocument,
    base: Omit<DocumentRowSnapshot, 'title' | 'content_text' | 'sections_json'>,
    storeTitle: string,
  ): Promise<{ row: DocumentRowSnapshot; sections: DocSection[] }> {
    const sections = parsed.sections;
    const contentText = sectionsToText(sections);
    const row: DocumentRowSnapshot = {
      ...base,
      title: storeTitle.trim() || parsed.title.trim() || '未命名文档',
      content_text: contentText,
      sections_json: serializeSections(sections),
    };
    return { row, sections };
  }

  /* ----------------------------- 导入 / 编辑 ----------------------------- */

  async importDocument(input: ImportDocumentInput): Promise<DocSummary> {
    const parser = this.deps.parsers.get(input.format);
    if (!parser) throw new DocDomainError('parser_missing', `不支持的文档格式解析器：${input.format}`);
    const parsed = await parser.parse({ raw: input.raw, fileName: undefined });
    if (!parsed.sections || parsed.sections.length === 0) {
      throw new DocDomainError('empty_content', '解析结果为空，无法导入');
    }
    const now = this.deps.clock();
    const id = this.deps.newId();
    const { row } = await this.parseToRow(
      parsed,
      {
        id,
        project_id: input.projectId,
        kind: input.kind ?? 'imported',
        content_ref: null,
        format: input.format,
        source_ref: input.sourceRef ?? null,
        version: 1,
        ignored_version: null,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
      input.title ?? parsed.title,
    );
    await this.deps.store.insert(row);
    await this.deps.store.saveVersion(
      buildVersionSnapshot({
        doc: row,
        sections: parsed.sections,
        contentText: row.content_text,
        createdBy: 'import',
        id: this.deps.newId(),
        createdAt: now,
      }),
    );
    return this.rowToSummary(row);
  }

  /** 编辑文档正文（重新解析 → 版本 +1 → 新快照） */
  async updateDocument(input: UpdateDocumentInput): Promise<DocSummary> {
    const row = await this.deps.store.loadById(input.id);
    if (!row) throw new DocDomainError('not_found', `文档不存在：${input.id}`);
    const format: DocFormat = input.format ?? (row.format as DocFormat);
    const parser = this.deps.parsers.get(format);
    if (!parser) throw new DocDomainError('parser_missing', `不支持的文档格式解析器：${format}`);

    const parsed = input.raw !== undefined ? await parser.parse({ raw: input.raw, fileName: undefined }) : null;
    const now = this.deps.clock();
    const next = nextVersion(row.version);
    const patch: Partial<DocumentRowSnapshot> = { version: next, updated_at: now };
    if (input.title !== undefined) patch.title = input.title.trim() || row.title;
    if (parsed) {
      const sections = parsed.sections;
      patch.content_text = sectionsToText(sections);
      patch.sections_json = serializeSections(sections);
      if (input.title === undefined) patch.title = parsed.title.trim() || row.title;
    }
    await this.deps.store.update(input.id, patch);
    const updated = await this.deps.store.loadById(input.id);
    if (!updated) throw new DocDomainError('not_found', `文档不存在：${input.id}`);
    await this.deps.store.saveVersion(
      buildVersionSnapshot({
        doc: updated,
        sections: parsed ? parsed.sections : deserializeSections(updated.sections_json),
        contentText: updated.content_text,
        createdBy: input.createdBy ?? 'user',
        id: this.deps.newId(),
        createdAt: now,
      }),
    );
    return this.rowToSummary(updated);
  }

  async getDocument(id: string): Promise<DocSummary | null> {
    const row = await this.deps.store.loadById(id);
    return row ? this.rowToSummary(row) : null;
  }

  /** 列出项目文档（默认不含回收站） */
  async listDocuments(projectId: string, opts: { includeDeleted?: boolean | undefined } = {}): Promise<DocSummary[]> {
    const rows = await this.deps.store.loadAll(projectId);
    return rows
      .filter((row) => (opts.includeDeleted ? true : row.deleted_at === null))
      .map((row) => this.rowToSummary(row))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 删除 → 进回收站（软删除） */
  async deleteDocument(id: string): Promise<void> {
    const row = await this.deps.store.loadById(id);
    if (!row) throw new DocDomainError('not_found', `文档不存在：${id}`);
    await this.deps.store.update(id, { deleted_at: this.deps.clock() });
  }

  /** 从回收站恢复 */
  async restoreDocument(id: string): Promise<void> {
    const row = await this.deps.store.loadById(id);
    if (!row) throw new DocDomainError('not_found', `文档不存在：${id}`);
    if (row.deleted_at === null) return;
    await this.deps.store.update(id, { deleted_at: null });
  }

  /** 彻底删除（物理删行） */
  async purgeDocument(id: string): Promise<void> {
    await this.deps.store.deleteRow(id);
  }

  /* ----------------------------- 版本 ----------------------------- */

  async listVersions(documentId: string): Promise<DocVersionSummary[]> {
    const rows = await this.deps.store.loadVersions(documentId);
    return rows
      .map((row) => this.versionRowToSummary(row))
      .sort((a, b) => b.version - a.version || b.createdAt - a.createdAt);
  }

  /** 忽略"文档已更新"提示（针对当前版本） */
  async ignoreVersion(id: string, version: number): Promise<void> {
    const row = await this.deps.store.loadById(id);
    if (!row) throw new DocDomainError('not_found', `文档不存在：${id}`);
    await this.deps.store.update(id, { ignored_version: version });
  }

  /** 计算相对关联记忆的"已更新"提示状态 */
  async evaluateDocUpdateStatus(id: string): Promise<DocUpdateStatus> {
    const row = await this.deps.store.loadById(id);
    if (!row) throw new DocDomainError('not_found', `文档不存在：${id}`);
    return evaluateUpdateStatus({ version: row.version, ignoredVersion: row.ignored_version });
  }

  /* ----------------------------- 关联记忆 ----------------------------- */

  async listMemoryNodes(projectId: string | null): Promise<DocMemoryNode[]> {
    return this.deps.memory.listMemoryNodes(projectId);
  }

  async linkToMemory(input: {
    memoryId: string;
    documentId: string;
    linkType: DocLinkType;
  }): Promise<DocMemoryLink> {
    const doc = await this.deps.store.loadById(input.documentId);
    if (!doc) throw new DocDomainError('not_found', `文档不存在：${input.documentId}`);
    return this.deps.memory.link(input);
  }

  async listDocLinks(documentId: string): Promise<DocMemoryLink[]> {
    return this.deps.memory.listLinksByDoc(documentId);
  }

  /** 反查：某记忆引用了哪些文档（双向跳转的反向入口） */
  async listMemoryRefs(memoryId: string): Promise<DocMemoryLink[]> {
    return this.deps.memory.listLinksByMemory(memoryId);
  }

  async removeLink(id: string): Promise<void> {
    await this.deps.memory.removeLink(id);
  }

  /* ----------------------------- 一键转记忆 ----------------------------- */

  /**
   * 预览转记忆草稿：调用 AI 摘要（走端口）。
   * 端口缺失时抛出 `extraction_unavailable`，并附引导文案——**不内置模板顶替**。
   */
  async previewConvertToMemory(input: {
    docId: string;
    scope: DocMemoryScope;
    anchor?: string | undefined;
  }): Promise<ConvertDraft> {
    if (!this.deps.extraction) {
      throw new DocDomainError(
        'extraction_unavailable',
        '当前未接入 AI 摘要端口（MemoryExtractionPort），无法自动生成结构化摘要。请在设置中配置 AI 中转，或手动编写摘要后保存。',
      );
    }
    const doc = await this.deps.store.loadById(input.docId);
    if (!doc) throw new DocDomainError('not_found', `文档不存在：${input.docId}`);
    const sections = deserializeSections(doc.sections_json);
    let text: string;
    let anchor: string | null = null;
    if (input.anchor) {
      const section = sections.find((s) => s.anchor === input.anchor);
      if (section) {
        text = section.heading ? `${section.heading}\n${section.text}` : section.text;
        anchor = section.anchor;
      } else {
        text = doc.content_text ?? '';
      }
    } else {
      text = doc.content_text ?? '';
    }
    if (!text.trim()) {
      throw new DocDomainError('empty_content', '所选文档/片段正文为空，无法生成摘要');
    }
    const result = await this.deps.extraction.summarize({
      title: doc.title,
      text,
      scope: input.scope,
      sourceRef: { docId: doc.id, anchor },
    });
    return {
      docId: doc.id,
      scope: input.scope,
      title: result.title,
      content: result.content,
      sourceRef: { docId: doc.id, anchor },
    };
  }

  /** 提交转记忆：创建记忆节点（保留原文链接）+ 建立 derived_from 关联 */
  async commitConvertToMemory(input: {
    projectId: string;
    draft: ConvertDraft;
    scope?: DocMemoryScope | undefined;
  }): Promise<DocMemoryNode> {
    const scope = input.scope ?? input.draft.scope;
    const ref = input.draft.sourceRef;
    const refLine = `\n\n> 原文链接：docId=${ref.docId}${ref.anchor ? `#${ref.anchor}` : ''}`;
    const node = await this.deps.memory.createMemory({
      projectId: input.projectId,
      scope,
      title: input.draft.title,
      content: `${input.draft.content}${refLine}`,
      sourceRef: ref,
    });
    await this.deps.memory.link({ memoryId: node.id, documentId: ref.docId, linkType: 'derived_from' });
    return node;
  }

  /* ----------------------------- 流水线产物入档 ----------------------------- */

  /** 流水线产物自动入档：命名 `<项目>-需求文档-v<阶段版本>.md`，并自动关联对应记忆 */
  async archivePipelineArtifact(input: ArchiveArtifactInput): Promise<DocSummary> {
    const parser = this.deps.parsers.get('markdown');
    if (!parser) throw new DocDomainError('parser_missing', '未配置 Markdown 解析器');
    const parsed = await parser.parse({ raw: input.content, fileName: undefined });
    const now = this.deps.clock();
    const id = this.deps.newId();
    const title = `${input.projectName}-需求文档-v${input.stageVersion}`;
    const { row } = await this.parseToRow(
      parsed,
      {
        id,
        project_id: input.projectId,
        kind: 'requirement',
        content_ref: null,
        format: 'markdown',
        source_ref: null,
        version: 1,
        ignored_version: null,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
      title,
    );
    await this.deps.store.insert(row);
    await this.deps.store.saveVersion(
      buildVersionSnapshot({
        doc: row,
        sections: parsed.sections,
        contentText: row.content_text,
        createdBy: 'pipeline',
        id: this.deps.newId(),
        createdAt: now,
      }),
    );
    if (input.memoryId) {
      await this.deps.memory.link({ memoryId: input.memoryId, documentId: id, linkType: 'derived_from' });
    }
    return this.rowToSummary(row);
  }
}

/** 复用：把链接行转为领域对象（供外壳/测试统一） */
export function linkRowToSummary(row: MemoryDocLinkRowSnapshot): DocMemoryLink {
  return {
    id: row.id,
    memoryId: row.memory_id,
    documentId: row.document_id,
    linkType: (['related', 'supports', 'derived_from'] as const).includes(row.link_type as DocLinkType)
      ? (row.link_type as DocLinkType)
      : 'related',
    createdAt: row.created_at,
  };
}
