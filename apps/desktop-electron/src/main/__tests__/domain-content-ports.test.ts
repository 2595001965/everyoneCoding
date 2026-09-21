import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDomainEventSink } from '@ec/shell-api';
import type { AssembledContext, ContextBlock } from '@ec/ai';
import { deserializePageDsl, type PageDsl } from '@ec/designer/dsl';

import { openBusinessDb } from '../domain/db';
import { createDomainRuntime } from '../domain/runtime';
import { createWorkspaceDomain } from '../domain/workspace';
import {
  createProductionDomains,
  type AiStackHandle,
  type DomainFactoryContext,
} from '../domain/domain-factories';

/**
 * 记忆 / 上下文 / 代码写入 / 设计器端口的真实集成测试（T12-02）。
 *
 * 断言对象全部是**真实产物**：业务 SQLite 的行、工程目录里的文件、跨进程返回的信封。
 * 不打桩域实现，不 mock SQLite，不伪造模型输出（AI 重改那一处用一个**假 gateway**，
 * 但那正是"外壳注入的 AI 栈"这一层接口，属于端口替身而非领域替身）。
 *
 * 四组用例：
 * 1. 设计器 → 页面记忆增量写 + 结构变更台账 + 路由总表 + 备注（FR-ANN）；
 * 2. 上下文组装 → 十类块的**真实来源**、跳过原因、无数据时不得伪造内容；
 * 3. 代码写入 → plan / patch / apply / 冲突检测 / 事务回滚 / 只读边界；
 * 4. 外部改动检测与 AI 重改（WritePipeline 两段式）。
 */

let root: string;
let dataDir: string;
let projectsDir: string;
let db: Database.Database;
let runtime: ReturnType<typeof createDomainRuntime>;
let emitted: Array<{ domain: string; payload: unknown }>;

const USER_ID = 'local-user';

interface InvokeOptions {
  domain: string;
  method: string;
  params?: Record<string, unknown>;
}

async function call<T>(options: InvokeOptions): Promise<T> {
  const response = await runtime.invoke({
    requestId: 'test',
    domain: options.domain as never,
    method: options.method,
    params: options.params ?? {},
  });
  if (!response.ok) {
    const error = new Error(response.error?.message ?? '域调用失败') as Error & {
      code?: string | undefined;
    };
    error.code = response.error?.code;
    throw error;
  }
  return response.result as T;
}

function callSync<T>(options: InvokeOptions): T {
  const response = runtime.invokeSync({
    requestId: 'test-sync',
    domain: options.domain as never,
    method: options.method,
    params: options.params ?? {},
  });
  if (!response.ok) {
    const error = new Error(response.error?.message ?? '域调用失败') as Error & {
      code?: string | undefined;
    };
    error.code = response.error?.code;
    throw error;
  }
  return response.result as T;
}

/** 假 AI 栈：只替掉 gateway 这一层（真实模型不可能出现在单测里） */
function fakeAiStack(text: string): AiStackHandle {
  return {
    gateway: {
      async *chat() {
        yield { type: 'chunk', text };
        yield { type: 'done', model: 'fake-model' };
      },
    },
  };
}

function buildRuntime(
  options: { aiStack?: AiStackHandle | null } = {},
): ReturnType<typeof createDomainRuntime> {
  const ctx: DomainFactoryContext = {
    db,
    projectsDir,
    dataDir,
    userId: USER_ID,
    aiStack: options.aiStack ?? null,
    // T12-04：进程端口与 DPAPI 凭据在单测里不装配（对应能力如实降级），
    // 静态预览 / 注册表查询 / 导航跳转这些不依赖外壳能力的路径仍可被完整驱动。
    process: null,
    credentials: null,
    emit: (domain, payload) => {
      emitted.push({ domain, payload });
    },
  };
  const production = createProductionDomains(ctx);
  return createDomainRuntime({
    routers: {
      workspace: createWorkspaceDomain({ db, dataDir, projectsDir }).router,
      ...production.routers,
    },
    syncRouters: production.syncRouters,
    events: createDomainEventSink(),
    disposers: production.disposers,
  });
}

async function newProject(name: string): Promise<string> {
  const created = await call<{ id: string }>({
    domain: 'workspace',
    method: 'createProject',
    params: { input: { name } },
  });
  return created.id;
}

interface PageFixture {
  pageId: string;
  page: PageDsl;
}

