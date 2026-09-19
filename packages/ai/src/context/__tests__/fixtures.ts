import type {
  ContextCodeHit,
  ContextDocumentSnippet,
  ContextElementNode,
  ContextMemoryHit,
  ContextMemoryPort,
  ContextSources,
  DependencyContract,
} from '../context-types';

/**
 * 上下文引擎测试夹具（不属于产品代码）。
 *
 * 关键点：夹具**照抄真实端口的形状**，而不是简化成"能跑就行"——
 * Wave 3 的教训是夹具与真实实现不一致会让验收项在应用里根本不成立。
 */

export const PROJECT_ID = 'P0000000000000000000000001';
export const USER_ID = 'USER0000000000000000000000';

const NOW = 1_760_000_000_000;

export function memoryHit(
  overrides: Partial<ContextMemoryHit> & { id: string; scope: ContextMemoryHit['scope'] },
): ContextMemoryHit {
  return {
    title: `记忆 ${overrides.id}`,
    content: '内容',
    importance: 3,
    confidence: 1,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 按 scope 装桶的假记忆端口；`total` 用于生成大量记忆做基准测试 */
export function fakeMemoryPort(
  buckets: Partial<Record<ContextMemoryHit['scope'], ContextMemoryHit[]>>,
): ContextMemoryPort {
  return {
    search: ({ scope, limit }) => (buckets[scope] ?? []).slice(0, limit),
    listByScope: ({ scope, limit }) => (buckets[scope] ?? []).slice(0, limit),
  };
}

/** 1000 条项目记忆 + 真实打分排序（模拟双路召回的排序成本） */
export function bigMemoryPort(total = 1000): ContextMemoryPort {
  const pool: ContextMemoryHit[] = Array.from({ length: total }, (_, index) => ({
    id: `mem-${index}`,
    scope: 'project',
    title: `项目约定 ${index}：命名规范与目录结构`,
    content: '组件名与标识符用英文或拼音，显示文案保留中文；跨包只走单一入口。'.repeat(3),
    importance: (index % 5) + 1,
    confidence: 0.6 + (index % 4) * 0.1,
    updatedAt: NOW - index * 60_000,
  }));

  return {
    search: ({ query, limit }) => {
      const keywords = query
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 0);
      return [...pool]
        .map((hit) => {
          const text = `${hit.title}${hit.content}`.toLowerCase();
          const score = keywords.reduce(
            (sum, keyword) => sum + (text.includes(keyword) ? 1 : 0),
            0,
          );
          return { hit, score: score * 10 + hit.importance * hit.confidence };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.hit);
    },
    listByScope: ({ limit }) => pool.slice(0, limit),
  };
}

export function fakeElementSource(): NonNullable<ContextSources['elements']> {
  const chain: ContextElementNode[] = [
    {
      id: 'el-form',
      type: 'Form',
      name: '登录表单',
      props: { action: '/api/login', method: 'POST' },
    },
    {
      id: 'el-input',
      type: 'Input',
      name: '账号输入框',
      props: { name: 'account', required: true, rules: ['length>=6'] },
      bindings: { value: 'form.account' },
    },
    {
      id: 'el-btn',
      type: 'Button',
      name: '登录按钮',
      props: { text: '登录', event: 'onClick' },
      bindings: { disabled: 'form.submitting' },
      conditionSummary: 'form.account 不为空',
    },
  ];
  return {
    getElementChain: ({ elementId }) => (elementId === 'el-btn' ? chain : chain.slice(0, 1)),
    getPageSummary: () => ({
      pageId: 'page-login',
      name: '登录页',
      route: '/login',
      platform: 'web',
      state: [
        { name: 'form', type: 'object' },
        { name: 'captcha', type: 'string' },
      ],
      apiDeps: ['api.login'],
    }),
  };
}

export function fakeNoteSource(): NonNullable<ContextSources['notes']> {
  return {
    getNotesForContext: () => [
      {
        id: 'note-2',
        targetType: 'element',
        targetId: 'el-btn',
        type: 'validation',
        typeLabel: '校验要求',
        mustFollow: false,
        priority: 4,
        text: '点击登录前必须校验图形验证码',
        version: 1,
        updatedAt: NOW,
      },
      {
        id: 'note-1',
        targetType: 'element',
        targetId: 'el-btn',
        type: 'forbidden',
        typeLabel: '禁止事项',
        mustFollow: true,
        priority: 5,
        text: '【禁止】不得把验证码明文写入日志',
        version: 2,
        updatedAt: NOW,
      },
    ],
    noteIdsUpdatedSince: () => ['note-2'],
  };
}

export function fakeDocumentPort(): NonNullable<ContextSources['documents']> {
  const snippets: ContextDocumentSnippet[] = [
    {
      id: 'doc-1',
      documentId: 'D1',
      title: '需求文档',
      kind: 'requirement',
      heading: '登录功能',
      content: '用户输入账号与图形验证码，校验通过后签发会话令牌。',
      score: 0.8,
    },
    {
      id: 'doc-2',
      documentId: 'D2',
      title: '技术文档',
      kind: 'techdoc',
      heading: '鉴权设计',
      content: '登录接口 POST /api/login，返回 accessToken 与 refreshToken。',
      score: 0.6,
    },
  ];
  return { searchRelevant: ({ limit }) => snippets.slice(0, limit) };
}

export function fakeCodePort(): NonNullable<ContextSources['code']> {
  const hits: ContextCodeHit[] = [
    {
      anchorId: 'anchor-el-btn',
      filePath: 'src/modules/auth/auth.controller.ts',
      symbol: 'AuthController.login',
      kind: 'controller',
      startLine: 12,
      endLine: 30,
      language: 'ts',
      snippet:
        'export class AuthController {\n  async login(dto: LoginDto) { return this.service.login(dto); }\n}',
      score: 0.9,
    },
    {
      anchorId: 'anchor-other',
      filePath: 'src/modules/user/user.service.ts',
      symbol: 'UserService.findByAccount',
      kind: 'service',
      startLine: 40,
      endLine: 52,
      language: 'ts',
      snippet: 'async findByAccount(account: string) { return this.repo.findOne({ account }); }',
      score: 0.4,
    },
  ];
  return { findRelated: ({ limit }) => hits.slice(0, limit) };
}

export function fakeContracts(): DependencyContract[] {
  return [
    {
      name: 'CaptchaService',
      kind: 'service',
      filePath: 'src/modules/auth/captcha.service.ts',
      summary: 'verify(token: string, answer: string): Promise<boolean>',
      types: ['interface CaptchaResult { ok: boolean; reason?: string }'],
    },
    {
      name: 'UserRepo',
      kind: 'repo',
      filePath: 'src/modules/user/user.repo.ts',
      summary: 'findByAccount(account: string): Promise<UserEntity | null>',
    },
  ];
}

/** 完整端口集合 */
export function fullSources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    memory: fakeMemoryPort({
      longterm: [
        memoryHit({ id: 'lt-1', scope: 'longterm', title: '以后都用 TypeScript', importance: 5 }),
      ],
      project: [
        memoryHit({
          id: 'pj-1',
          scope: 'project',
          title: '技术栈：Tauri 2 + React 18',
          importance: 5,
        }),
      ],
      feature: [memoryHit({ id: 'ft-1', scope: 'feature', title: '登录功能职责', importance: 4 })],
      page: [memoryHit({ id: 'pg-1', scope: 'page', title: '登录页交互流程', importance: 4 })],
      issue: [memoryHit({ id: 'is-1', scope: 'issue', title: '验证码过期未处理', importance: 5 })],
    }),
    notes: fakeNoteSource(),
    elements: fakeElementSource(),
    documents: fakeDocumentPort(),
    code: fakeCodePort(),
    clock: () => NOW,
    ...overrides,
  };
}
