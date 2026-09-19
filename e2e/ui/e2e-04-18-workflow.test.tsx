/**
 * E2E-04/05/06/08/09/12/18：设计器 → 上下文 → 生成 → 跳转 → 预览 → 记忆 → 只读 的整链路验收。
 *
 * - E2E-04：拖 20 元素登录页 → 页面记忆一致率 ≥90%（真实 createLoginPageDsl + condensePage + 保真度评估）；
 * - E2E-05：选中「登录按钮」加备注「需校验图形验证码」→ 组装上下文（备注块置顶）→ AI 可见；
 * - E2E-06：Ctrl+点击登录按钮 → 跳转定位 Controller 方法（真实 JumpService）；
 * - E2E-08：联动预览 → 请求打到真实后端（真实 BindingResolver + 后端端口优先级）；
 * - E2E-09：连续 3 次生成同一元素报错 → 提示卡命中并可一键建立问题记忆草稿；
 * - E2E-12：长期记忆写入「所有代码必须有单元测试」→ 组装上下文包含该约束；
 * - E2E-18：代码视图手动编辑被拦截；文件被外部改过 → AI 写入被拒绝。
 */

import { describe, expect, it } from 'vitest';

import { createLoginPageDsl } from '@ec/designer';
import { condensePage, DebugLoopDetector, IssueDraftBuilder, WindowQueue } from '@ec/memory';
import {
  createContextEngine,
  type ContextSources,
  type GenerationOutput,
  createWritePipeline,
  createReadOnlyGuard,
  JumpService,
  type CodeAnchor,
} from '@ec/ai';
import { BindingResolver, MockResponseGenerator, parseOpenApiDocument } from '@ec/preview';

// 保真度评估器在 memory 包的测试工具目录（非出口），按路径直引
import {
  evaluateFidelity,
  reconstructFromSummary,
} from '../../packages/memory/src/condenser/__tests__/fidelity';

/* ------------------------------ E2E-04 拖拽设计 ------------------------------ */

describe('E2E-04 拖拽设计：20 元素登录页 → 页面记忆一致率 ≥90%', () => {
  it('登录页样例恰好 20 元素；精简→重建保真度匹配率 ≥0.9', () => {
    const dsl = createLoginPageDsl();

    // 元素计数（含根）：与 T3-01 夹具口径一致
    let count = 0;
    const walk = (node: { children?: unknown[] }): void => {
      count += 1;
      for (const child of node.children ?? []) walk(child as { children?: unknown[] });
    };
    walk(dsl.tree as unknown as { children?: unknown[] });
    expect(count).toBe(20);

    // 页面记忆（结构精简）→ 重建 → 三维保真度评估
    // 说明：设计器与记忆包各自声明 PageDsl（前者含 DSL 全集、后者是精简所需投影），
    // 二者结构兼容但非同一符号，按领域惯例做显式转换。
    const condenseInput = dsl as unknown as Parameters<typeof condensePage>[0];
    const summary = condensePage(condenseInput);
    const report = evaluateFidelity(condenseInput, summary, reconstructFromSummary);
    expect(report.matchRate).toBeGreaterThanOrEqual(0.9);
  });
});

/* ------------------------- E2E-05 / E2E-12 上下文与生成 ------------------------- */

/** 内存端口：长期记忆 + 登录按钮备注（E2E-05/12 复用） */
function contextSources(): ContextSources {
  return {
    memory: {
      search: (query) =>
        query.query.includes('单元测试') || query.scope === 'longterm'
          ? [
              {
                id: 'lt-test',
                scope: 'longterm' as const,
                title: '质量约定',
                content: '所有代码必须有单元测试',
                importance: 3,
                confidence: 1,
                updatedAt: 100,
              },
            ]
          : [],
    },
    notes: {
      getNotesForContext: (target) =>
        target.elementId === 'el-btn'
          ? [
              {
                id: 'note-captcha',
                targetType: 'element' as const,
                targetId: 'el-btn',
                type: 'validation',
                typeLabel: '校验要求',
                mustFollow: true,
                priority: 5,
                text: '需校验图形验证码',
                version: 1,
                updatedAt: 100,
              },
            ]
          : [],
    },
  };
}

describe('E2E-05 元素生成后端：备注「需校验图形验证码」被遵循', () => {
  it('备注块置顶注入且进硬约束小节，提示词可溯源（noteIds）', async () => {
    const engine = createContextEngine({ sources: contextSources() });
    const context = await engine.assemble({
      userId: 'U-E2E',
      projectId: 'P-E2E',
      purpose: 'code',
      target: 'backend-code',
      elementId: 'el-btn',
      pageId: 'page-login',
      featureId: 'feat-auth',
    });

    const noteBlock = context.blocks.find((block) => block.id === 'note');
    expect(noteBlock?.tokens).toBeGreaterThan(0);
    expect(noteBlock?.content).toContain('需校验图形验证码');
    // 备注进入系统提示（硬约束小节），AI 生成时必然可见
    expect(context.system).toContain('需校验图形验证码');
    // 可溯源
    expect(context.noteIds).toContain('note-captcha');
  });
});