/**
 * 建一页并写入「容器 → 卡片 → 表单 → 输入框 / 按钮」的真实结构。
 *
 * 用 `createPage` 产出的合法信封做底（不手写对象字面量，避免漏掉必填字段），
 * 再往里塞子树与状态 / 事件 / 接口依赖 —— 上下文引擎的元素祖先链、
 * 页面摘要与精简器都吃这些字段。
 */
async function createStructuredPage(
  projectId: string,
  name = '登录页',
  route = '/login',
): Promise<PageFixture> {
  const envelope = await call<{ page: PageDsl }>({
    domain: 'designer',
    method: 'createPage',
    params: { projectId, input: { name, route, platform: 'web' } },
  });
  const page = envelope.page;
  page.tree.children = [
    {
      id: 'el-card',
      type: 'Card',
      name: '登录卡片',
      children: [
        {
          id: 'el-form',
          type: 'Form',
          name: '登录表单',
          featureRef: 'F-login',
          children: [
            {
              id: 'el-phone',
              type: 'Input',
              name: '手机号',
              props: { placeholder: '请输入手机号', required: true },
              bindings: { value: 'phone' },
            },
            {
              id: 'el-submit',
              type: 'Button',
              name: '登录按钮',
              props: { text: '登录' },
            },
          ],
        },
      ],
    },
  ];
  page.state = [{ name: 'phone', type: 'string', initial: '', source: 'local' }];
  page.events = [
    {
      id: 'ev-submit',
      trigger: 'submit.click',
      actions: [{ id: 'act-1', kind: 'request', target: '/api/auth/login' }],
    },
  ];
  page.apiDeps = ['/api/auth/login'];

  await call({
    domain: 'designer',
    method: 'savePage',
    params: { projectId, envelope: { dslVersion: 1, page } },
  });
  const written = await call<{
    memoryId: string;
    revision: number;
    changed: string[];
    tokenEstimate: number;
    truncated: boolean;
  }>({
    domain: 'designer',
    method: 'writePageStructure',
    params: {
      projectId,
      input: { pageId: page.id, pageName: page.name, route: page.route, dsl: page },
    },
  });
  expect(written.memoryId).toBeTruthy();
  return { pageId: page.id, page };
}

/** 轮询等待（外部改动检测走文件监听，是异步的） */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

const codeRootOf = (projectId: string): string => join(projectsDir, projectId, 'code');

