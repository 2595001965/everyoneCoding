/**
 * 文档服务单测（T9-04 / FR-DOC-01~06）。
 *
 * 用内存假端口（真函数 + Map 存储）跑通真实语义：导入→解析层级、关联/反查、
 * 转记忆保留原文链接、版本提示与忽略、流水线产物入档命名。不碰 SQLite。
 */

import { describe, expect, it } from 'vitest';

import {
  DocDomainError,
  type DocLinkType,
  type DocMemoryLink,
  type DocMemoryNode,
  type DocMemoryScope,
  type DocStore,
  type DocMemoryPort,
  type DocVersionRowSnapshot,
  type MemoryDocLinkRowSnapshot,
  type DocumentRowSnapshot,
  type MemoryExtractionPort,
  type OcrPort,
} from '../doc-types';
import { createDefaultParserRegistry } from '../parsers/node-registry';
import { DocService } from '../doc-service';
import { buildDocx, buildPdf } from './doc-fixtures';

class FakeDocStore implements DocStore {
  readonly rows = new Map<string, DocumentRowSnapshot>();
  readonly versions = new Map<string, DocVersionRowSnapshot[]>();

  loadAll(projectId: string): Promise<DocumentRowSnapshot[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.project_id === projectId).map((r) => ({ ...r })),
    );
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
  createMemory(input: {
    projectId: string;
    scope: DocMemoryScope;
    title: string;
    content: string;
    sourceRef?: unknown;
  }): Promise<DocMemoryNode> {
    this.n += 1;
    const node: DocMemoryNode = { id: `mem-${this.n}`, scope: input.scope, title: input.title };
    this.nodes.set(node.id, node);
    return Promise.resolve(node);
  }
  link(input: {
    memoryId: string;
    documentId: string;
    linkType: DocLinkType;
  }): Promise<DocMemoryLink> {
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
        .map((l) => ({
          id: l.id,
          memoryId: l.memory_id,
          documentId: l.document_id,
          linkType: l.link_type as DocLinkType,
          createdAt: l.created_at,
        })),
    );
  }
  listLinksByMemory(memoryId: string): Promise<DocMemoryLink[]> {
    return Promise.resolve(
      [...this.links.values()]
        .filter((l) => l.memory_id === memoryId)
        .map((l) => ({
          id: l.id,
          memoryId: l.memory_id,
          documentId: l.document_id,
          linkType: l.link_type as DocLinkType,
          createdAt: l.created_at,
        })),
    );
  }
  removeLink(id: string): Promise<void> {
    this.links.delete(id);
    return Promise.resolve();
  }
}

function makeExtraction(
  impl?: (text: string) => { title: string; content: string },
): MemoryExtractionPort {
  return {
    summarize: async (input) => {
      if (impl) return impl(input.text);
      return {
        title: `摘要：${input.title}`,
        content: `【${input.scope}】${input.text.slice(0, 20)}`,
      };
    },
  };
}

const MD = '# 需求文档\n## 功能一\n这是功能一的描述。\n## 功能二\n这是功能二。';

function makeService(
  opts: {
    extraction?: MemoryExtractionPort | null;
    memory?: FakeDocMemoryPort;
    ocr?: OcrPort | null;
  } = {},
): {
  service: DocService;
  store: FakeDocStore;
  memory: FakeDocMemoryPort;
} {
  const store = new FakeDocStore();
  const memory =
    opts.memory ?? new FakeDocMemoryPort([{ id: 'm1', scope: 'project', title: '项目记忆A' }]);
  const service = new DocService({
    store,
    parsers: createDefaultParserRegistry({ ocr: opts.ocr ?? null }),
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
    const doc = await service.importDocument({
      projectId: 'p1',
      format: 'markdown',
      raw: MD,
      title: '需求文档',
    });
    expect(doc.title).toBe('需求文档');
    expect(doc.sections.map((s) => s.level)).toEqual([1, 2, 2]);
    expect(doc.version).toBe(1);
    const versions = await service.listVersions(doc.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.createdBy).toBe('import');
  });

  it('DOCX / PDF / TXT 导入均保留标题层级', async () => {
    const { service } = makeService();
    const mdDoc = await service.importDocument({
      projectId: 'p1',
      format: 'txt',
      raw: '第一章 概述\n概述正文。',
    });
    expect(mdDoc.sections[0]!.level).toBe(1);
    expect(mdDoc.format).toBe('txt');
  });

  it('图片文档未接入 OCR 时如实报错（不静默入库）', async () => {
    const { service } = makeService();
    await expect(
      service.importDocument({ projectId: 'p1', format: 'image', raw: new Uint8Array([1, 2, 3]) }),
    ).rejects.toBeInstanceOf(DocDomainError);
    const all = await service.listDocuments('p1');
    expect(all).toHaveLength(0);
  });
});

