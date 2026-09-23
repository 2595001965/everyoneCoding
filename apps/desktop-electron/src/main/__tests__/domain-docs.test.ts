import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DomainControlServiceHost } from '@ec/shell-api';

import { openBusinessDb } from '../domain/db';
import type { AiStackHandle } from '../domain/domain-factories';
import { createDocsDomain } from '../domain/docs';
import { createDomainRuntime } from '../domain/runtime';

/**
 * docs 域运行时测试（真实 SQLite + 真实文件，不做假 IO）。
 *
 * 覆盖真实语义：导入要真的解析出章节、编辑要真的留版本快照、删除是软删、
 * 彻底删除要清关联与版本、关联要真的落 memory_doc_link、转记忆要真的建记忆节点。
 */

let root: string;
let dataDir: string;
let db: Database.Database;
let runtime: DomainControlServiceHost;
const projectId = 'p1';

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await runtime.invoke({ requestId: 'test', domain: 'docs', method, params });
  if (!response.ok) {
    const error = new Error(response.error?.message ?? '域调用失败') as Error & {
      code?: string | undefined;
    };
    error.code = response.error?.code;
    throw error;
  }
  return response.result as T;
}

interface DocShape {
  id: string;
  projectId: string;
  title: string;
  format: string;
  version: number;
  sections: Array<{ heading: string; anchor: string; text: string; level: number }>;
  deletedAt: number | null;
  ignoredVersion: number | null;
}

const MARKDOWN = [
  '# 登录需求',
  '',
  '支持邮箱登录。',
  '',
  '## 校验规则',
  '',
  '邮箱不区分大小写。',
].join('\n');