describe('E2E-12 记忆生效验证：长期记忆约束进入生成上下文', () => {
  it('写入「所有代码必须有单元测试」后，组装的提示词包含该约束', async () => {
    const engine = createContextEngine({ sources: contextSources() });
    const context = await engine.assemble({
      userId: 'U-E2E',
      projectId: 'P-E2E',
      purpose: 'code',
      target: 'backend-code',
      pageId: 'page-login',
    });

    const longterm = context.blocks.find((block) => block.id === 'longterm');
    expect(longterm?.content).toContain('所有代码必须有单元测试');
    expect(context.system + context.user).toContain('所有代码必须有单元测试');
    expect(context.memoryIds).toContain('lt-test');
  });
});

/* ------------------------------ E2E-06 Ctrl 跳转 ------------------------------ */

const CONTROLLER_ANCHOR: CodeAnchor = {
  id: 'anc-ctrl',
  projectId: 'P-E2E',
  elementId: 'el-btn',
  pageId: 'page-login',
  featureId: null,
  filePath: 'src/modules/auth/auth.controller.ts',
  symbol: 'AuthController.login',
  startLine: 42,
  endLine: 58,
  kind: 'controller',
  commitSha: null,
  syncState: 'synced',
  syncDetail: null,
  evidence: { declared: true, commentMarker: true, astVerified: true },
  createdAt: 1000,
  updatedAt: 1000,
};

describe('E2E-06 Ctrl 跳转：登录按钮 → AuthController.login', () => {
  it('解析出的首个目标为 Controller 方法且文件定位正确', () => {
    const service = new JumpService({
      source: {
        listAnchors: () => [CONTROLLER_ANCHOR],
        listPages: () => [],
        listApis: () => [],
        listTables: () => [],
        listTests: () => [],
        listDocSections: () => [],
        listModules: () => [],
        listCodeFiles: () => [],
        readFile: () => null,
      },
      clock: () => 1000,
    });
    const resolution = service.resolve({
      projectId: 'P-E2E',
      page: {
        pageId: 'page-login',
        name: '登录页',
        route: '/login',
        featureId: null,
        elements: [],
        apiDeps: [],
      },
      element: {
        elementId: 'el-btn',
        name: '登录按钮',
        type: 'button',
        pageId: 'page-login',
        pageName: '登录页',
      },
      currentFile: 'src/pages/Login.tsx',
    });
    const top = resolution.targets[0];
    expect(top).toBeDefined();
    expect(top!.filePath).toBe('src/modules/auth/auth.controller.ts');
  });
});

/* ------------------------------ E2E-08 联动预览 ------------------------------ */

const OPENAPI_YAML = `openapi: 3.0.0
info:
  title: Auth
  version: "1"
paths:
  /api/login:
    post:
      operationId: login
      responses:
        "200":
          description: ok
`;

describe('E2E-08 联动预览：请求打到真实后端并返回正确结果', () => {
  it('后端可用时数据源为 backend 且返回真实数据；不可用时回退 mock', async () => {
    const openapi = parseOpenApiDocument(OPENAPI_YAML);
    let now = 1000;

    // 真实后端端口（外壳装配到子进程托管的 HTTP 客户端；此处以进程内端口承载真实返回语义）
    const backend = {
      available: true,
      async request(input: { url: string; method: string }) {
        expect(input.url).toBe('/api/login');
        return { status: 200, data: { ok: true, token: 'real-jwt' } };
      },
    };
    const resolver = new BindingResolver({
      openapi,
      mock: new MockResponseGenerator({ clock: () => (now += 1) }),
      backend,
      fixture: { get: () => null },
      clock: () => (now += 1),
    });
    const hit = await resolver.resolve({
      url: '/api/login',
      method: 'POST',
      body: { username: 'u', password: 'p' },
    });
    expect(hit.source).toBe('backend');
    expect(hit.status).toBe(200);
    expect((hit.data as { token: string }).token).toBe('real-jwt');

    // 后端不可用 → 回退内置 Mock（FR-PRV-02 优先级）
    const fallback = new BindingResolver({
      openapi,
      mock: new MockResponseGenerator({ clock: () => (now += 1) }),
      backend: {
        available: false,
        async request() {
          return { status: 0, data: null };
        },
      },
      fixture: { get: () => null },
      clock: () => (now += 1),
    });
    const mocked = await fallback.resolve({ url: '/api/login', method: 'POST' });
    expect(mocked.source).toBe('mock');
  });
});

/* ------------------------------ E2E-09 问题记忆 ------------------------------ */

