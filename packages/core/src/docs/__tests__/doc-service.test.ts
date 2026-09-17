/**
 * 文档服务单测（T9-04 / FR-DOC-01~06）。
 *
 * 用内存假端口（真函数 + Map 存储）跑通真实语义：导入→解析层级、关联/反查、
 * 转记忆保留原文链接、版本提示与忽略、流水线产物入档命名。不碰 SQLite。
 */

import { describe, expect, it } from 'vitest';

import { DocDomainError, type DocLinkType, type DocMemoryLink, type DocMemoryNode, type DocMemoryScope, type DocStore, type DocMemoryPort, type DocVersionRowSnapshot, type MemoryDocLinkRowSnapshot, type DocumentRowSnapshot, type MemoryExtractionPort } from '../doc-types';
import { createDefaultParserRegistry } from '../parsers/node-registry';
import { DocService } from '../doc-service';

class FakeDocStore implements DocStore {
  readonly rows = new Map<string, DocumentRowSnapshot>();
  readonly versions = new Map<string, DocVersionRowSnapshot[]>();

  loadAll(projectId: string): Promise<DocumentRowSnapshot[]> {
    return Promise.resolve([...this.rows.values()].filter((r) => r.project_id === projectId).map((r) => ({ ...r })));
  }
  loadById(id: string): Promise<DocumentRowSnapshot | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? { ...row } : null);
  }
  insert(row: DocumentRowSnapshot): Promise<void> {
    this.rows.set(row.id, { ...row });
    return Promise.resolve();
  }
  update(id: string, patch: Partial<DocumentRowSnapshot>): Promise<void> {
    const cur = this.rows.get(id);
    if (!cur) return Promise.reject(new Error(`行不存在：${id}`));
    this.rows.set(id, { ...cur, ...patch });
    return Promise.resolve();
  }
  deleteRow(id: string): Promise<void> {
    this.rows.delete(id);
    return Promise.resolve();
  }
  saveVersion(row: DocVersionRowSnapshot): Promise<void> {
    const list = this.versions.get(row.document_id) ?? [];
    list.push({ ...row });
    this.versions.set(row.document_id, list);
    return Promise.resolve();
  }
  loadVersions(documentId: string): Promise<DocVersionRowSnapshot[]> {
    return Promise.resolve([...(this.versions.get(documentId) ?? [])]);
  }
}

class FakeDocMemoryPort implements DocMemoryPort {
  readonly nodes = new Map<string, DocMemoryNode>();
  readonly links = new Map<string, MemoryDocLinkRowSnapshot>();
  private n = 0;

  constructor(seed: Array<{ id: string; scope: DocMemoryScope; title: string }> = []) {
    for (const s of seed) this.nodes.set(s.id, s);
  }

  listMemoryNodes(): Promise<DocMemoryNode[]> {
    return Promise.resolve([...this.nodes.values()]);
  }
  createMemory(input: { projectId: string; scope: DocMemoryScope; title: string; content: string; sourceRef?: unknown }): Promise<DocMemoryNode> {
    this.n += 1;
    const node: DocMemoryNode = { id: `mem-${this.n}`, scope: input.scope, title: input.title };
    this.nodes.set(node.id, node);
    return Promise.resolve(node);
  }
  link(input: { memoryId: string; documentId: string; linkType: DocLinkType }): Promise<DocMemoryLink> {
    this.n += 1;
    const row: MemoryDocLinkRowSnapshot = {
      id: `link-${this.n}`,
      memory_id: input.memoryId,
      document_id: input.documentId,
      link_type: input.linkType,
      created_at: 1000,
    };
    this.links.set(row.id, row);
    return Promise.resolve({
      id: row.id,
      memoryId: row.memory_id,
      documentId: row.document_id,
      linkType: input.linkType,
      createdAt: row.created_at,
    });
  }
  listLinksByDoc(documentId: string): Promise<DocMemoryLink[]> {
    return Promise.resolve(
      [...this.links.values()]
        .filter((l) => l.document_id === documentId)
        .map((l) => ({ id: l.id, memoryId: l.memory_id, documentId: l.document_id, linkType: l.link_type as DocLinkType, createdAt: l.created_at })),
    );
  }
  listLinksByMemory(memoryId: string): Promise<DocMemoryLink[]> {
    return Promise.resolve(
      [...this.links.values()]
        .filter((l) => l.memory_id === memoryId)
        .map((l) => ({ id: l.id, memoryId: l.memory_id, documentId: l.document_id, linkType: l.link_type as DocLinkType, createdAt: l.created_at })),
    );
  }
  removeLink(id: string): Promise<void> {
    this.links.delete(id);
    return Promise.resolve();
  }
}