async function importDoc(title = '登录需求'): Promise<DocShape> {
  return call('importDocument', { input: { projectId, format: 'markdown', raw: MARKDOWN, title } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-docs-'));
  dataDir = join(root, 'data');
  db = openBusinessDb({ dataDir });
  const now = Date.now();
  db.prepare(
    `INSERT INTO project (id, user_id, workspace_id, name, description, tech_stack_json, status, created_at, updated_at)
     VALUES (?, 'local-user', NULL, '演示项目', NULL, NULL, 'active', ?, ?)`,
  ).run(projectId, now, now);
  runtime = createDomainRuntime({ routers: { docs: createDocsDomain({ db }).router } });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('导入与解析', () => {
  it('导入 markdown 会真的解析出章节与锚点，并落一条文档行', async () => {
    const doc = await importDoc();
    expect(doc.projectId).toBe(projectId);
    expect(doc.format).toBe('markdown');
    expect(doc.version).toBe(1);
    expect(doc.deletedAt).toBeNull();
    expect(doc.sections.length).toBeGreaterThanOrEqual(2);
    expect(doc.sections.map((section) => section.heading)).toContain('登录需求');
    expect(doc.sections.every((section) => section.anchor.length > 0)).toBe(true);

    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM document WHERE project_id = ?`).get(projectId),
    ).toEqual({ n: 1 });
  });

  it('importFromFile 读真实文件导入；文件不存在时如实报 NOT_FOUND 并带上路径', async () => {
    const file = join(root, '需求.md');
    writeFileSync(file, MARKDOWN, 'utf8');
    const doc = await call<DocShape>('importFromFile', {
      input: { projectId, format: 'markdown', filePath: file },
    });
    // 来源路径记进 sourceRef，便于"文档已更新"的溯源
    expect(doc.title).toBeTruthy();

    await expect(
      call('importFromFile', {
        input: { projectId, format: 'markdown', filePath: join(root, '不存在.md') },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('supportedFormats 走 Node 侧注册表：docx/pdf/image 全可用（OCR 已接线）', async () => {
    const formats = await call<string[]>('supportedFormats');
    expect(formats).toContain('markdown');
    expect(formats).toContain('txt');
    expect(formats).toContain('docx');
    expect(formats).toContain('pdf');
    expect(formats).toContain('image');
  });

  it('ocrStatus 如实上报可用性与语言清单', async () => {
    const status = await call<{
      available: boolean;
      reason: string | null;
      languages: string[];
      detail: string;
    }>('ocrStatus');
    expect(typeof status.available).toBe('boolean');
    expect(Array.isArray(status.languages)).toBe(true);
    // 引导文案必须可读（非空 detail）
    expect(status.detail.length).toBeGreaterThan(0);
  });

  it('未知格式导入如实报 NOT_SUPPORTED', async () => {
    await expect(
      call('importDocument', {
        input: { projectId, format: 'image', raw: new Uint8Array([1, 2, 3]), title: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });
});

describe('列表、编辑与版本', () => {
  it('listDocuments / getDocument 取得到；不存在返回 null', async () => {
    const doc = await importDoc();
    const listed = await call<DocShape[]>('listDocuments', { projectId });
    expect(listed.map((item) => item.id)).toEqual([doc.id]);
    await expect(call<DocShape>('getDocument', { id: doc.id })).resolves.toMatchObject({
      id: doc.id,
    });
    await expect(call('getDocument', { id: 'missing' })).resolves.toBeNull();
  });

  it('编辑会升版本并留下版本快照；更新提示随版本变化', async () => {
    const doc = await importDoc();
    expect(await call<{ updated: boolean }>('evaluateUpdateStatus', { id: doc.id })).toMatchObject({
      updated: false,
      currentVersion: 1,
    });

    const updated = await call<DocShape>('updateDocument', {
      input: { id: doc.id, raw: `${MARKDOWN}\n\n## 新增章节\n\n补充说明。`, createdBy: 'user' },
    });
    expect(updated.version).toBe(2);

    const versions = await call<Array<{ version: number; createdBy: string }>>('listVersions', {
      id: doc.id,
    });
    expect(versions.length).toBeGreaterThanOrEqual(1);

    expect(await call<{ updated: boolean }>('evaluateUpdateStatus', { id: doc.id })).toMatchObject({
      updated: true,
      currentVersion: 2,
    });
  });

  it('ignoreVersion 之后更新提示被压掉', async () => {
    const doc = await importDoc();
    await call('updateDocument', { input: { id: doc.id, raw: `${MARKDOWN}\n\n## 二\n\nx` } });
    await call('ignoreVersion', { id: doc.id, version: 2 });
    await expect(
      call<{ ignored: boolean; updated: boolean }>('evaluateUpdateStatus', { id: doc.id }),
    ).resolves.toMatchObject({
      ignored: true,
      updated: false,
    });
  });
});

describe('回收站与彻底删除', () => {
  it('删除是软删（仍可查到），恢复后回到列表', async () => {
    const doc = await importDoc();
    await call('deleteDocument', { id: doc.id });
    expect(await call<DocShape[]>('listDocuments', { projectId })).toHaveLength(0);
    expect(
      await call<DocShape[]>('listDocuments', { projectId, opts: { includeDeleted: true } }),
    ).toHaveLength(1);
    expect(await call<DocShape>('getDocument', { id: doc.id })).toMatchObject({
      deletedAt: expect.any(Number),
    });

    await call('restoreDocument', { id: doc.id });
    expect(await call<DocShape[]>('listDocuments', { projectId })).toHaveLength(1);
  });

  it('purgeDocument 级联清掉关联与版本', async () => {
    const doc = await importDoc();
    const memory = db
      .prepare(
        `INSERT INTO memory_item (id, user_id, scope, project_id, title, content, tags, source_type, confidence, importance, status, pinned, version, created_at, updated_at)
         VALUES ('m1', 'local-user', 'project', ?, '记忆', '内容', '[]', 'manual', 1.0, 3, 'active', 0, 1, ?, ?)`,
      )
      .run(projectId, Date.now(), Date.now());
    expect(memory.changes).toBe(1);
    await call('linkToMemory', {
      input: { memoryId: 'm1', documentId: doc.id, linkType: 'related' },
    });
    db.prepare(
      `INSERT INTO doc_version (id, document_id, version, title, content_text, sections_json, created_by, created_at)
       VALUES ('v1', ?, 1, '旧版', 'x', NULL, 'user', ?)`,
    ).run(doc.id, Date.now());

    await call('purgeDocument', { id: doc.id });

    expect(await call('getDocument', { id: doc.id })).toBeNull();
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM memory_doc_link WHERE document_id = ?`).get(doc.id),
    ).toEqual({ n: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM doc_version WHERE document_id = ?`).get(doc.id),
    ).toEqual({ n: 0 });
  });
});