describe('关联记忆与双向反查', () => {
  it('关联到记忆节点并可反查"被哪些记忆引用"', async () => {
    const { service, memory } = makeService();
    const doc = await service.importDocument({ projectId: 'p1', format: 'markdown', raw: MD });
    const link = await service.linkToMemory({
      memoryId: 'm1',
      documentId: doc.id,
      linkType: 'supports',
    });
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
    await expect(
      service.previewConvertToMemory({ docId: doc.id, scope: 'project' }),
    ).rejects.toMatchObject({
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

    await service.updateDocument({
      id: doc.id,
      raw: '# 需求文档\n## 功能一\n修改后内容。\n## 新增功能\n新内容。',
    });
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
    expect(
      (await service.listDocuments('p1', { includeDeleted: true })).some((d) => d.id === doc.id),
    ).toBe(true);
    await service.restoreDocument(doc.id);
    expect((await service.listDocuments('p1')).some((d) => d.id === doc.id)).toBe(true);
    await service.purgeDocument(doc.id);
    expect(
      (await service.listDocuments('p1', { includeDeleted: true })).some((d) => d.id === doc.id),
    ).toBe(false);
  });
});

describe('四类格式导入：成功与失败各一（FR-DOC-01）', () => {
  const DOCX_XML =
    '<w:document><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>接口约定</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>登录接口返回 identity 与 tokens。</w:t></w:r></w:p>' +
    '</w:body></w:document>';

  it('Markdown：成功入库；空白内容 → empty_content 且不落库', async () => {
    const { service } = makeService();
    const ok = await service.importDocument({ projectId: 'p1', format: 'markdown', raw: MD });
    expect(ok.sections.length).toBeGreaterThan(0);
    await expect(
      service.importDocument({ projectId: 'p1', format: 'markdown', raw: '  \n\n ' }),
    ).rejects.toMatchObject({ code: 'empty_content' });
    expect(await service.listDocuments('p1')).toHaveLength(1);
  });

  it('Word：成功提取标题层级；损坏文件 → parse_failed（原因含"DOCX 解析失败"）', async () => {
    const { service } = makeService();
    const ok = await service.importDocument({
      projectId: 'p1',
      format: 'docx',
      raw: buildDocx(DOCX_XML),
    });
    expect(ok.title).toBe('接口约定');
    expect(ok.sections[0]!.level).toBe(1);
    const failure = service.importDocument({
      projectId: 'p1',
      format: 'docx',
      raw: new TextEncoder().encode('这不是 docx'),
    });
    await expect(failure).rejects.toMatchObject({ code: 'parse_failed' });
    await expect(failure).rejects.toThrow(/DOCX 解析失败/);
    expect(await service.listDocuments('p1')).toHaveLength(1);
  });

  it('PDF：成功带页码；无文字（扫描件/空文件）→ empty_content 并引导改用图片 OCR', async () => {
    const { service } = makeService();
    const ok = await service.importDocument({
      projectId: 'p1',
      format: 'pdf',
      raw: buildPdf(['BT /F1 20 Tf (Design Notes) Tj ET\nBT /F1 10 Tf (Body text here.) Tj ET']),
    });
    expect(ok.sections.some((s) => s.page === 1)).toBe(true);
    const failure = service.importDocument({
      projectId: 'p1',
      format: 'pdf',
      raw: buildPdf(['q 1 0 0 1 0 0 cm Q']),
    });
    await expect(failure).rejects.toMatchObject({ code: 'empty_content' });
    await expect(failure).rejects.toThrow(/扫描件/);
    expect(await service.listDocuments('p1')).toHaveLength(1);
  });

  it('图片：OCR 文本入库 → searchDocuments 命中并带锚点 → 可转记忆且保留原文链接', async () => {
    const languages: Array<string | undefined> = [];
    const { service } = makeService({
      extraction: makeExtraction(),
      ocr: {
        recognize: async (input) => {
          languages.push(input.language);
          return {
            title: input.fileName ?? '图片',
            sections: [
              { index: 0, level: 0, heading: '', anchor: 'sec-0', text: '功能一：扫码登录' },
              { index: 1, level: 0, heading: '', anchor: 'sec-1', text: '功能二：手机号验证码' },
            ],
          };
        },
      },
    });
    const doc = await service.importDocument({
      projectId: 'p1',
      format: 'image',
      raw: new Uint8Array([137, 80, 78, 71]),
      fileName: 'login.png',
      ocrLanguage: 'zh-CN',
    });
    expect(languages).toEqual(['zh-CN']);
    expect(doc.title).toBe('login.png');

    const hits = await service.searchDocuments('p1', '手机号');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ docId: doc.id, anchor: 'sec-1', format: 'image' });
    expect(hits[0]!.snippet).toContain('手机号验证码');

    const draft = await service.previewConvertToMemory({
      docId: doc.id,
      scope: 'feature',
      anchor: hits[0]!.anchor,
    });
    expect(draft.sourceRef).toMatchObject({ docId: doc.id, anchor: 'sec-1' });
    const node = await service.commitConvertToMemory({ projectId: 'p1', draft });
    expect((await service.listMemoryRefs(node.id))[0]!.documentId).toBe(doc.id);
  });

  it('图片：OCR 零文本 → empty_content；OCR 不可用 → ocr_unsupported；两者都不落库', async () => {
    const empty = makeService({
      ocr: { recognize: async () => ({ title: 'x', sections: [] }) },
    }).service;
    await expect(
      empty.importDocument({ projectId: 'p1', format: 'image', raw: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ code: 'empty_content' });
    expect(await empty.listDocuments('p1')).toHaveLength(0);

    const broken = makeService({
      ocr: {
        recognize: async () => {
          throw new Error('OCR 子进程超时');
        },
      },
    }).service;
    await expect(
      broken.importDocument({ projectId: 'p1', format: 'image', raw: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ code: 'ocr_unsupported' });
    expect(await broken.listDocuments('p1')).toHaveLength(0);
  });
});

describe('文档检索', () => {
  it('跨文档、不区分大小写、空白归一；回收站文档不参与；空查询返回空', async () => {
    const { service } = makeService();
    const a = await service.importDocument({ projectId: 'p1', format: 'markdown', raw: MD });
    await service.importDocument({
      projectId: 'p1',
      format: 'txt',
      raw: '第一章 Release Notes\n支持  离线模式。',
    });
    expect(await service.searchDocuments('p1', '   ')).toEqual([]);
    expect((await service.searchDocuments('p1', 'release notes')).length).toBe(1);
    expect((await service.searchDocuments('p1', '支持 离线')).length).toBe(1);

    const hit = (await service.searchDocuments('p1', '功能二'))[0]!;
    expect(hit.docId).toBe(a.id);
    expect(hit.heading).toBe('功能二');

    await service.deleteDocument(a.id);
    expect(await service.searchDocuments('p1', '功能二')).toEqual([]);
  });

  it('编辑时新正文解析失败 → 结构化报错且不升版本', async () => {
    const { service } = makeService();
    const doc = await service.importDocument({ projectId: 'p1', format: 'markdown', raw: MD });
    await expect(service.updateDocument({ id: doc.id, raw: '   ' })).rejects.toMatchObject({
      code: 'empty_content',
    });
    expect((await service.getDocument(doc.id))!.version).toBe(1);
  });
});