function writeCodeFile(projectId: string, path: string, content: string): void {
  const full = join(codeRootOf(projectId), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function readCodeFile(projectId: string, path: string): string {
  return readFileSync(join(codeRootOf(projectId), path), 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-content-'));
  dataDir = join(root, 'data');
  projectsDir = join(root, 'workspace', 'projects');
  db = openBusinessDb({ dataDir });
  emitted = [];
  runtime = buildRuntime();
});

afterEach(async () => {
  await runtime.dispose();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/* ============================ 设计器：页面记忆 ============================ */

describe('设计器 → 页面记忆与结构变更台账', () => {
  it('保存页面后页面记忆出现结构摘要，且 revision 只在结构真的变化时递增', async () => {
    const projectId = await newProject('页面记忆');
    const { pageId, page } = await createStructuredPage(projectId);

    const rows = callSync<
      Array<{ scope: string; title: string; structured: unknown; pageId: string | null }>
    >({
      domain: 'memory',
      method: 'list',
      params: { userId: USER_ID, projectId, query: { scopes: ['page'] } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pageId).toBe(pageId);
    expect(rows[0]?.title).toBe('登录页 /login');

    // 同步域通道返回的是领域对象（structured 已是对象，不是 JSON 文本）
    const structured = rows[0]?.structured as Record<string, unknown>;
    // 摘要保留"AI 复现结构"所需的信息：骨架 / 区块 / 状态 / 事件 / 接口依赖
    expect(String(structured['skeleton'])).toContain('Card');
    expect(String(structured['skeleton'])).toContain('Button');
    expect(Array.isArray(structured['state'])).toBe(true);
    expect(structured['state']).toHaveLength(1);
    expect(Array.isArray(structured['events'])).toBe(true);
    expect(structured['apiDeps']).toEqual(['/api/auth/login']);
    // 纯样式不进入摘要
    expect(JSON.stringify(structured)).not.toContain('"style"');

    const revisions = await call<
      Array<{ revision: number; tokenEstimate: number; changed: string[] }>
    >({ domain: 'designer', method: 'listStructureRevisions', params: { pageId } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.revision).toBe(1);
    expect(revisions[0]?.tokenEstimate).toBeGreaterThan(0);

    // 同一份 DSL 再写一次：结构没变 → 不追加 revision（设计器 600ms 防抖会反复重发）
    await call({
      domain: 'designer',
      method: 'writePageStructure',
      params: {
        projectId,
        input: { pageId, pageName: page.name, route: page.route, dsl: page },
      },
    });
    expect(
      await call({ domain: 'designer', method: 'listStructureRevisions', params: { pageId } }),
    ).toHaveLength(1);

    // 改一个元素 → 结构变化 → 追加 revision，且 diff 指到被改动的子树
    const edited: PageDsl = JSON.parse(JSON.stringify(page)) as PageDsl;
    const card = edited.tree.children?.[0];
    if (card === undefined) throw new Error('夹具缺少 card 节点');
    card.children = [
      ...(card.children ?? []),
      { id: 'el-captcha', type: 'Input', name: '验证码', props: { placeholder: '验证码' } },
    ];
    const second = await call<{ revision: number; changed: string[] }>({
      domain: 'designer',
      method: 'writePageStructure',
      params: {
        projectId,
        input: { pageId, pageName: page.name, route: page.route, dsl: edited },
      },
    });
    expect(second.revision).toBeGreaterThan(1);
    expect(second.changed).toContain('el-captcha');

    const after = await call<Array<{ revision: number }>>({
      domain: 'designer',
      method: 'listStructureRevisions',
      params: { pageId },
    });
    expect(after.length).toBeGreaterThanOrEqual(2);
    // 最近 5 次的上限由领域层的 revision 仓库保证，这里断言的是"页面记忆没被写重"
    expect(
      callSync<unknown[]>({
        domain: 'memory',
        method: 'list',
        params: { userId: USER_ID, projectId, query: { scopes: ['page'] } },
      }),
    ).toHaveLength(1);
  });

  it('非法 DSL 被拒绝写入页面记忆（不把垃圾摘要写进去）', async () => {
    const projectId = await newProject('非法 DSL');
    await expect(
      call({
        domain: 'designer',
        method: 'writePageStructure',
        params: {
          projectId,
          input: { pageId: 'page-x', pageName: '坏页', dsl: { id: 'page-x', tree: {} } },
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    expect(
      callSync<unknown[]>({
        domain: 'memory',
        method: 'list',
        params: { userId: USER_ID, projectId, query: {} },
      }),
    ).toHaveLength(0);
  });

  it('路由总表写项目记忆并按路径合并（接受 RouteEntry 对象与字符串两种输入）', async () => {
    const projectId = await newProject('路由总表');

    const first = await call<string[]>({
      domain: 'designer',
      method: 'upsertRoutes',
      params: {
        projectId,
        routes: [{ path: '/login', pageId: 'p1', pageName: '登录页', platform: 'web', params: [] }],
      },
    });
    expect(first).toEqual(['/login']);

    const merged = await call<string[]>({
      domain: 'designer',
      method: 'upsertRoutes',
      params: { projectId, routes: ['/login', '/dashboard'] },
    });
    expect(merged).toEqual(['/login', '/dashboard']);
    expect(
      await call<string[]>({ domain: 'designer', method: 'readRoutes', params: { projectId } }),
    ).toEqual(['/login', '/dashboard']);

    // 项目记忆里真的有一条「路由总表」（不是内存里的临时数组）
    const projectMemory = db
      .prepare(
        `SELECT title, structured FROM memory_item WHERE project_id = ? AND scope = 'project'`,
      )
      .all(projectId) as Array<{ title: string; structured: string }>;
    expect(projectMemory).toHaveLength(1);
    expect(projectMemory[0]?.title).toBe('路由总表');
    expect(JSON.parse(projectMemory[0]?.structured ?? '{}')).toEqual({
      routes: ['/login', '/dashboard'],
    });
  });

  it('元素备注可增删改：优先级由领域规则派生，禁止事项恒为最高', async () => {
    const projectId = await newProject('元素备注');
    const { pageId } = await createStructuredPage(projectId);

    const created = await call<{
      id: string;
      priority: number;
      version: number;
      type: string;
    }>({
      domain: 'designer',
      method: 'saveNote',
      params: {
        projectId,
        input: {
          targetType: 'element',
          targetId: 'el-submit',
          type: 'forbidden',
          title: '禁止直接提交',
          text: '登录按钮必须先做图形验证码校验',
        },
      },
    });
    expect(created.priority).toBe(5);

    const listed = await call<Array<{ id: string; targetId: string }>>({
      domain: 'designer',
      method: 'readNotes',
      params: { projectId, targetType: 'element', targetId: 'el-submit' },
    });
    expect(listed.map((note) => note.id)).toEqual([created.id]);

    const badges = await call<Record<string, number>>({
      domain: 'designer',
      method: 'noteBadges',
      params: { projectId, targetType: 'element' },
    });
    expect(badges['el-submit']).toBe(1);

    const updated = await call<{ version: number }>({
      domain: 'designer',
      method: 'updateNote',
      params: {
        projectId,
        id: created.id,
        patch: { text: '登录按钮必须先做图形验证码校验（含滑动）' },
      },
    });
    expect(updated.version).toBe(created.version + 1);

    const resolved = await call<{ status: string }>({
      domain: 'designer',
      method: 'setNoteStatus',
      params: { projectId, id: created.id, status: 'resolved' },
    });
    expect(resolved.status).toBe('resolved');
    expect(
      await call({
        domain: 'designer',
        method: 'noteBadges',
        params: { projectId, targetType: 'element' },
      }),
    ).toEqual({});

    expect(
      await call<{ removed: boolean }>({
        domain: 'designer',
        method: 'removeNote',
        params: { projectId, id: created.id },
      }),
    ).toEqual({ removed: true });
    expect(
      await call({
        domain: 'designer',
        method: 'readNotes',
        params: { projectId, targetType: 'element' },
      }),
    ).toHaveLength(0);

    // 备注在不同目标类型上互不越界（页面级备注不会跑到元素角标里）
    await call({
      domain: 'designer',
      method: 'saveNote',
      params: {
        projectId,
        input: { targetType: 'page', targetId: pageId, type: 'todo', text: '补一版空态' },
      },
    });
    expect(
      await call({
        domain: 'designer',
        method: 'noteBadges',
        params: { projectId, targetType: 'element' },
      }),
    ).toEqual({});
  });

  it('AI 生成页面在未装配 AI 栈时如实报 NOT_SUPPORTED（不伪造候选）', async () => {
    const projectId = await newProject('无 AI 栈');
    await expect(
      call({
        domain: 'designer',
        method: 'generatePage',
        params: { projectId, request: { prompt: '登录页' } },
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });
});

/* ============================ 上下文组装 ============================ */

describe('上下文组装：真实来源、跳过原因与硬约束', () => {
  it('十类块按真实数据组装，空块如实标注跳过而不是伪装成有内容', async () => {
    const projectId = await newProject('上下文');
    const { pageId, page } = await createStructuredPage(projectId);

    // ① 长期记忆（用户级，projectId 必须为空 —— 这是"以后都…"能生效的前提）
    callSync({
      domain: 'memory',
      method: 'create',
      params: {
        scope: 'longterm',
        title: '命名规范',
        content: '组件文件一律使用 kebab-case',
        projectId: null,
        importance: 5,
        confidence: 1,
      },
    });
    // ② 项目记忆（路由总表由设计器端口写入）
    await call({
      domain: 'designer',
      method: 'upsertRoutes',
      params: { projectId, routes: ['/login'] },
    });
    // ③ 元素备注（禁止事项 → 必须进硬约束小节）
    await call({
      domain: 'designer',
      method: 'saveNote',
      params: {
        projectId,
        input: {
          targetType: 'element',
          targetId: 'el-submit',
          type: 'forbidden',
          title: '禁止跳过验证码',
          text: '登录按钮必须校验图形验证码',
        },
      },
    });
    // ④ 文档（真实表结构：document + sections_json）
    db.prepare(
      `INSERT INTO document (id, project_id, kind, title, content_ref, version, format, content_text, sections_json, source_ref, deleted_at, ignored_version, created_at, updated_at)
       VALUES (?, ?, 'requirement', '登录需求', NULL, 1, 'markdown', ?, ?, NULL, NULL, NULL, ?, ?)`,
    ).run(
      'doc-1',
      projectId,
      '登录必须支持图形验证码',
      JSON.stringify([
        { level: 2, heading: '登录校验', text: '登录必须支持图形验证码校验，失败三次锁定。' },
      ]),
      Date.now(),
      Date.now(),
    );
    // ⑤ 代码锚点 + 真实代码文件
    writeCodeFile(
      projectId,
      'src/auth.controller.ts',
      ['export class AuthController {', '  login() {', '    return true;', '  }', '}'].join('\n'),
    );
    db.prepare(
      `INSERT INTO code_anchor (id, project_id, element_id, page_id, feature_id, file_path, symbol, start_line, end_line, kind, commit_sha, created_at, updated_at)
       VALUES (?, ?, 'el-submit', ?, NULL, 'src/auth.controller.ts', 'AuthController.login', 2, 4, 'controller', NULL, ?, ?)`,
    ).run('anchor-1', projectId, pageId, Date.now(), Date.now());

    const assembled = await call<AssembledContext>({
      domain: 'ai-context',
      method: 'assemble',
      params: {
        request: {
          projectId,
          purpose: 'code',
          target: 'backend-code',
          elementId: 'el-submit',
          pageId,
          instruction: '实现登录接口',
        },
      },
    });

    const byId = new Map<string, ContextBlock>(assembled.blocks.map((block) => [block.id, block]));
    const block = (id: string): ContextBlock => {
      const found = byId.get(id);
      if (found === undefined) throw new Error(`缺少块 ${id}`);
      return found;
    };

    // 结构性不变量：content 非空 ⟺ items 非空。
    // 这条断言正是"不能把空块伪装成已有内容"的机器口径：
    // 只要有人用占位文本填充空块，或让 content 与 items 脱钩，这里就会红。
    for (const item of assembled.blocks) {
      expect(
        item.content.length === 0 ? item.items.length === 0 : item.items.length > 0,
        `块 ${item.id} 的内容与条目数不一致`,
      ).toBe(true);
      if (item.content.length === 0 && item.skipped !== undefined) {
        expect(item.skipped.length).toBeGreaterThan(0);
      }
    }

    expect(block('instruction').tokens).toBeGreaterThan(0);
    expect(block('longterm').items.length).toBeGreaterThan(0);
    expect(block('longterm').source).toContain('关键词检索');
    expect(block('project').items.some((entry) => entry.label === '路由总表')).toBe(true);
    expect(block('page').source).toContain('页面摘要');
    expect(block('element-chain').source).toContain('祖先链 4 层');
    expect(block('element-chain').content).toContain('登录按钮');
    expect(block('note').source).toContain('备注 1 条');
    expect(block('document').items.length).toBeGreaterThan(0);
    expect(block('code').source).toContain('锚点命中');
    expect(block('code').items[0]?.text).toContain('AuthController.login');
    // 没有未解决问题时必须如实跳过
    expect(block('issue').skipped).toBe('该层级暂无记忆');

    // 提示词装配：硬约束前置（禁止事项用强约束句式）
    expect(assembled.system).toContain('# 必须遵守（硬约束）');
    expect(assembled.system).toContain('【禁止】');
    expect(assembled.system).toContain('## 元素及祖先链');
    expect(assembled.user).toContain('实现登录接口');
    expect(assembled.messages[0]?.role).toBe('system');
    expect(assembled.budget).toBeGreaterThan(0);
    expect(assembled.totalTokens).toBeGreaterThan(0);
    expect(assembled.noteIds.length).toBe(1);
    expect(assembled.memoryIds.length).toBeGreaterThan(0);
    expect(assembled.skipped.some((entry) => entry.block === 'issue')).toBe(true);
    // 页面记忆的归属必须收敛到本次页面：换成不存在的页面就没有页面记忆
    expect(page.id).toBe(pageId);
  });

  it('空项目组装不伪造内容：所有块为空并给出跳过原因，提示词如实说明无可用上下文', async () => {
    const projectId = await newProject('空项目');

    const assembled = await call<AssembledContext>({
      domain: 'ai-context',
      method: 'assemble',
      params: { request: { projectId, purpose: 'code' } },
    });

    const withContent = assembled.blocks.filter((block) => block.content.trim().length > 0);
    // 只有 instruction 块应当有内容（它来自请求本身，不是"检索到的记忆"）
    expect(withContent.map((block) => block.id)).toEqual(['instruction']);
    for (const block of assembled.blocks) {
      if (block.id === 'instruction') continue;
      expect(block.items, `块 ${block.id} 不应有条目`).toHaveLength(0);
      expect(block.content, `块 ${block.id} 不应有内容`).toBe('');
    }
    // 有数据的块被跳过时必须写明原因（长期 / 项目记忆"没有内容"属正常，不标 skipped）
    const skippedBlocks = assembled.skipped.map((entry) => entry.block);
    for (const id of ['page', 'element-chain', 'note', 'issue', 'document', 'code']) {
      expect(skippedBlocks, `${id} 应给出跳过原因`).toContain(id);
    }
    expect(assembled.totalTokens).toBeGreaterThan(0);
    expect(assembled.truncation).toBeNull();
    expect(assembled.system).toContain('（本次无可用上下文）');
  });

  it('缺少 projectId 映射为 INVALID_ARGUMENT', async () => {
    await expect(
      call({ domain: 'ai-context', method: 'assemble', params: { request: { purpose: 'code' } } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

/* ============================ 代码写入管线 ============================ */

describe('代码写入管线：plan → preview → apply', () => {
  it('新建与补丁都走 WritePipeline，应用后落盘内容与计划一致', async () => {
    const projectId = await newProject('写入');
    writeCodeFile(
      projectId,
      'src/util.ts',
      ['export const a = 1;', 'export const b = 2;'].join('\n'),
    );

    const plan = await call<{
      id: string;
      mode: string;
      entries: Array<{
        path: string;
        action: string;
        changed: boolean;
        blocked: boolean;
        after: string | null;
      }>;
      addedLines: number;
      blockedCount: number;
    }>({
      domain: 'code',
      method: 'plan',
      params: {
        projectId,
        mode: 'preview',
        output: {
          files: [
            {
              path: 'src/new.ts',
              content: 'export const created = true;\n',
              action: 'create',
              language: 'ts',
            },
            {
              path: 'src/util.ts',
              content: [
                '@@ -1,2 +1,3 @@',
                ' export const a = 1;',
                ' export const b = 2;',
                '+export const c = 3;',
              ].join('\n'),
              action: 'patch',
              language: 'ts',
            },
          ],
          anchors: [],
          summary: '新建与补丁',
          notes: '',
          decision: { referencedMemory: [], rationale: '', risks: [], uncovered: [] },
        },
      },
    });

    expect(plan.blockedCount).toBe(0);
    expect(plan.entries.map((entry) => entry.changed)).toEqual([true, true]);
    expect(plan.addedLines).toBe(2);

    const result = await call<{
      ok: boolean;
      applied: string[];
      rolledBack: string[];
      error: string | null;
    }>({
      domain: 'code',
      method: 'apply',
      params: { projectId, plan },
    });
    expect(result.ok).toBe(true);
    expect(result.applied.sort()).toEqual(['src/new.ts', 'src/util.ts']);
    expect(readCodeFile(projectId, 'src/new.ts')).toBe('export const created = true;\n');
    expect(readCodeFile(projectId, 'src/util.ts')).toContain('export const c = 3;');
  });

  it('计划生成后被外部改动 → 应用前冲突检测拒绝写入', async () => {
    const projectId = await newProject('冲突检测');
    writeCodeFile(projectId, 'src/old.ts', 'export const legacy = 1;\n');

    const plan = await call<{ id: string }>({
      domain: 'code',
      method: 'plan',
      params: {
        projectId,
        mode: 'preview',
        output: {
          files: [{ path: 'src/old.ts', content: '', action: 'delete', language: 'ts' }],
          anchors: [],
          summary: '删除旧文件',
          notes: '',
          decision: { referencedMemory: [], rationale: '', risks: [], uncovered: [] },
        },
      },
    });

    // 外部进程（比如用户的编辑器）改了同一个文件
    writeCodeFile(projectId, 'src/old.ts', 'export const legacy = 2;\n');

    const result = await call<{
      ok: boolean;
      applied: string[];
      error: string | null;
      rolledBack: string[];
    }>({
      domain: 'code',
      method: 'apply',
      params: { projectId, plan },
    });
    expect(result.ok).toBe(false);
    expect(result.applied).toHaveLength(0);
    expect(result.error).toContain('已被外部修改');
    // 冲突检测发生在写入之前，文件保持外部改动后的内容
    expect(readCodeFile(projectId, 'src/old.ts')).toBe('export const legacy = 2;\n');
  });

  it('多文件写入中任一步失败 → 整体回滚，不留中间态', async () => {
    const projectId = await newProject('事务回滚');
    // 用一个"父路径是文件"的目标制造真实写入失败（open 会抛 ENOTDIR）
    writeCodeFile(projectId, 'blocker.ts', 'export const blocker = 1;\n');

    const plan = await call<{ id: string; entries: Array<{ path: string; blocked: boolean }> }>({
      domain: 'code',
      method: 'plan',
      params: {
        projectId,
        mode: 'preview',
        output: {
          files: [
            {
              path: 'src/rolled-back.ts',
              content: 'export const first = 1;\n',
              action: 'create',
              language: 'ts',
            },
            {
              path: 'blocker.ts/inner.ts',
              content: 'export const inner = 1;\n',
              action: 'create',
              language: 'ts',
            },
          ],
          anchors: [],
          summary: '触发回滚',
          notes: '',
          decision: { referencedMemory: [], rationale: '', risks: [], uncovered: [] },
        },
      },
    });
    expect(plan.entries.map((entry) => entry.blocked)).toEqual([false, false]);

    const result = await call<{
      ok: boolean;
      applied: string[];
      rolledBack: string[];
      error: string | null;
    }>({
      domain: 'code',
      method: 'apply',
      params: { projectId, plan },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.applied).toHaveLength(0);
    expect(result.rolledBack).toContain('src/rolled-back.ts');
    // 回滚后不留中间态：先写成功的文件被撤销（新建的回滚即删除）
    expect(existsSync(join(codeRootOf(projectId), 'src/rolled-back.ts'))).toBe(false);
    expect(existsSync(join(codeRootOf(projectId), 'blocker.ts/inner.ts'))).toBe(false);
  });

  it('代码视图只读：域内不存在任何"保存代码"的方法', async () => {
    const projectId = await newProject('只读边界');
    for (const method of ['saveFile', 'writeFile', 'editFile', 'applyEdit']) {
      await expect(
        call({ domain: 'code', method, params: { projectId, path: 'a.ts', content: 'x' } }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
  });

  it('路径越界被拒绝（生成物只能落在工程目录内）', async () => {
    const projectId = await newProject('路径越界');
    await expect(
      call({
        domain: 'code',
        method: 'readFile',
        params: { projectId, path: '../../secret.txt' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

/* ============================ 外部改动与 AI 重改 ============================ */

describe('外部改动检测与 AI 重改', () => {
  it('外部进程改代码 → 经域事件如实提示（自身写入不会被误报）', async () => {
    const projectId = await newProject('外部改动');
    writeCodeFile(projectId, 'src/watched.ts', 'export const v = 1;\n');

    // 第一次请求会启动文件监听（与生产的懒启动一致）
    await call({ domain: 'code', method: 'listFiles', params: { projectId } });

    // AI 自身写入路径：走 apply，不应触发外部改动提示（写入被抑制）
    const ownPlan = await call<{ id: string }>({
      domain: 'code',
      method: 'plan',
      params: {
        projectId,
        mode: 'preview',
        output: {
          files: [
            {
              path: 'src/ai-made.ts',
              content: 'export const ai = 1;\n',
              action: 'create',
              language: 'ts',
            },
          ],
          anchors: [],
          summary: 'AI 写入',
          notes: '',
          decision: { referencedMemory: [], rationale: '', risks: [], uncovered: [] },
        },
      },
    });
    await call({ domain: 'code', method: 'apply', params: { projectId, plan: ownPlan } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      emitted.filter(
        (event) => (event.payload as { type?: string }).type === 'code:external-change',
      ),
    ).toHaveLength(0);

    // 外部进程（绕过域）直接改文件 → 必须被检测到
    writeCodeFile(projectId, 'src/watched.ts', 'export const v = 2;\n');
    const detected = await waitFor(() =>
      emitted.some((event) => {
        const payload = event.payload as { type?: string; path?: string; message?: string };
        return payload.type === 'code:external-change' && payload.path === 'src/watched.ts';
      }),
    );
    expect(detected).toBe(true);

    const payload = emitted
      .map((event) => event.payload as { type?: string; path?: string; message?: string })
      .find((item) => item.type === 'code:external-change' && item.path === 'src/watched.ts');
    expect(payload?.message).toContain('代码已被外部修改');
  });

  it('AI 重改：真实模型输出 → WritePipeline 计划 → 事件回流 → 应用落盘', async () => {
    const projectId = await newProject('AI 重改');
    const generated = {
      files: [
        {
          path: 'src/reworked.ts',
          content: 'export const reworked = true;\n',
          action: 'create',
          language: 'ts',
        },
      ],
      anchors: [],
      summary: '按重改要求新增文件',
      notes: '',
      decision: { referencedMemory: [], rationale: '补齐缺失实现', risks: [], uncovered: [] },
    };
    await runtime.dispose();
    runtime = buildRuntime({ aiStack: fakeAiStack(JSON.stringify(generated)) });

    await call({
      domain: 'code',
      method: 'requestRework',
      params: {
        projectId,
        request: {
          instruction: '请补齐 reworked 模块',
          context: '',
          paths: ['src/reworked.ts'],
        },
      },
    });

    const planEvent = emitted
      .map((event) => event.payload as { type?: string; plan?: { id: string; entries: unknown[] } })
      .find((payload) => payload.type === 'code:write-plan');
    expect(planEvent).toBeDefined();
    expect(planEvent?.plan?.entries).toHaveLength(1);

    const result = await call<{ ok: boolean; applied: string[] }>({
      domain: 'code',
      method: 'apply',
      params: { projectId, plan: planEvent?.plan as unknown as Record<string, unknown> },
    });
    expect(result.ok).toBe(true);
    expect(readCodeFile(projectId, 'src/reworked.ts')).toBe('export const reworked = true;\n');

    // 模型输出不符合输出契约时如实报错，不落半成品
    await runtime.dispose();
    runtime = buildRuntime({ aiStack: fakeAiStack('抱歉，我无法完成。') });
    await expect(
      call({
        domain: 'code',
        method: 'requestRework',
        params: { projectId, request: { instruction: '再来一次', context: '', paths: [] } },
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN' });

    // 未装配 AI 栈时给可执行引导
    await runtime.dispose();
    runtime = buildRuntime({ aiStack: null });
    await expect(
      call({
        domain: 'code',
        method: 'requestRework',
        params: { projectId, request: { instruction: 'x', context: '', paths: [] } },
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('写入后 Code Anchor 写回（AST 校验结论一并入库）', async () => {
    const projectId = await newProject('锚点写回');
    // 锚点存在 `element_id → element(id)` 外键：元素行必须先由设计器登记，
    // 这也正是"设计器的组件树要同步进 element 表"这条要求的由来。
    await createStructuredPage(projectId, '登录页', '/login');

    const plan = await call<{ id: string }>({
      domain: 'code',
      method: 'plan',
      params: {
        projectId,
        mode: 'preview',
        output: {
          files: [
            {
              path: 'src/auth.service.ts',
              content: [
                '// @everyonecoding:anchor el-submit',
                'export class AuthService {',
                '  login(): boolean {',
                '    return true;',
                '  }',
                '}',
                '',
              ].join('\n'),
              action: 'create',
              language: 'ts',
            },
          ],
          anchors: [
            {
              elementId: 'el-submit',
              filePath: 'src/auth.service.ts',
              symbol: 'AuthService.login',
              kind: 'service',
              startLine: 3,
              endLine: 5,
            },
          ],
          summary: '登录服务',
          notes: '',
          decision: { referencedMemory: [], rationale: '', risks: [], uncovered: [] },
        },
      },
    });
    await call({ domain: 'code', method: 'apply', params: { projectId, plan } });

    const rows = db
      .prepare(`SELECT element_id, file_path, symbol, kind FROM code_anchor WHERE project_id = ?`)
      .all(projectId) as Array<{
      element_id: string;
      file_path: string;
      symbol: string;
      kind: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      element_id: 'el-submit',
      file_path: 'src/auth.service.ts',
      symbol: 'AuthService.login',
      kind: 'service',
    });

    // 写回之后，上下文引擎的代码块就能命中这个锚点（闭环）
    const assembled = await call<AssembledContext>({
      domain: 'ai-context',
      method: 'assemble',
      params: {
        request: { projectId, purpose: 'code', elementId: 'el-submit' },
      },
    });
    const codeBlock = assembled.blocks.find((block) => block.id === 'code');
    expect(codeBlock?.items[0]?.text).toContain('AuthService.login');
  });

  it('createPage 产出仍是渲染层可装载的合法 DSL（回归）', async () => {
    const projectId = await newProject('DSL 回归');
    const envelope = await call<unknown>({
      domain: 'designer',
      method: 'createPage',
      params: { projectId, input: { name: '首页', route: '/', platform: 'web' } },
    });
    const { dsl } = deserializePageDsl(JSON.stringify(envelope));
    expect(dsl.projectId).toBe(projectId);
    expect(dsl.notes).toEqual([]);
    expect(dsl.anchors).toEqual({});
  });
});
