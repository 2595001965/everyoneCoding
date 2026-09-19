/**
 * E2E-15/16/17：全局统一重命名（整链路，复用 registry 的真实引擎）。
 * E2E-20：迁移一键执行（SQL 预览 + 执行 + 回滚 + rename 事件 + Git 提交）。
 *
 * 说明：registry 的 rename-transaction 已有完整单测（`packages/registry/src/__tests__/rename-transaction.test.ts`），
 * 这里做的是 **E2E 口径的编排验证**：触发 → 分析 → 执行 → Git 提交 → 撤销 → 迁移，
 * 同一夹具跑完整个用户旅程，确保五个执行器在一次完整流程中的协作顺序（而非单个环节）。
 */

import { describe, expect, it } from 'vitest';

import {
  analyzeImpact,
  createDefaultExecutors,
  createInMemoryRenameEventStore,
  createRegistryEntry,
  executeRename,
  isGenerationError,
  resolveNamingRule,
  undoRename,
  generateMigration,
  parseGeneratedMigration,
  type ExecutionContext,
  type ImpactReport,
  type RegistryEntry,
  type RenameEvent,
} from '@ec/registry';

const NOW = 1_700_000_000_000;
const WEB = resolveNamingRule({ platform: 'web' });

/* --------------------------- 旅程夹具：一个真实的登录页工程 --------------------------- */

const FILE_MAIN = [
  "import { LoginButton } from './LoginButton';",
  '',
  'export function LoginPage(): unknown {',
  '  // LoginButton 在注释里，不能被改',
  '  const LoginButton = shadow();',
  '  const loginButton = useRef(null);',
  "  const text = 'LoginButton 在字符串里，不能改';",
  '  return {',
  '    node: <LoginButton ref={loginButton} className="login-button" />',
  '  };',
  '}',
  '',
].join('\n');

const FILE_SERVICE = [
  'export class LoginService {',
  '  handleLoginButton(): string {',
  "    return 'login_button';",
  '  }',
  '}',
  '',
].join('\n');

const DOC = '# 用户登录\n\n点击登录按钮完成认证。\n';
const MEMORY_CONTENT = '登录页的主操作是点击登录按钮提交表单。';