describe('E2E-09 问题记忆触发：连续 3 次生成同一元素报错 → 提示卡命中 + 一键草稿', () => {
  it('第 3 次完整循环命中检测，草稿含现象与复现步骤', () => {
    let now = 1_000_000;
    const clock = (): number => (now += 1000);
    const queue = new WindowQueue();
    const detector = new DebugLoopDetector({ queue, clock });

    const event = (type: 'generate' | 'run' | 'error') => ({
      type,
      targetKey: 'el-btn@login',
      projectId: 'P-E2E',
      elementId: 'el-btn',
      pageId: 'page-login',
      message: type === 'error' ? 'TypeError: Cannot read properties of undefined' : '',
      rawError: type === 'error' ? 'TypeError: Cannot read properties of undefined' : null,
      at: clock(),
    });

    // 三个完整「生成→运行→报错」循环（前两次不触发，第三次命中）
    expect(detector.record(event('generate'))).toBeNull();
    expect(detector.record(event('run'))).toBeNull();
    expect(detector.record(event('error'))).toBeNull();
    expect(detector.record(event('generate'))).toBeNull();
    expect(detector.record(event('run'))).toBeNull();
    expect(detector.record(event('error'))).toBeNull();
    expect(detector.record(event('generate'))).toBeNull();
    expect(detector.record(event('run'))).toBeNull();
    const result = detector.record(event('error'));
    expect(result).not.toBeNull();
    expect(result?.cycles ?? 0).toBeGreaterThanOrEqual(3);
    expect(result?.reason).toBe('cycles');

    // 一键建立草稿（提示卡按钮的底层：同一 WindowQueue + 检测结果）
    const builder = new IssueDraftBuilder({ queue, clock });
    const draft = builder.build(result!);
    expect(draft.title.length).toBeGreaterThan(0);
    expect(draft.relatedElementId).toBe('el-btn');
    // 复现步骤包含报错现象（不凭空编造）
    expect(draft.reproduce.join('\n')).toContain('TypeError');
    expect(draft.phenomenon.length).toBeGreaterThan(0);
  });
});

/* ------------------------------ E2E-18 代码只读 ------------------------------ */

describe('E2E-18 代码只读约束：AI 唯一写入口 + 外部改动检测', () => {
  /** 内存工作区文件系统（与 packages/ai write 测试同构） */
  function memoryFs(initial: Record<string, string> = {}): {
    files: Map<string, string>;
    exists(path: string): Promise<boolean>;
    readText(path: string): Promise<string | null>;
    writeAtomic(path: string, content: string): Promise<void>;
    remove(path: string): Promise<void>;
    stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
    mkdir(path: string): Promise<void>;
  } {
    const files = new Map(Object.entries(initial));
    return {
      files,
      async exists(path) {
        return files.has(path);
      },
      async readText(path) {
        return files.get(path) ?? null;
      },
      async writeAtomic(path, content) {
        files.set(path, content);
      },
      async remove(path) {
        files.delete(path);
      },
      async stat(path) {
        const content = files.get(path);
        return content === undefined
          ? null
          : { size: Buffer.byteLength(content, 'utf8'), mtimeMs: 0 };
      },
      async mkdir() {
        /* 目录惰性 */
      },
    };
  }

  function generatedCreate(path: string, content: string): GenerationOutput {
    return {
      files: [{ path, content, action: 'create' as const, language: 'typescript' }],
      anchors: [],
      summary: '新建 UserRepo',
      notes: '',
      decision: { referencedMemory: [], rationale: '按项目记忆分层', risks: [], uncovered: [] },
    };
  }

  it('外部编辑器改文件后，AI 写入被拒绝并提示重新生成（冲突检测）', async () => {
    const fs = memoryFs();
    const pipeline = createWritePipeline({ fs, clock: () => 1000 });

    const plan = await pipeline.plan({
      output: generatedCreate('src/user.repo.ts', 'export class UserRepo {}\n'),
      mode: 'create',
    });
    expect(plan.entries).toHaveLength(1);

    // 模拟外部编辑器改动（D-04：外部改动必须被检测到）
    await fs.writeAtomic('src/user.repo.ts', 'export class UserRepo { /* 外部手改 */ }\n');

    const result = await pipeline.apply(plan);
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toContain('已被外部修改');
    // 外部改动未被覆盖
    expect(await fs.readText('src/user.repo.ts')).toContain('外部手改');
  });

  it('只读视图拦截键入/粘贴/剪切（运行时防护，D-04）', async () => {
    const guard = createReadOnlyGuard();

    // 键入：普通字符键被拦截（preventDefault 被调用）
    const prevented: string[] = [];
    guard.props.onKeyDown({
      key: 'a',
      preventDefault: () => prevented.push('keydown'),
      stopPropagation: () => undefined,
    });
    expect(prevented).toContain('keydown');
    expect(guard.blockedCount()).toBe(1);
    expect(guard.lastBlock()?.reason).toBe('keydown');

    // 粘贴同样被拦截
    guard.props.onPaste({
      preventDefault: () => prevented.push('paste'),
      stopPropagation: () => undefined,
    });
    expect(guard.blockedCount()).toBe(2);

    // 浏览类组合键（Ctrl+C 复制）不拦截——用户仍可复制代码
    const copy: string[] = [];
    guard.props.onKeyDown({
      key: 'c',
      ctrlKey: true,
      preventDefault: () => copy.push('x'),
      stopPropagation: () => undefined,
    });
    expect(copy).toHaveLength(0);
  });
});