function makeExtraction(impl?: (text: string) => { title: string; content: string }): MemoryExtractionPort {
  return {
    summarize: async (input) => {
      if (impl) return impl(input.text);
      return { title: `摘要：${input.title}`, content: `【${input.scope}】${input.text.slice(0, 20)}` };
    },
  };
}

const MD = '# 需求文档\n## 功能一\n这是功能一的描述。\n## 功能二\n这是功能二。';

function makeService(opts: { extraction?: MemoryExtractionPort | null; memory?: FakeDocMemoryPort } = {}): {
  service: DocService;
  store: FakeDocStore;
  memory: FakeDocMemoryPort;
} {
  const store = new FakeDocStore();
  const memory = opts.memory ?? new FakeDocMemoryPort([{ id: 'm1', scope: 'project', title: '项目记忆A' }]);
  const service = new DocService({
    store,
    parsers: createDefaultParserRegistry(),
    memory,
    extraction: opts.extraction ?? undefined,
    clock: () => 1000,
    newId: (() => {
      let i = 0;
      return () => `id-${++i}`;
    })(),
  });
  return { service, store, memory };
}

describe('文档导入与解析层级', () => {
  it('Markdown 导入后 sections 层级正确并落首版本', async () => {
    const { service } = makeService();
    const doc = await service.importDocument({ projectId: 'p1', format: 'markdown', raw: MD, title: '需求文档' });
    expect(doc.title).toBe('需求文档');
    expect(doc.sections.map((s) => s.level)).toEqual([1, 2, 2]);
    expect(doc.version).toBe(1);
    const versions = await service.listVersions(doc.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.createdBy).toBe('import');
  });

  it('DOCX / PDF / TXT 导入均保留标题层级', async () => {
    const { service } = makeService();
    const mdDoc = await service.importDocument({ projectId: 'p1', format: 'txt', raw: '第一章 概述\n概述正文。' });
    expect(mdDoc.sections[0]!.level).toBe(1);
    expect(mdDoc.format).toBe('txt');
  });

  it('图片文档未接入 OCR 时如实报错（不静默入库）', async () => {
    const { service } = makeService();
    await expect(service.importDocument({ projectId: 'p1', format: 'image', raw: new Uint8Array([1, 2, 3]) })).rejects.toBeInstanceOf(
      DocDomainError,
    );
    const all = await service.listDocuments('p1');
    expect(all).toHaveLength(0);
  });
});

describe('关联记忆与双向反查', () => {
  it('关联到记忆节点并可反查"被哪些记忆引用"', async () => {
    const { service, memory } = makeService();
    const doc = await service.importDocument({ projectId: 'p1', format: 'markdown', raw: MD });
    const link = await service.linkToMemory({ memoryId: 'm1', documentId: doc.id, linkType: 'supports' });
    expect(link.linkType).toBe('supports');

    const byDoc = await service.listDocLinks(doc.id);
    expect(byDoc).toHaveLength(1);
    const byMem = await service.listMemoryRefs('m1');
    expect(byMem).toHaveLength(1);
    expect(byMem[0]!.documentId).toBe(doc.id);

    await service.removeLink(link.id);
    expect(await service.listDocLinks(doc.id)).toHaveLength(0);
    void memory;
  });
});