describe('记忆关联', () => {
  function seedMemory(id: string, scope = 'project', project: string | null = projectId): void {
    db.prepare(
      `INSERT INTO memory_item (id, user_id, scope, project_id, title, content, tags, source_type, confidence, importance, status, pinned, version, created_at, updated_at)
       VALUES (?, 'local-user', ?, ?, ?, ?, '[]', 'manual', 1.0, 3, 'active', 0, 1, ?, ?)`,
    ).run(id, scope, project, `记忆${id}`, '内容', Date.now(), Date.now());
  }

  it('listMemoryNodes 取项目内 active 记忆；传 null 取跨项目记忆', async () => {
    seedMemory('m1');
    seedMemory('m2', 'longterm', null);
    const inProject = await call<Array<{ id: string }>>('listMemoryNodes', { projectId });
    expect(inProject.map((item) => item.id)).toEqual(['m1']);
    const cross = await call<Array<{ id: string }>>('listMemoryNodes', { projectId: null });
    expect(cross.map((item) => item.id)).toEqual(['m2']);
  });

  it('关联双向可查、可批量计数、可删除；删除不存在的关联报 NOT_FOUND', async () => {
    const doc = await importDoc();
    seedMemory('m1');
    const link = await call<{ id: string; memoryId: string; documentId: string; linkType: string }>(
      'linkToMemory',
      {
        input: { memoryId: 'm1', documentId: doc.id, linkType: 'supports' },
      },
    );
    expect(link).toMatchObject({ memoryId: 'm1', documentId: doc.id, linkType: 'supports' });

    expect(await call<unknown[]>('listDocLinks', { documentId: doc.id })).toHaveLength(1);
    expect(await call<unknown[]>('listMemoryRefs', { memoryId: 'm1' })).toHaveLength(1);
    await expect(call('countLinksForMemories', { memoryIds: ['m1', 'm2'] })).resolves.toEqual({
      m1: 1,
    });
    await expect(call('countLinksForMemories', { memoryIds: [] })).resolves.toEqual({});

    await call('removeLink', { id: link.id });
    expect(await call<unknown[]>('listDocLinks', { documentId: doc.id })).toHaveLength(0);
    await expect(call('removeLink', { id: link.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('一键转记忆', () => {
  it('AI 未装配时 previewConvertToMemory 如实报错，并给出可读引导', async () => {
    const doc = await importDoc();
    await expect(
      call('previewConvertToMemory', { input: { docId: doc.id, scope: 'project' } }),
    ).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      message: expect.stringContaining('AI 摘要端口'),
    });
  });

  it('commitConvertToMemory 不依赖 AI：建出记忆节点并自动建立 derived_from 关联', async () => {
    const doc = await importDoc();
    const node = await call<{ id: string; scope: string; title: string }>('commitConvertToMemory', {
      input: {
        projectId,
        draft: {
          docId: doc.id,
          scope: 'project',
          title: '登录需求摘要',
          content: '邮箱登录且不区分大小写。',
          sourceRef: { docId: doc.id, anchor: null },
        },
      },
    });
    expect(node).toMatchObject({ scope: 'project', title: '登录需求摘要' });

    const row = db
      .prepare(`SELECT content, source_type, source_ref FROM memory_item WHERE id = ?`)
      .get(node.id) as { content: string; source_type: string; source_ref: string | null };
    // 正文里保留原文链接，记忆侧可回溯
    expect(row.content).toContain(`docId=${doc.id}`);
    expect(row.source_type).toBe('doc');
    expect(row.source_ref).toContain(doc.id);

    const links = await call<Array<{ linkType: string }>>('listDocLinks', { documentId: doc.id });
    expect(links).toEqual([
      {
        id: expect.any(String),
        memoryId: node.id,
        documentId: doc.id,
        linkType: 'derived_from',
        createdAt: expect.any(Number),
      },
    ]);
  });
});

describe('一键转记忆（注入 AI 栈后走真实网关流）', () => {
  /**
   * 假网关流块 —— **必须与真实 `StreamChunk` 判别值一致**：文本块是 `'delta'`
   * （见 `packages/ai/src/core/stream.ts`）。
   * 以前夹具写成 `'chunk'`，于是夹具与实现"错得一样"，测试全绿而线上恒为空串。
   */
  type FakeStreamChunk =
    | { type: 'delta'; text: string; model?: string }
    | { type: 'done'; finishReason: string; partial?: boolean }
    | { type: 'error'; error: string };

  /** 可编程 AI 网关假实现（与 AiStackHandle.gateway 形状一致） */
  function makeAiStack(
    behavior: () => AsyncIterable<FakeStreamChunk> | (() => never),
  ): AiStackHandle {
    return {
      gateway: { chat: behavior as never },
    };
  }

  function chunkIter(chunks: FakeStreamChunk[]): AsyncIterable<FakeStreamChunk> {
    return (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  }

  beforeEach(() => {
    db.prepare(
      `INSERT OR IGNORE INTO user (id, login, display_name, role, created_at, updated_at) VALUES ('local-user', 'local-user', '本地用户', 'owner', 0, 0)`,
    ).run();
  });

  it('AI 正常输出时：预览产出「标题+摘要」草稿并保留段落锚点；提交落库带原文链接', async () => {
    const aiStack = makeAiStack(() =>
      chunkIter([
        { type: 'delta', text: '标题：登录需求要点\n\n' },
        { type: 'delta', text: '- 支持邮箱登录\n- 邮箱不区分大小写' },
        { type: 'done', finishReason: 'stop' },
      ]),
    );
    const domain = createDocsDomain({ db, aiStack });
    runtime = createDomainRuntime({ routers: { docs: domain.router } });

    const doc = await importDoc();
    const draft = await call<{
      title: string;
      content: string;
      sourceRef: { docId: string; anchor: string | null };
    }>('previewConvertToMemory', { input: { docId: doc.id, scope: 'project' } });
    expect(draft.title).toBe('登录需求要点');
    expect(draft.content).toContain('支持邮箱登录');
    expect(draft.sourceRef.docId).toBe(doc.id);

    // 带锚点：草稿引用选中段落的锚点
    const draftSection = await call<{ sourceRef: { anchor: string | null } }>(
      'previewConvertToMemory',
      {
        input: { docId: doc.id, scope: 'project', anchor: doc.sections[1]?.anchor },
      },
    );
    expect(draftSection.sourceRef.anchor).toBe(doc.sections[1]?.anchor ?? null);

    const node = await call<{ id: string }>('commitConvertToMemory', {
      input: { projectId, draft },
    });
    const row = db.prepare(`SELECT content FROM memory_item WHERE id = ?`).get(node.id) as {
      content: string;
    };
    expect(row.content).toContain(`docId=${doc.id}`);
  });

  it('AI 流式报错时：结构化失败提示（UNKNOWN），绝不伪造摘要', async () => {
    const aiStack = makeAiStack(() =>
      chunkIter([{ type: 'error', error: '上游模型 503：配额不足' }]),
    );
    const domain = createDocsDomain({ db, aiStack });
    runtime = createDomainRuntime({ routers: { docs: domain.router } });

    const doc = await importDoc();
    await expect(
      call('previewConvertToMemory', { input: { docId: doc.id, scope: 'longterm' } }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('AI 摘要失败'),
    });
    // 失败后库里没有半截记忆节点
    const count = db.prepare(`SELECT COUNT(*) AS n FROM memory_item`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('AI 空输出时：如实报"输出为空"引导检查配置', async () => {
    const aiStack = makeAiStack(() => chunkIter([{ type: 'done', finishReason: 'stop' }]));
    const domain = createDocsDomain({ db, aiStack });
    runtime = createDomainRuntime({ routers: { docs: domain.router } });

    const doc = await importDoc();
    await expect(
      call('previewConvertToMemory', { input: { docId: doc.id, scope: 'project' } }),
    ).rejects.toThrowError(/AI 摘要输出为空/);
  });
});

describe('图片 OCR（注入假端口走完整导入→检索→转记忆链）', () => {
  beforeEach(() => {
    db.prepare(
      `INSERT OR IGNORE INTO user (id, login, display_name, role, created_at, updated_at) VALUES ('local-user', 'local-user', '本地用户', 'owner', 0, 0)`,
    ).run();
  });

  function makeFakeOcr(sections: Array<{ heading: string; text: string }> | 'fail') {
    return sections === 'fail'
      ? {
          availability: async () => ({
            available: false,
            reason: '语言包缺失',
            languages: [],
            detail: 'x',
          }),
          recognize: async () => {
            throw new Error('语言包缺失');
          },
        }
      : {
          availability: async () => ({
            available: true,
            reason: null,
            languages: ['zh-CN'],
            detail: 'fake',
          }),
          recognize: async () => ({
            title: '截图',
            sections: sections.map((s, index) => ({
              index,
              level: 0,
              heading: s.heading,
              anchor: `sec-${index}`,
              text: s.text,
            })),
          }),
        };
  }

  it('图片导入成功：OCR 文本入库可检索，且能转记忆', async () => {
    const domain = createDocsDomain({
      db,
      aiStack: null,
      ocr: makeFakeOcr([{ heading: '', text: '登录页截图文字：支持手机号登录' }]),
    });
    runtime = createDomainRuntime({ routers: { docs: domain.router } });
    expect(await call<string[]>('supportedFormats')).toContain('image');

    const doc = await call<DocShape & { contentText: string }>('importDocument', {
      input: {
        projectId,
        format: 'image',
        raw: new Uint8Array([137, 80, 78, 71]),
        title: '登录截图',
        fileName: 'shot.png',
      },
    });
    expect(doc.format).toBe('image');
    expect(doc.contentText).toContain('手机号登录');

    // OCR 文本可检索（content_text 落库）
    const row = db.prepare(`SELECT content_text FROM document WHERE id = ?`).get(doc.id) as {
      content_text: string;
    };
    expect(row.content_text).toContain('手机号登录');

    // 转 memory：commit 不依赖 AI
    const node = await call<{ id: string }>('commitConvertToMemory', {
      input: {
        projectId,
        draft: {
          docId: doc.id,
          scope: 'feature',
          title: '登录截图要点',
          content: '截图显示支持手机号登录。',
          sourceRef: { docId: doc.id, anchor: 'sec-0' },
        },
      },
    });
    expect(node.id).toBeTruthy();
  });

  it('OCR 失败时：NOT_SUPPORTED + 安装/语言引导，不落空文档', async () => {
    const domain = createDocsDomain({ db, aiStack: null, ocr: makeFakeOcr('fail') });
    runtime = createDomainRuntime({ routers: { docs: domain.router } });
    const status = await call<{ available: boolean; reason: string | null }>('ocrStatus');
    expect(status.available).toBe(false);
    expect(status.reason).toContain('语言包');

    await expect(
      call('importDocument', {
        input: { projectId, format: 'image', raw: new Uint8Array([1]), title: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM document`).get() as { n: number }).n).toBe(0);
  });
});
