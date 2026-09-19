import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DomainControlServiceHost } from '@ec/shell-api';

import { openBusinessDb } from '../domain/db';
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

  it('supportedFormats 走 Node 侧注册表：docx/pdf 可用，image 因缺 OCR 不支持', async () => {
    const formats = await call<string[]>('supportedFormats');
    expect(formats).toContain('markdown');
    expect(formats).toContain('txt');
    expect(formats).toContain('docx');
    expect(formats).toContain('pdf');
    expect(formats).not.toContain('image');
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
  it('previewConvertToMemory 因未注入 AI 摘要端口而如实报错，并给出可读引导', async () => {
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