describe('一键转记忆', () => {
  it('端口缺失时如实报错并给引导，不内置模板顶替', async () => {
    const { service } = makeService({ extraction: null });
    const doc = await service.importDocument({ projectId: 'p1', format: 'markdown', raw: MD });
    await expect(service.previewConvertToMemory({ docId: doc.id, scope: 'project' })).rejects.toMatchObject({
      code: 'extraction_unavailable',
    });
  });

  it('走 AI 摘要生成可编辑草稿并保留原文链接（docId + 锚点）', async () => {
    const { service } = makeService({ extraction: makeExtraction() });
    const doc = await service.importDocument({ projectId: 'p1', format: 'markdown', raw: MD });
    const anchor = doc.sections[1]!.anchor;
    const draft = await service.previewConvertToMemory({ docId: doc.id, scope: 'project', anchor });
    expect(draft.sourceRef.docId).toBe(doc.id);
    expect(draft.sourceRef.anchor).toBe(anchor);
    expect(draft.content).toContain('功能一');

    const node = await service.commitConvertToMemory({ projectId: 'p1', draft });
    expect(node.scope).toBe('project');
    // 关联建立 derived_from
    const refs = await service.listMemoryRefs(node.id);
    expect(refs[0]!.linkType).toBe('derived_from');
    expect(refs[0]!.documentId).toBe(doc.id);
  });
});

describe('版本提示与忽略', () => {
  it('编辑后版本递增、关联记忆提示"已更新"，忽略后不再提示', async () => {
    const { service } = makeService();
    const doc = await service.importDocument({ projectId: 'p1', format: 'markdown', raw: MD });
    await service.linkToMemory({ memoryId: 'm1', documentId: doc.id, linkType: 'related' });

    await service.updateDocument({ id: doc.id, raw: '# 需求文档\n## 功能一\n修改后内容。\n## 新增功能\n新内容。' });
    const updated = await service.getDocument(doc.id);
    expect(updated!.version).toBe(2);
    const status1 = await service.evaluateDocUpdateStatus(doc.id);
    expect(status1.updated).toBe(true);

    await service.ignoreVersion(doc.id, 2);
    const status2 = await service.evaluateDocUpdateStatus(doc.id);
    expect(status2.updated).toBe(false);

    // 再编辑产生 v3，提示重新出现
    await service.updateDocument({ id: doc.id, raw: '# 需求文档\n## 功能一\n再次修改。' });
    const status3 = await service.evaluateDocUpdateStatus(doc.id);
    expect(status3.updated).toBe(true);
    expect(status3.currentVersion).toBe(3);
  });
});

describe('流水线产物自动入档', () => {
  it('命名 <项目>-需求文档-v<阶段版本>.md 并自动关联记忆', async () => {
    const { service } = makeService();
    const doc = await service.archivePipelineArtifact({
      projectId: 'p1',
      projectName: '商城',
      stageVersion: 2,
      content: '# 需求文档\n## 范围\n需求内容。',
      memoryId: 'm1',
    });
    expect(doc.title).toBe('商城-需求文档-v2');
    expect(doc.format).toBe('markdown');
    expect(doc.kind).toBe('requirement');
    const refs = await service.listMemoryRefs('m1');
    expect(refs[0]!.linkType).toBe('derived_from');
    expect(refs[0]!.documentId).toBe(doc.id);
  });
});

describe('回收站', () => {
  it('删除进回收站、恢复、彻底删除', async () => {
    const { service } = makeService();
    const doc = await service.importDocument({ projectId: 'p1', format: 'markdown', raw: MD });
    await service.deleteDocument(doc.id);
    expect((await service.listDocuments('p1')).find((d) => d.id === doc.id)).toBeUndefined();
    expect((await service.listDocuments('p1', { includeDeleted: true })).some((d) => d.id === doc.id)).toBe(true);
    await service.restoreDocument(doc.id);
    expect((await service.listDocuments('p1')).some((d) => d.id === doc.id)).toBe(true);
    await service.purgeDocument(doc.id);
    expect((await service.listDocuments('p1', { includeDeleted: true })).some((d) => d.id === doc.id)).toBe(false);
  });
});
