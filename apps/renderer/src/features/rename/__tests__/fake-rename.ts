/**
 * 重命名端口的**内存假实现**（渲染层组件测试专用）。
 *
 * 设计原则（与 Wave 5/6 一致）：**真实引擎 + 假端口**。
 * 端口方法全部委托给 `@ec/registry` 的 browser 入口里的真函数
 * （命名规则、冲突检测、影响面分析、四栏 diff、事务编排、批量规划、迁移预览），
 * 只有"读现状 / 落盘"换成内存 Map —— 因此组件测试里跑的是真实语义，
 * 而不是手搓的返回对象。
 *
 * 夹具要点：
 * - 两个注册表项（「登录按钮」/「注册按钮」），可用于冲突检测；
 * - 四栏齐备（代码 / 文档 / 记忆 / 逻辑结构），覆盖 auto / confirm / warn 三级风险；
 * - `src/pages/Login.tsx` 里**故意**留了一个同名局部变量 `const LoginButton = ...`，
 *   它**不在**出现位置索引里 —— 重命名后该行必须保持原样（E2E-16 的渲染层口径）。
 */

import {
  analyzeImpact,
  buildMigrationPreview,
  buildUnifiedDiff,
  checkName,
  cleanAliases as cleanAliasesOf,
  createRegistryEntry,
  createRenameEvent,
  createRenameTrigger,
  executeBatchRename,
  executeRename,
  parseGeneratedMigration,
  pendingCleanup as pendingCleanupOf,
  planBatchRename,
  planNormalization,
  resolveNamingRule,
  toHistoryEntry,
  undoRename,
  type AliasKind,
  type BatchPlan,
  type BatchRenameResult,
  type ConflictCheckResult,
  type ImpactReport,
  type MigrationExecutionResult,
  type MigrationLogLine,
  type MigrationPreview,
  type Occurrence,
  type OccurrenceKind,
  type ProjectionKind,
  type RegistryEntry,
  type RenameEvent,
  type RenameHistoryEntry,
  type RenameTransactionResult,
  type ResolvedNamingRule,
  type RiskLevel,
  type SymbolTable,
  type UnifiedDiff,
  type UndoResult,
  type ExecutionContext,
  type ExecutorStateSnapshot,
  type RenameEventStore,
} from '@ec/registry';

import {
  createUnavailableRenameApi,
  type BatchPlanRequest,
  type MigrationPlanError,
  type MigrationPlanRequest,
  type RenameApi,
  type RenameTarget,
} from '../rename-api';

/* ------------------------------- 夹具内容 ------------------------------- */

/** 假端口的固定时钟（导出给测试推算相对天数，避免踩 `Date.now()` 抖动） */
export const NOW = Date.UTC(2026, 8, 12, 4, 0, 0);

/** 代码夹具：注意 `const LoginButton` 是**同名局部变量**，索引必须排除它 */
export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'src/pages/Login.tsx': [
    "import { LoginButton } from '../components/LoginButton';",
    '',
    'export function LoginPage(): JSX.Element {',
    '  const LoginButton = usePlaceholder();',
    '  const loginButton = useRef(null);',
    '  return (',
    '    <div className="login-page">',
    '      <LoginButton ref={loginButton} />',
    '      <span>{t("page.login.loginButton.label")}</span>',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n'),
  'src/components/LoginButton.tsx': [
    'export function LoginButton(): JSX.Element {',
    '  return <button className="login-button">登录</button>;',
    '}',
    '',
  ].join('\n'),
  'src/components/RegisterButton.tsx': [
    'export function RegisterButton(): JSX.Element {',
    '  return <button className="register-button">注册</button>;',
    '}',
    '',
  ].join('\n'),
  'src/service/LoginService.ts': [
    'export class LoginService {',
    '  handleLoginButton(): string {',
    "    return 'login_button';",
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/__tests__/login.test.tsx': [
    "it('should render LoginButton', () => {",
    '  /* 断言 */',
    '});',
    '',
  ].join('\n'),
};

export const DOC_FIXTURE_ID = 'doc-tech-1';
export const MEMORY_FIXTURE_ID = 'mem-page-1';
export const LOGIC_FIXTURE_ID = 'page-login';