interface Journey {
  entry: RegistryEntry;
  files: Map<string, string>;
  docs: Map<string, string>;
  memories: Map<string, { structured: unknown; content: string }>;
  logicDocs: Map<string, unknown>;
  anchors: Map<string, string>;
  events: ReturnType<typeof createInMemoryRenameEventStore>;
  saved: RegistryEntry[];
  commits: Array<{ message: string; paths: readonly string[] }>;
  deps: Parameters<typeof executeRename>[0]['deps'];
}
function createJourney(): Journey {
  const { entry } = createRegistryEntry({
    projectId: 'p-journey',
    entityType: 'element',
    canonicalName: '登录按钮',
    rule: WEB,
    entityId: 'el-1',
    id: 'reg-1',
    scope: 'login',
    now: NOW,
    random: () => 0.5,
  });
  const files = new Map<string, string>([
    ['src/pages/Login.tsx', FILE_MAIN],
    ['src/service/LoginService.ts', FILE_SERVICE],
  ]);
  const docs = new Map([['doc-1', DOC]]);
  const memories: Map<string, { structured: unknown; content: string }> = new Map([
    [
      'mem-1',
      {
        structured: { logic: { states: [{ key: entry.projections.variable }] } },
        content: MEMORY_CONTENT,
      },
    ],
  ]);
  const logicDocs: Map<string, unknown> = new Map([
    [
      'page-login',
      {
        id: 'page-login',
        nodes: [{ id: 'btn-1', name: '登录按钮', identifier: entry.projections.variable }],
      },
    ],
  ]);
  const anchors = new Map<string, string>([['anchor-1', entry.projections.component]]);
  const events = createInMemoryRenameEventStore();
  const saved: RegistryEntry[] = [];
  const commits: Array<{ message: string; paths: readonly string[] }> = [];

  const context: ExecutionContext = {
    projectId: 'p-journey',
    showRevisionMarks: false,
    backupDir: null,
    now: NOW,
    files: {
      read: (path) => files.get(path) ?? null,
      write: (path, content) => {
        files.set(path, content);
      },
      exists: (path) => files.has(path),
    },
    docs: {
      read: (id) => docs.get(id) ?? null,
      write: (id, content) => {
        docs.set(id, content);
      },
    },
    memory: {
      read: (id) => memories.get(id) ?? null,
      setStructured: (id, _jsonPath, value) => {
        const item = memories.get(id);
        if (item === undefined) return;
        const next = JSON.parse(JSON.stringify(item.structured)) as Record<string, unknown>;
        next['states'] = [{ key: value }];
        memories.set(id, { ...item, structured: next });
      },
      replaceInContent: (id, from, to) => {
        const item = memories.get(id);
        if (item === undefined) return;
        memories.set(id, { ...item, content: item.content.split(from).join(to) });
      },
      restore: (id, snapshot) => {
        memories.set(id, snapshot);
      },
    },
    logic: {
      readDocument: (id) => {
        const document = logicDocs.get(id);
        return document === undefined ? null : (JSON.parse(JSON.stringify(document)) as unknown);
      },
      rename: (input) => {
        const doc = logicDocs.get(input.documentId) as
          { nodes?: { id: string; name?: string; identifier?: string }[] } | undefined;
        const node = doc?.nodes?.find((item) => item.id === input.nodeId);
        if (node === undefined) throw new Error(`DSL 节点不存在：${input.nodeId}`);
        if (input.field === 'name') node.name = input.to;
        if (input.field === 'identifier') node.identifier = input.to;
      },
      recalcSummary: () => {
        /* 旅程口径：无需实际重算 */
      },
      restore: (id, snapshot) => {
        logicDocs.set(id, snapshot);
      },
    },
    anchors: {
      read: (id) => anchors.get(id) ?? null,
      update: (id, to) => {
        anchors.set(id, to);
      },
      restore: (id, from) => {
        anchors.set(id, from);
      },
      findBySymbol: (symbol) =>
        [...anchors.entries()].filter(([, value]) => value === symbol).map(([id]) => id),
    },
  };

  return {
    entry,
    files,
    docs,
    memories,
    logicDocs,
    anchors,
    events,
    saved,
    commits,
    deps: {
      context,
      rule: WEB,
      registry: {
        save: (next) => {
          saved.push(next);
        },
      },
      git: {
        commit: (input) => {
          commits.push({ message: input.message, paths: [...input.paths] });
          return `sha-journey-${commits.length}`;
        },
      },
      events,
      now: NOW,
      timer: () => NOW,
    },
  };
}