/* ------------------------------- 状态 ------------------------------- */

export interface FakeRenameState {
  projectId: string;
  projectName: string;
  entries: Map<string, RegistryEntry>;
  occurrences: Map<string, Occurrence[]>;
  files: Map<string, string>;
  docs: Map<string, string>;
  memories: Map<string, { structured: unknown; content: string }>;
  logicDocs: Map<string, unknown>;
  anchors: Map<string, string>;
  events: RenameEvent[];
  migrations: Map<string, MigrationPreview>;
  batchPlans: Map<string, BatchPlan>;
  logListeners: ((line: MigrationLogLine) => void)[];
  cleanedAliases: Set<string>;
}

let occurrenceSeq = 0;

function makeOccurrence(input: {
  registryId: string;
  kind: OccurrenceKind;
  refPath: string;
  locator: string | null;
  symbol: string;
  matchedSymbol: ProjectionKind | null;
  riskLevel: RiskLevel;
  confidence?: number;
  role?: Occurrence['role'];
  scopeLayer?: string | null;
  carrierId?: string | null;
  carrierField?: string | null;
  detail?: string | null;
}): Occurrence {
  occurrenceSeq += 1;
  return {
    id: `occ-${String(occurrenceSeq).padStart(3, '0')}`,
    registryId: input.registryId,
    kind: input.kind,
    refPath: input.refPath,
    locator: input.locator,
    matchedSymbol: input.matchedSymbol,
    symbol: input.symbol,
    confidence: input.confidence ?? 1,
    riskLevel: input.riskLevel,
    status: 'active',
    role: input.role ?? null,
    context: null,
    detail: input.detail ?? null,
    scopeLayer: input.scopeLayer ?? null,
    carrierId: input.carrierId ?? null,
    carrierField: input.carrierField ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** 依据夹具内容与第 N 次出现位置生成一条代码命中（行列号现算，保证可被执行器复核） */
export function codeOccurrence(
  registryId: string,
  refPath: string,
  symbol: string,
  matchedSymbol: ProjectionKind | null,
  riskLevel: RiskLevel,
  occurrenceIndex = 0,
  extra: { role?: Occurrence['role'] } = {},
): Occurrence {
  const content = FIXTURE_FILES[refPath] ?? '';
  let cursor = -1;
  for (let index = 0; index <= occurrenceIndex; index += 1) {
    cursor = content.indexOf(symbol, cursor + 1);
    if (cursor < 0) throw new Error(`夹具错误：${refPath} 中找不到第 ${occurrenceIndex} 次「${symbol}」`);
  }
  const before = content.slice(0, cursor);
  const line = before.split('\n').length;
  const column = cursor - before.lastIndexOf('\n');
  return makeOccurrence({
    registryId,
    kind: 'code',
    refPath,
    locator: `${refPath}:${line}:${column}`,
    symbol,
    matchedSymbol,
    riskLevel,
    role: extra.role ?? 'call',
  });
}

/** 默认夹具状态 */
export function createFakeRenameState(): FakeRenameState {
  occurrenceSeq = 0;
  const projectId = 'proj-1';
  const rule = resolveNamingRule({ platform: 'web' });

  const loginEntry = createRegistryEntry({
    projectId,
    entityType: 'element',
    canonicalName: '登录按钮',
    rule,
    entityId: 'el-login-btn',
    id: 'reg-1',
    scope: 'login',
    now: NOW,
  }).entry;
  const registerEntry = createRegistryEntry({
    projectId,
    entityType: 'element',
    canonicalName: '注册按钮',
    rule,
    entityId: 'el-register-btn',
    id: 'reg-2',
    scope: 'register',
    now: NOW,
  }).entry;
  const p = loginEntry.projections;
  const r = registerEntry.projections;

  const loginOccurrences: Occurrence[] = [
    // 组件名：导入名（index 0）与 JSX 使用处（index 3）；index 2 的同名局部变量**故意不收录**
    codeOccurrence('reg-1', 'src/pages/Login.tsx', p.component, 'component', 'auto', 0, { role: 'import' }),
    codeOccurrence('reg-1', 'src/pages/Login.tsx', p.component, 'component', 'auto', 3, { role: 'jsx-tag' }),
    codeOccurrence('reg-1', 'src/components/LoginButton.tsx', p.component, 'component', 'auto', 0, {
      role: 'declaration',
    }),
    codeOccurrence('reg-1', 'src/pages/Login.tsx', p.variable, 'variable', 'auto', 0, { role: 'binding' }),
    codeOccurrence('reg-1', 'src/pages/Login.tsx', p.variable, 'variable', 'auto', 1),
    codeOccurrence('reg-1', 'src/components/LoginButton.tsx', p.cssClass, 'cssClass', 'auto', 0, {
      role: 'string-literal',
    }),
    codeOccurrence('reg-1', 'src/pages/Login.tsx', p.i18nKey, 'i18nKey', 'auto', 0, { role: 'string-literal' }),
    codeOccurrence('reg-1', 'src/service/LoginService.ts', p.apiField, 'apiField', 'confirm', 0, {
      role: 'string-literal',
    }),
    codeOccurrence('reg-1', 'src/service/LoginService.ts', p.methodName, 'methodName', 'confirm', 0, {
      role: 'declaration',
    }),
    codeOccurrence('reg-1', 'src/__tests__/login.test.tsx', p.testName, 'testName', 'auto', 0, {
      role: 'string-literal',
    }),
    makeOccurrence({
      registryId: 'reg-1',
      kind: 'code',
      refPath: 'migrations/0002_add.sql',
      locator: 'migrations/0002_add.sql:3:12',
      symbol: p.apiField,
      matchedSymbol: 'apiField',
      riskLevel: 'warn',
      role: 'property-key',
      detail: '数据库列名（warn：默认不改，需走迁移脚本）',
    }),
    makeOccurrence({
      registryId: 'reg-1',
      kind: 'doc',
      refPath: DOC_FIXTURE_ID,
      locator: '#login:p1',
      symbol: '登录按钮',
      matchedSymbol: null,
      riskLevel: 'auto',
      confidence: 0.95,
      detail: '文档《技术方案》正文提及「登录按钮」',
    }),
    makeOccurrence({
      registryId: 'reg-1',
      kind: 'memory',
      refPath: MEMORY_FIXTURE_ID,
      locator: `${MEMORY_FIXTURE_ID}#structured.logic.states[0].key`,
      symbol: p.variable,
      matchedSymbol: 'variable',
      riskLevel: 'auto',
      scopeLayer: 'page',
      detail: '记忆「登录页」的结构化字段 logic.states[0].key 精确命中',
    }),
    makeOccurrence({
      registryId: 'reg-1',
      kind: 'memory',
      refPath: MEMORY_FIXTURE_ID,
      locator: `${MEMORY_FIXTURE_ID}#content`,
      symbol: '登录按钮',
      matchedSymbol: null,
      riskLevel: 'auto',
      confidence: 0.95,
      scopeLayer: 'page',
      detail: '记忆「登录页」正文提及「登录按钮」',
    }),
    makeOccurrence({
      registryId: 'reg-1',
      kind: 'logic',
      refPath: LOGIC_FIXTURE_ID,
      locator: 'Container:root/Button:btn-1',
      symbol: '登录按钮',
      matchedSymbol: null,
      riskLevel: 'auto',
      carrierId: 'btn-1',
      carrierField: 'name',
      detail: '逻辑结构 Container:root/Button:btn-1 的节点名「登录按钮」精确命中',
    }),
  ];

  const registerOccurrences: Occurrence[] = [
    codeOccurrence('reg-2', 'src/components/RegisterButton.tsx', r.component, 'component', 'auto', 0, {
      role: 'declaration',
    }),
  ];

  return {
    projectId,
    projectName: '演示项目',
    entries: new Map([
      [loginEntry.id, loginEntry],
      [registerEntry.id, registerEntry],
    ]),
    occurrences: new Map([
      [loginEntry.id, loginOccurrences],
      [registerEntry.id, registerOccurrences],
    ]),
    files: new Map(Object.entries(FIXTURE_FILES)),
    docs: new Map([
      [
        DOC_FIXTURE_ID,
        [
          '# 登录',
          '',
          '点击登录按钮完成认证。',
          '',
          '| 元素 | 说明 |',
          '| --- | --- |',
          '| 登录按钮 | 提交登录表单 |',
          '',
        ].join('\n'),
      ],
    ]),
    memories: new Map([
      [
        MEMORY_FIXTURE_ID,
        {
          structured: { layer: 'page', logic: { states: [{ key: p.variable, type: 'ref' }] } },
          content: '登录页的主操作是点击登录按钮提交表单。',
        },
      ],
    ]),
    logicDocs: new Map([
      [
        LOGIC_FIXTURE_ID,
        {
          id: LOGIC_FIXTURE_ID,
          nodes: [{ id: 'btn-1', type: 'Button', name: '登录按钮', identifier: p.variable }],
        },
      ],
    ]),
    anchors: new Map([['anchor-1', p.component]]),
    events: [],
    migrations: new Map(),
    batchPlans: new Map(),
    logListeners: [],
    cleanedAliases: new Set(),
  };
}

/* ------------------------------- 端口骨架 ------------------------------- */

/** 由内存状态构造执行上下文（execute / undo / batch 复用同一份，避免三处漂移） */
export function buildFakeContext(state: FakeRenameState, showRevisionMarks = false): ExecutionContext {
  return {
    projectId: state.projectId,
    showRevisionMarks,
    backupDir: null,
    now: NOW,
    files: {
      read: (path) => state.files.get(path) ?? null,
      write: (path, content) => {
        state.files.set(path, content);
      },
      exists: (path) => state.files.has(path),
    },
    docs: {
      read: (id) => state.docs.get(id) ?? null,
      write: (id, content) => {
        state.docs.set(id, content);
      },
    },
    memory: {
      read: (id) => state.memories.get(id) ?? null,
      setStructured: (id, jsonPath, value) => {
        const item = state.memories.get(id);
        if (item === undefined) return;
        const next = JSON.parse(JSON.stringify(item.structured)) as Record<string, unknown>;
        setPath(next, jsonPath, value);
        state.memories.set(id, { ...item, structured: next });
      },
      replaceInContent: (id, from, to) => {
        const item = state.memories.get(id);
        if (item === undefined) return;
        state.memories.set(id, { ...item, content: item.content.split(from).join(to) });
      },
      restore: (id, snapshot) => {
        state.memories.set(id, snapshot);
      },
    },
    logic: {
      // 深拷贝：否则快照与活对象共享引用，"撤销"会变成空操作
      readDocument: (id) => {
        const document = state.logicDocs.get(id);
        return document === undefined ? null : (JSON.parse(JSON.stringify(document)) as unknown);
      },
      rename: (input) => {
        const doc = state.logicDocs.get(input.documentId) as
          | { nodes?: { id: string; name?: string; identifier?: string }[] }
          | undefined;
        const node = doc?.nodes?.find((item) => item.id === input.nodeId);
        if (node === undefined) return;
        if (input.field === 'name' && node.name === input.from) node.name = input.to;
        if (input.field === 'identifier' && node.identifier === input.from) node.identifier = input.to;
      },
      recalcSummary: () => undefined,
      restore: (id, snapshot) => {
        state.logicDocs.set(id, snapshot);
      },
    },
    anchors: {
      read: (id) => state.anchors.get(id) ?? null,
      update: (id, to) => {
        state.anchors.set(id, to);
      },
      restore: (id, from) => {
        state.anchors.set(id, from);
      },
      findBySymbol: (symbol) =>
        [...state.anchors.entries()].filter(([, value]) => value === symbol).map(([id]) => id),
    },
  };
}

/** 内存事件仓库 */
export function buildFakeEventStore(state: FakeRenameState): RenameEventStore {
  return {
    append: (event) => {
      state.events.push(event);
    },
    get: (id) => state.events.find((event) => event.id === id) ?? null,
    list: (projectId) =>
      [...state.events].filter((event) => event.projectId === projectId).reverse(),
    markUndone: (id) => {
      const index = state.events.findIndex((event) => event.id === id);
      if (index < 0) return null;
      state.events[index] = { ...state.events[index]!, undone: true };
      return state.events[index]!;
    },
    setCommitSha: (id, commitSha) => {
      const index = state.events.findIndex((event) => event.id === id);
      if (index < 0) return null;
      state.events[index] = { ...state.events[index]!, commitSha };
      return state.events[index]!;
    },
  };
}

/* ------------------------------- 假端口 ------------------------------- */

export type FakeRenameApi = RenameApi & { readonly state: FakeRenameState };

/**
 * 迁移夹具输出：**必须是两个独立的 sql 围栏**（第一个前向、第二个回滚）。
 * 若把两条语句塞进同一个围栏，解析器只会取到前向脚本、回滚为空 —— 预览的回滚栏就空了。
 */
const MIGRATION_FIXTURE_OUTPUT = [
  '```sql',
  'ALTER TABLE users RENAME COLUMN login_button TO login_submit;',
  '```',
  '',
  '```sql',
  'ALTER TABLE users RENAME COLUMN login_submit TO login_button;',
  '```',
].join('\n');

/** 迁移夹具用的注册表项 id */
export const MIGRATION_REGISTRY_ID = 'reg-1';

export function createFakeRenameApi(
  overrides: Partial<FakeRenameState> = {},
  options: { ready?: boolean; reason?: string } = {},
): FakeRenameApi {
  const state: FakeRenameState = { ...createFakeRenameState(), ...overrides };
  const rule = resolveNamingRule({ platform: 'web' });

  if (options.ready === false) {
    const unavailable = createUnavailableRenameApi(options.reason ?? '假端口未就绪');
    return Object.assign(unavailable, { state }) as FakeRenameApi;
  }

  const entryOf = (registryId: string): RegistryEntry => {
    const entry = state.entries.get(registryId);
    if (entry === undefined) throw new Error(`未找到注册表项 ${registryId}`);
    return entry;
  };

  const symbolsOf = (): SymbolTable => {
    const frontend: string[] = [];
    const backend: string[] = [];
    for (const entry of state.entries.values()) {
      const projections = entry.projections;
      frontend.push(projections.component, projections.variable, projections.cssClass, projections.i18nKey);
      backend.push(projections.apiField, projections.methodName);
    }
    return { frontend, backend, database: ['login_button'] };
  };

  const buildReport = (registryId: string, newName: string): ImpactReport =>
    analyzeImpact({
      registry: entryOf(registryId),
      newCanonicalName: newName,
      rule,
      occurrences: state.occurrences.get(registryId) ?? [],
      scope: 'login',
      timer: () => NOW,
    });

  const deps = (showRevisionMarks = false) => ({
    context: buildFakeContext(state, showRevisionMarks),
    rule,
    registry: {
      save: (next: RegistryEntry) => {
        state.entries.set(next.id, next);
      },
    },
    git: { commit: () => 'sha-fake-0001' },
    events: buildFakeEventStore(state),
    now: NOW,
    timer: () => NOW,
  });

  const api: RenameApi = {
    ready: true,
    projectContext: async () => ({
      projectId: state.projectId,
      projectName: state.projectName,
      platform: 'web',
      override: null,
    }),
    resolveRule: async () => rule,
    symbolTable: async () => symbolsOf(),
    listTargets: async (): Promise<readonly RenameTarget[]> =>
      [...state.entries.values()].map((entry) => ({
        registryId: entry.id,
        entityType: entry.entityType,
        entityId: entry.entityId,
        canonicalName: entry.canonicalName,
        projections: entry.projections,
        aliases: entry.aliases,
        syncState: entry.syncState,
        ownerName: entry.canonicalName.startsWith('登录') ? '登录页' : '注册页',
      })),
    check: async ({ registryId, newName }): Promise<ConflictCheckResult> =>
      checkName({
        canonicalName: newName,
        entityType: entryOf(registryId).entityType,
        rule,
        symbols: symbolsOf(),
        exclude: Object.values(entryOf(registryId).projections),
      }),
    analyze: async ({ registryId, newName }) => buildReport(registryId, newName),
    buildDiff: async ({ registryId, newName, selection, showRevisionMarks }): Promise<UnifiedDiff> =>
      buildUnifiedDiff(buildReport(registryId, newName), {
        ...(selection !== undefined ? { selection: new Set(selection) } : {}),
        showRevisionMarks: showRevisionMarks ?? false,
        now: NOW,
      }),
    execute: async ({ registryId, newName, selection, showRevisionMarks }): Promise<RenameTransactionResult> =>
      executeRename({
        registry: entryOf(registryId),
        newCanonicalName: newName,
        report: buildReport(registryId, newName),
        selection: new Set(selection),
        deps: deps(showRevisionMarks ?? false),
      }),
    undo: async ({ eventId }): Promise<UndoResult> => {
      const event = state.events.find((item) => item.id === eventId);
      if (event === undefined) {
        return { ok: false, failures: ['未找到该重命名记录'], restored: [], commitSha: null };
      }
      return undoRename({ event, deps: deps() });
    },
    history: async (): Promise<readonly RenameHistoryEntry[]> => state.events.map(toHistoryEntry),
    planMigration: async (input: MigrationPlanRequest): Promise<MigrationPreview | MigrationPlanError> => {
      const parsed = parseGeneratedMigration(MIGRATION_FIXTURE_OUTPUT);
      if (parsed === null) return { error: '夹具异常：无法解析 SQL', guidance: '请重试' };
      const preview = await buildMigrationPreview({
        migration: {
          id: `mig-${input.newColumn}`,
          dialect: input.dialect ?? 'sqlite',
          table: input.table,
          oldColumn: input.oldColumn,
          newColumn: input.newColumn,
          forward: parsed.forward,
          rollback: parsed.rollback,
          generatedBy: 'ai',
          editable: false,
          prompt: '假端口夹具提示词',
          risks: [],
          modelId: 'fake-model',
        },
        stats: { countRows: async () => 12_345, estimateRows: async () => 12_000 },
      });
      state.migrations.set(preview.migrationId, preview);
      return preview;
    },
    runMigration: async ({
      migrationId,
      confirmed,
      secondConfirmed,
    }): Promise<MigrationExecutionResult> => {
      const preview = state.migrations.get(migrationId);
      const log: MigrationLogLine[] = [];
      const emit = (line: MigrationLogLine): void => {
        log.push(line);
        for (const listener of state.logListeners) listener(line);
      };
      const refuse = (message: string): MigrationExecutionResult => {
        emit({ level: 'warn', message, at: NOW, index: 0, total: 0 });
        return {
          ok: false,
          executed: [],
          failedStatement: null,
          failure: null,
          rolledBack: false,
          rollbackFailure: null,
          log,
          event: null,
          commitSha: null,
          refused: message,
        };
      };
      if (preview === undefined) return refuse('未找到迁移预览，请重新生成');
      if (confirmed !== true) return refuse('默认只生成脚本不执行（D-08）：请点击「确认并执行」');
      if (preview.requiresSecondConfirm && secondConfirmed !== true) {
        return refuse('命中高危操作（DROP / 类型变更 / NOT NULL 收紧），需要二次确认');
      }
      preview.statements.forEach((statement, index) => {
        emit({
          level: 'info',
          message: `执行第 ${index + 1}/${preview.statements.length} 条：${statement.sql}`,
          at: NOW,
          index: index + 1,
          total: preview.statements.length,
        });
      });
      emit({
        level: 'success',
        message: `迁移完成，共执行 ${preview.statements.length} 条语句`,
        at: NOW,
        index: 1,
        total: preview.statements.length,
      });
      const event = createRenameEvent({
        projectId: state.projectId,
        registryId: MIGRATION_REGISTRY_ID,
        oldName: `${preview.table}.${preview.oldColumn}`,
        newName: `${preview.table}.${preview.newColumn}`,
        changeset: null,
        commitSha: 'sha-migrate-0001',
        now: NOW,
      });
      state.events.push(event);
      return {
        ok: true,
        executed: preview.statements.map((statement) => statement.sql),
        failedStatement: null,
        failure: null,
        rolledBack: false,
        rollbackFailure: null,
        log,
        event,
        commitSha: 'sha-migrate-0001',
        refused: null,
      };
    },
    subscribeMigrationLog: (listener) => {
      state.logListeners.push(listener);
      return () => {
        state.logListeners = state.logListeners.filter((item) => item !== listener);
      };
    },
    pendingCleanup: async () => pendingCleanupOf([...state.entries.values()], NOW, state.cleanedAliases),
    cleanAliases: async ({ items }) => {
      const result = cleanAliasesOf([...state.entries.values()], items, NOW);
      for (const entry of result.entries) state.entries.set(entry.id, entry);
      for (const key of result.cleanedKeys) state.cleanedAliases.add(key);
      return result.cleaned.length;
    },
    planBatch: async (input: BatchPlanRequest): Promise<BatchPlan> => {
      const plan =
        input.normalize === true
          ? planNormalization({
              projectId: state.projectId,
              entries: [...state.entries.values()],
              occurrencesOf: (registryId) => state.occurrences.get(registryId) ?? [],
              rule,
              now: NOW,
              timer: () => NOW,
            })
          : planBatchRename({
              projectId: state.projectId,
              items: (input.items ?? []).map((item) => ({
                registry: entryOf(item.registryId),
                newCanonicalName: item.newName,
                occurrences: state.occurrences.get(item.registryId) ?? [],
              })),
              rule,
              symbols: symbolsOf(),
              now: NOW,
              timer: () => NOW,
            });
      state.batchPlans.set(plan.batchId, plan);
      return plan;
    },
    runBatch: async ({ batchId }): Promise<BatchRenameResult> => {
      const plan = state.batchPlans.get(batchId);
      if (plan === undefined) {
        return {
          ok: false,
          batchId,
          steps: [],
          applied: 0,
          rolledBack: false,
          rollbackFailures: [],
          failures: ['未找到该批处理计划，请重新生成'],
        };
      }
      return executeBatchRename({ plan, deps: deps() });
    },
  };

  return Object.assign(api, { state });
}

/** 便捷：确定性触发器的假调度器（可直接断言 `delayMs === 300`） */
export function createFakeTriggerSchedule(rule: ResolvedNamingRule): {
  scheduled: { delayMs: number; run: () => void }[];
  cancelled: number;
  trigger: ReturnType<typeof createRenameTrigger>;
  intents: string[];
  blocked: string[];
} {
  const scheduled: { delayMs: number; run: () => void }[] = [];
  const intents: string[] = [];
  const blocked: string[] = [];
  const counter = { cancelled: 0 };
  const trigger = createRenameTrigger({
    rule,
    onIntent: (intent) => intents.push(intent.newName),
    onBlocked: (intent) => blocked.push(intent.newName),
    scheduler: {
      schedule: (callback, delayMs) => {
        const handle = { run: callback };
        scheduled.push({ delayMs, run: callback });
        return handle;
      },
      cancel: () => {
        counter.cancelled += 1;
      },
    },
    clock: () => NOW,
  });
  return {
    scheduled,
    get cancelled() {
      return counter.cancelled;
    },
    trigger,
    intents,
    blocked,
  };
}

/** 默认别名类别（UI 的 checkbox 初值） */
export const DEFAULT_ALIAS_KINDS: readonly AliasKind[] = ['code'];

/** 内部工具：按 JSON 路径写入字符串叶 */
function setPath(target: Record<string, unknown>, jsonPath: string, value: string): void {
  const parts = jsonPath
    .replace(/^\$\.?/, '')
    .split(/[.[\]]/)
    .filter((part) => part.length > 0);
  let cursor: unknown = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]!;
    const next = (cursor as Record<string, unknown>)[key];
    if (next === undefined || next === null) return;
    cursor = next;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined && cursor !== null && typeof cursor === 'object') {
    (cursor as Record<string, unknown>)[last] = value;
  }
}

/** 供组件测试构造"看起来是执行中"的快照 */
export type { ExecutorStateSnapshot, ExecutionContext };