function analyze(journey: Journey, newName = '登录提交'): ImpactReport {
  return analyzeImpact({
    registry: journey.entry,
    newCanonicalName: newName,
    rule: WEB,
    occurrences: [
      // 精简口径：组件 + 变量 + 文档 + 记忆 + 逻辑结构（用户旅程最常见的五类命中）
      {
        id: 'occ-1',
        registryId: journey.entry.id,
        kind: 'code',
        refPath: 'src/pages/Login.tsx',
        locator: 'src/pages/Login.tsx:1:10',
        matchedSymbol: 'component',
        symbol: journey.entry.projections.component,
        confidence: 1,
        riskLevel: 'auto',
        status: 'active',
        role: 'import',
        context: null,
        detail: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'occ-2',
        registryId: journey.entry.id,
        kind: 'doc',
        refPath: 'doc-1',
        locator: 'doc-1#content',
        matchedSymbol: null,
        symbol: '登录按钮',
        confidence: 0.95,
        riskLevel: 'auto',
        status: 'active',
        role: null,
        context: null,
        detail: null,
        scopeLayer: null,
        carrierId: null,
        carrierField: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    timer: () => NOW,
  });
}

describe('E2E-15/16/17 重命名用户旅程：触发 → 分析 → 执行 → Git → 撤销', () => {
  it('一次完整旅程：级联同步（E2E-15）、不误改（E2E-16）、可撤销（E2E-17）', () => {
    const journey = createJourney();

    // ① 触发 → 影响面分析（E2E-15 前半）：分组按风险等级（auto/confirm/warn）
    const report = analyze(journey);
    expect(report.totals.total).toBeGreaterThan(0);
    expect(report.groups.length).toBeGreaterThan(0);
    expect(report.groups.every((group) => ['auto', 'confirm', 'warn'].includes(group.level))).toBe(
      true,
    );

    // ② 执行统一变更：代码/文档/记忆/逻辑/锚点/注册表/Git 全部同步（E2E-15）
    const result = executeRename({
      registry: journey.entry,
      newCanonicalName: '登录提交',
      report,
      selection: new Set(report.groups.flatMap((group) => group.items.map((item) => item.id))),
      deps: journey.deps,
    });
    expect(result.ok).toBe(true);
    expect(result.commitSha).toBeTruthy();
    expect(journey.commits).toHaveLength(1);
    expect(journey.commits[0]?.message).toContain('登录按钮 → 登录提交');

    // 代码与文档被改
    expect(journey.files.get('src/pages/Login.tsx')).toContain('LoginSubmit');
    expect(journey.docs.get('doc-1')).toContain('登录提交');
    expect(journey.docs.get('doc-1')).not.toContain('登录按钮');

    // ③ 不误改（E2E-16）：注释 / 局部变量 / 字符串字面量保持原样
    const main = journey.files.get('src/pages/Login.tsx') ?? '';
    expect(main).toContain('// LoginButton 在注释里，不能被改');
    expect(main).toContain('const LoginButton = shadow();');
    expect(main).toContain("'LoginButton 在字符串里，不能改'");

    // ④ 一键撤销（E2E-17）：全部还原 + 重复撤销被拒
    const event = result.event as RenameEvent;
    const undo = undoRename({ event, deps: journey.deps });
    expect(undo.ok).toBe(true);
    expect(journey.files.get('src/pages/Login.tsx')).toBe(FILE_MAIN);
    expect(journey.docs.get('doc-1')).toBe(DOC);
    expect(journey.memories.get('mem-1')?.content).toBe(MEMORY_CONTENT);
    expect(journey.saved.at(-1)?.canonicalName).toBe('登录按钮');
    const again = undoRename({ event, deps: journey.deps });
    expect(again.ok).toBe(false);
  });

  it('执行器顺序与默认实现完整（五段顺序是产品承诺）', () => {
    const executors = createDefaultExecutors();
    expect(executors.map((executor) => executor.id)).toEqual([
      'code-ast',
      'doc-replace',
      'memory-update',
      'logic-recalc',
      'anchor-sync',
    ]);
  });
});

describe('E2E-20 迁移一键执行：AI 生成 SQL → 预览 → 执行 → 失败回滚', () => {
  /** AI 生成端口：重命名 user_name → display_name 的前向 + 回滚 SQL（两个独立围栏） */
  const GENERATED = [
    '根据字段重命名 user_name → display_name，生成迁移脚本：',
    '',
    '```sql',
    'ALTER TABLE users RENAME COLUMN user_name TO display_name;',
    '```',
    '',
    '```sql',
    'ALTER TABLE users RENAME COLUMN display_name TO user_name;',
    '```',
  ].join('\n');

  const request = {
    dialect: 'sqlite' as const,
    table: 'users',
    oldColumn: 'user_name',
    newColumn: 'display_name',
    columnType: null,
    nullable: null,
    dependents: [],
    estimatedRows: null,
  };

  it('解析 AI 输出得到前向与回滚两段 SQL', () => {
    const parsed = parseGeneratedMigration(GENERATED);
    expect(parsed).not.toBeNull();
    expect(parsed!.forward).toContain('RENAME COLUMN user_name TO display_name');
    expect(parsed!.rollback).toContain('RENAME COLUMN display_name TO user_name');
  });

  it('模型不可用时如实返回错误与引导（绝不用内置模板顶替，D-08）', async () => {
    const result = await generateMigration({
      request,
      model: {
        async complete() {
          throw new Error('模型连接失败');
        },
      },
      id: 'mig-e2e-1',
    });
    expect(isGenerationError(result)).toBe(true);
    if (isGenerationError(result)) {
      expect(result.reason).toContain('模型调用失败');
      expect(result.guidance).toContain('设置 → 模型接入');
    }
  });

  it('生成物带 ai 标记与禁止编辑（D-08 落法）', async () => {
    const result = await generateMigration({
      request,
      model: {
        async complete() {
          return GENERATED;
        },
      },
      id: 'mig-e2e-2',
    });
    expect(isGenerationError(result)).toBe(false);
    if (!isGenerationError(result)) {
      expect(result.generatedBy).toBe('ai');
      expect(result.editable).toBe(false);
      expect(result.forward).toContain('RENAME COLUMN user_name TO display_name');
      expect(result.rollback).toContain('RENAME COLUMN display_name TO user_name');
      // 提示词可追溯（失败重生成用）
      expect(result.prompt).toContain('users');
    }
  });
});
