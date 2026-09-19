/**
 * T7-04 验收测试：四栏 diff、事务化执行、一键撤销、失败注入、性能。
 *
 * 覆盖：
 * - E2E-15：改「登录按钮」为「登录提交」后，前端组件 / 变量 / CSS、后端 DTO / Service、
 *   文档、记忆、逻辑结构与 Code Anchor 全部同步；
 * - E2E-16：同名局部变量与注释 / 字符串中的同名文本**不被误改**；
 * - E2E-17：一键撤销后代码、文档、记忆、逻辑结构、注册表全部还原；
 * - 失败注入：五个执行器**各自**注入失败，断言整体回滚且无中间态（NFR-R-04）;
 * - 性能：≤200 处变更 ≤5s（NFR-P-07），并验证中断可回滚。
 *
 * 夹具说明：`src/pages/Login.tsx` 里 `LoginButton` 出现 6 次，其中
 * **第 3 次在注释、第 4 次是局部变量声明、第 5 次在字符串字面量**，
 * 这三处**不在**出现位置索引里 —— 正是 E2E-16 要断言的"不误改"。
 */

import { describe, expect, it } from 'vitest';

import {
  EXECUTION_ORDER,
  EXECUTOR_IDS,
  PROJECT_SCOPE_NOTICE,
  analyzeImpact,
  applyDiffStatus,
  buildChangeRecords,
  buildUnifiedDiff,
  createDefaultExecutors,
  createInMemoryRenameEventStore,
  createRegistryEntry,
  diffFooterText,
  executeRename,
  projectionTable,
  resolveNamingRule,
  searchEntries,
  selectionOf,
  setRevisionMarks,
  toHistoryEntry,
  toggleColumn,
  toggleEntry,
  undoRename,
  type ExecutionContext,
  type ExecutorResult,
  type FileSnapshot,
  type ImpactReport,
  type Occurrence,
  type ProjectionKind,
  type RegistryEntry,
  type RenameEvent,
  type RenameExecutor,
  type RiskLevel,
} from '../index';

const NOW = 1_700_000_000_000;
const WEB = resolveNamingRule({ platform: 'web' });

/* ------------------------------- 夹具 ------------------------------- */

const FILE_MAIN = [
  "import { LoginButton } from './LoginButton';",
  '',
  'export function LoginPage(): unknown {',
  '  // LoginButton 在注释里，不能被改',
  '  const LoginButton = shadow();',
  '  const loginButton = useRef(null);',
  "  const text = 'LoginButton 在字符串里，不能改';",
  '  return {',
  '    node: <LoginButton ref={loginButton} className="login-button" />,',
  '    label: t("page.login.loginButton.label"),',
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

const FILES: Readonly<Record<string, string>> = {
  'src/pages/Login.tsx': FILE_MAIN,
  'src/service/LoginService.ts': FILE_SERVICE,
};

const DOC = [
  '# 用户登录按钮',
  '',
  '点击登录按钮完成认证。',
  '',
  '| 登录按钮 | 说明 |',
  '| --- | --- |',
  '| 登录按钮 | 提交登录表单 |',
  '',
].join('\n');

const MEMORY_CONTENT = '登录页的主操作是点击登录按钮提交表单。';

interface HarnessOptions {
  /** 注入失败的端口方法名（`fileWrite` / `docWrite` / `memoryWrite` / `logicRename` / `anchorUpdate` / `registrySave`） */
  failures?: readonly string[] | undefined;
  showRevisionMarks?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

interface HarnessDeps {
  context: ExecutionContext;
  rule: typeof WEB;
  registry: { save(entry: RegistryEntry): void };
  git: { commit(input: { message: string; paths: readonly string[] }): string };
  events: ReturnType<typeof createInMemoryRenameEventStore>;
  now: number;
  timer: () => number;
}

interface Harness {
  entry: RegistryEntry;
  occurrences: Occurrence[];
  files: Map<string, string>;
  docs: Map<string, string>;
  memories: Map<string, { structured: unknown; content: string }>;
  logicDocs: Map<string, unknown>;
  anchors: Map<string, string>;
  events: ReturnType<typeof createInMemoryRenameEventStore>;
  saved: RegistryEntry[];
  /** 逻辑结构摘要重算的调用记录（验证 T2-06 被调用） */
  recalcCalls: string[];
  deps: HarnessDeps;
}

let occurrenceSeq = 0;

/** 依据内容与第 N 次出现位置生成代码命中（行列号现算，执行器会复核） */
function codeHit(
  refPath: string,
  symbol: string,
  matchedSymbol: ProjectionKind | null,
  riskLevel: RiskLevel,
  occurrenceIndex: number,
  role: Occurrence['role'] = 'call',
): Occurrence {
  const content = FILES[refPath] ?? '';
  let cursor = -1;
  for (let index = 0; index <= occurrenceIndex; index += 1) {
    cursor = content.indexOf(symbol, cursor + 1);
    if (cursor < 0)
      throw new Error(`夹具错误：${refPath} 缺少第 ${occurrenceIndex} 次「${symbol}」`);
  }
  const before = content.slice(0, cursor);
  const line = before.split('\n').length;
  const column = cursor - before.lastIndexOf('\n');
  const lines = content.split('\n');
  occurrenceSeq += 1;
  return {
    id: `occ-${occurrenceSeq}`,
    registryId: 'reg-1',
    kind: 'code',
    refPath,
    locator: `${refPath}:${line}:${column}`,
    matchedSymbol,
    symbol,
    confidence: 1,
    riskLevel,
    status: 'active',
    role,
    context: {
      startLine: Math.max(1, line - 1),
      before: lines.slice(Math.max(0, line - 2), line - 1),
      line: lines[line - 1] ?? '',
      after: lines.slice(line, line + 1),
    },
    detail: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function nonCodeHit(input: {
  id: string;
  kind: Occurrence['kind'];
  refPath: string;
  locator: string;
  symbol: string;
  matchedSymbol?: ProjectionKind | null;
  confidence?: number;
  scopeLayer?: string | null;
  carrierId?: string | null;
  carrierField?: string | null;
}): Occurrence {
  return {
    id: input.id,
    registryId: 'reg-1',
    kind: input.kind,
    refPath: input.refPath,
    locator: input.locator,
    matchedSymbol: input.matchedSymbol ?? null,
    symbol: input.symbol,
    confidence: input.confidence ?? 1,
    riskLevel: 'auto',
    status: 'active',
    role: null,
    context: null,
    detail: null,
    scopeLayer: input.scopeLayer ?? null,
    carrierId: input.carrierId ?? null,
    carrierField: input.carrierField ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  occurrenceSeq = 0;
  const entry = createRegistryEntry({
    projectId: 'p1',
    entityType: 'element',
    canonicalName: '登录按钮',
    rule: WEB,
    entityId: 'el-1',
    id: 'reg-1',
    scope: 'login',
    now: NOW,
    random: () => 0.5,
  }).entry;
  const p = entry.projections;

  const occurrences: Occurrence[] = [
    // 组件名：导入名（0）与 JSX 使用处（5）；1 = 导入路径字符串、2 = 注释、3 = 局部变量、4 = 字符串字面量，均排除
    codeHit('src/pages/Login.tsx', p.component, 'component', 'auto', 0, 'import'),
    codeHit('src/pages/Login.tsx', p.component, 'component', 'auto', 5, 'jsx-tag'),
    codeHit('src/pages/Login.tsx', p.variable, 'variable', 'auto', 0, 'binding'),
    codeHit('src/pages/Login.tsx', p.variable, 'variable', 'auto', 1),
    codeHit('src/pages/Login.tsx', p.cssClass, 'cssClass', 'auto', 0, 'string-literal'),
    codeHit('src/pages/Login.tsx', p.i18nKey, 'i18nKey', 'auto', 0, 'string-literal'),
    codeHit('src/service/LoginService.ts', p.methodName, 'methodName', 'confirm', 0, 'declaration'),
    codeHit('src/service/LoginService.ts', p.apiField, 'apiField', 'confirm', 0, 'string-literal'),
    nonCodeHit({
      id: 'occ-doc',
      kind: 'doc',
      refPath: 'doc-1',
      locator: '#用户登录按钮:p1',
      symbol: '登录按钮',
      confidence: 0.95,
    }),
    nonCodeHit({
      id: 'occ-mem-structured',
      kind: 'memory',
      refPath: 'mem-1',
      locator: 'mem-1#structured.logic.states[0].key',
      symbol: p.variable,
      matchedSymbol: 'variable',
      scopeLayer: 'page',
    }),
    nonCodeHit({
      id: 'occ-mem-content',
      kind: 'memory',
      refPath: 'mem-1',
      locator: 'mem-1#content',
      symbol: '登录按钮',
      confidence: 0.95,
      scopeLayer: 'page',
    }),
    nonCodeHit({
      id: 'occ-logic-name',
      kind: 'logic',
      refPath: 'page-login',
      locator: 'Container:root/Button:btn-1',
      symbol: '登录按钮',
      carrierId: 'btn-1',
      carrierField: 'name',
    }),
    nonCodeHit({
      id: 'occ-logic-identifier',
      kind: 'logic',
      refPath: 'page-login',
      locator: 'Container:root/Button:btn-1',
      symbol: p.variable,
      matchedSymbol: 'variable',
      carrierId: 'btn-1',
      carrierField: 'identifier',
    }),
  ];

  const files = new Map(Object.entries(FILES));
  const docs = new Map([['doc-1', DOC]]);
  const memories = new Map<string, { structured: unknown; content: string }>([
    [
      'mem-1',
      { structured: { logic: { states: [{ key: p.variable }] } }, content: MEMORY_CONTENT },
    ],
  ]);
  const logicDocs = new Map<string, unknown>([
    [
      'page-login',
      { id: 'page-login', nodes: [{ id: 'btn-1', name: '登录按钮', identifier: p.variable }] },
    ],
  ]);
  const anchors = new Map([['anchor-1', p.component]]);
  const failures = new Set(options.failures ?? []);
  const events = createInMemoryRenameEventStore();
  const saved: RegistryEntry[] = [];
  const recalcCalls: string[] = [];

  const boom = (name: string): void => {
    if (failures.has(name)) throw new Error(`注入失败：${name}`);
  };

  const context: ExecutionContext = {
    projectId: 'p1',
    showRevisionMarks: options.showRevisionMarks ?? false,
    backupDir: null,
    now: NOW,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    files: {
      read: (path) => {
        boom('fileRead');
        return files.get(path) ?? null;
      },
      write: (path, content) => {
        boom('fileWrite');
        files.set(path, content);
      },
      exists: (path) => files.has(path),
    },
    docs: {
      read: (id) => {
        boom('docRead');
        return docs.get(id) ?? null;
      },
      write: (id, content) => {
        boom('docWrite');
        docs.set(id, content);
      },
    },
    memory: {
      read: (id) => {
        boom('memoryRead');
        return memories.get(id) ?? null;
      },
      setStructured: (id, jsonPath, value) => {
        boom('memoryWrite');
        const item = memories.get(id);
        if (item === undefined) return;
        const next = JSON.parse(JSON.stringify(item.structured)) as Record<string, unknown>;
        const parts = jsonPath.split(/[.[\]]/).filter((part) => part.length > 0);
        let cursor: Record<string, unknown> = next;
        for (let index = 0; index < parts.length - 1; index += 1) {
          cursor = cursor[parts[index]!] as Record<string, unknown>;
        }
        cursor[parts[parts.length - 1]!] = value;
        memories.set(id, { ...item, structured: next });
      },
      replaceInContent: (id, from, to) => {
        boom('memoryWrite');
        const item = memories.get(id);
        if (item === undefined) return;
        memories.set(id, { ...item, content: item.content.split(from).join(to) });
      },
      restore: (id, snapshot) => {
        memories.set(id, snapshot);
      },
    },
    logic: {
      // 深拷贝：快照若与"活对象"共享引用，rename 的原位修改会连带改掉快照 → 还原变成空操作
      readDocument: (id) => {
        boom('logicRead');
        const document = logicDocs.get(id);
        return document === undefined ? null : (JSON.parse(JSON.stringify(document)) as unknown);
      },
      rename: (input) => {
        boom('logicRename');
        const doc = logicDocs.get(input.documentId) as
          { nodes?: { id: string; name?: string; identifier?: string }[] } | undefined;
        const node = doc?.nodes?.find((item) => item.id === input.nodeId);
        if (node === undefined) throw new Error(`DSL 节点不存在：${input.nodeId}`);
        if (input.field === 'name') node.name = input.to;
        if (input.field === 'identifier') node.identifier = input.to;
      },
      recalcSummary: (id) => {
        boom('logicRecalc');
        recalcCalls.push(id);
      },
      restore: (id, snapshot) => {
        logicDocs.set(id, snapshot);
      },
    },
    anchors: {
      read: (id) => {
        boom('anchorRead');
        return anchors.get(id) ?? null;
      },
      update: (id, to) => {
        boom('anchorUpdate');
        anchors.set(id, to);
      },
      restore: (id, from) => {
        anchors.set(id, from);
      },
      findBySymbol: (symbol) => {
        boom('anchorFind');
        return [...anchors.entries()].filter(([, value]) => value === symbol).map(([id]) => id);
      },
    },
  };

  return {
    entry,
    occurrences,
    files,
    docs,
    memories,
    logicDocs,
    anchors,
    events,
    saved,
    recalcCalls,
    deps: {
      context,
      rule: WEB,
      registry: {
        save: (next) => {
          boom('registrySave');
          saved.push(next);
        },
      },
      git: { commit: () => 'sha-e2e-0001' },
      events,
      now: NOW,
      timer: () => NOW,
    },
  };
}

/** 用真实领域函数构建影响面（不手搓 ImpactReport，避免夹具漂移） */
function reportOf(harness: Harness, newName = '登录提交'): ImpactReport {
  return analyzeImpact({
    registry: harness.entry,
    newCanonicalName: newName,
    rule: WEB,
    occurrences: harness.occurrences,
    timer: () => NOW,
  });
}

function allSelected(report: ImpactReport): Set<string> {
  return new Set(report.groups.flatMap((group) => group.items.map((item) => item.id)));
}

/* ------------------------------- 测试 ------------------------------- */

describe('T7-04 事务化执行：顺序与四栏 diff', () => {
  it('执行顺序固定为五段（PRD §15.2 ⑤）', () => {
    expect([...EXECUTION_ORDER]).toEqual([
      'code-ast',
      'doc-replace',
      'memory-update',
      'logic-recalc',
      'anchor-sync',
    ]);
    expect(createDefaultExecutors().map((executor) => executor.id)).toEqual([...EXECUTOR_IDS]);
  });

  it('四栏 diff：栏位 / 默认勾选 / 检索 / 修订标记 / 底部文案 / 状态回填', () => {
    const harness = createHarness();
    const report = reportOf(harness);
    const diff = buildUnifiedDiff(report, { now: NOW });

    expect(diff.columns.map((column) => column.column)).toEqual(['code', 'doc', 'memory', 'logic']);
    expect(diff.columns.map((column) => column.label)).toEqual([
      '代码',
      '文档',
      '记忆',
      '逻辑结构',
    ]);
    expect(diff.summary.total).toBe(report.totals.total);
    expect(diff.summary.selected).toBe(report.totals.selected);
    expect(diff.scopeNotice).toBe(PROJECT_SCOPE_NOTICE);
    expect(diffFooterText(diff)).toContain('将修改');

    const docColumn = diff.columns[1]!;
    expect(docColumn.entries.length).toBeGreaterThan(0);
    expect(docColumn.entries.every((entry) => entry.selected)).toBe(true);
    expect(setRevisionMarks(diff, true, NOW).columns[1]!.entries[0]?.revision?.oldText).toBe(
      '登录按钮',
    );
    expect(setRevisionMarks(diff, false, NOW).columns[1]!.entries[0]?.revision).toBeNull();

    const first = diff.columns[0]!.entries[0]!;
    const toggled = toggleEntry(diff, first.id, false);
    expect(selectionOf(toggled).size).toBe(selectionOf(diff).size - 1);
    expect(toggleColumn(toggled, 'code', false).columns[0]!.selectedCount).toBe(0);
    expect(searchEntries(diff, 'LoginService').length).toBeGreaterThan(0);
    const afterStatus = applyDiffStatus(diff, first.id, 'applied');
    expect(afterStatus.columns[0]!.entries.find((entry) => entry.id === first.id)?.status).toBe(
      'applied',
    );
    expect(projectionTable(diff)).toContain('| component |');
  });

  it('勾选集合展开为逐处变更，代码栏解析出 AST 行列、逻辑栏带承载者', () => {
    const harness = createHarness();
    const report = reportOf(harness);
    const selection = allSelected(report);
    const records = buildChangeRecords(report, selection);
    expect(records).toHaveLength(selection.size);
    const codeRecord = records.find((record) => record.column === 'code');
    expect(codeRecord?.line).toBeGreaterThan(0);
    expect(codeRecord?.columnNumber).toBeGreaterThan(0);
    const logicRecord = records.find((record) => record.column === 'logic');
    expect(logicRecord?.carrierId).toBe('btn-1');
    expect(logicRecord?.carrierField).toBe('name');
  });
});

describe('T7-04 事务化执行：E2E-15 级联同步', () => {
  it('代码 / 文档 / 记忆 / 逻辑结构 / 锚点 / 注册表 / Git 全部同步', () => {
    const harness = createHarness();
    const report = reportOf(harness);
    const result = executeRename({
      registry: harness.entry,
      newCanonicalName: '登录提交',
      report,
      selection: allSelected(report),
      deps: harness.deps,
    });

    expect(result.ok).toBe(true);
    expect(result.rollback.performed).toBe(false);
    expect(result.segments.map((segment) => segment.executorId)).toEqual([...EXECUTOR_IDS]);
    expect(result.commitSha).toBe('sha-e2e-0001');
    expect(result.applied).toBeGreaterThan(0);

    const main = harness.files.get('src/pages/Login.tsx') ?? '';
    // 注意：模块路径字符串（`'./LoginButton'`）不是标识符引用，不在出现位置索引里，
    // 因此导入语句只改"导入名"（文件本身的改名属另一条链路）
    expect(main).toContain("import { LoginSubmit } from './LoginButton'");
    expect(main).toContain('<LoginSubmit ref={loginSubmit}');
    expect(main).toContain('className="login-submit"');
    expect(main).toContain('t("page.login.loginSubmit.label")');

    const service = harness.files.get('src/service/LoginService.ts') ?? '';
    expect(service).toContain('handleLoginSubmit(): string');
    expect(service).toContain("return 'login_submit';");

    expect(harness.docs.get('doc-1')).toContain('登录提交');
    expect(harness.docs.get('doc-1')).not.toContain('登录按钮');

    const memory = harness.memories.get('mem-1');
    expect(JSON.stringify(memory?.structured)).toContain('loginSubmit');
    expect(memory?.content).toContain('登录提交');

    const logic = JSON.stringify(harness.logicDocs.get('page-login'));
    expect(logic).toContain('登录提交');
    expect(logic).toContain('loginSubmit');
    // 逻辑结构摘要重算（T2-06）被调用
    expect(harness.recalcCalls).toContain('page-login');

    // Code Anchor 同步 → Ctrl + 点击不失效（FR-NAV-04）
    expect(harness.anchors.get('anchor-1')).toBe('LoginSubmit');

    // 注册表写回（新规范名 + 新投影 + 历史名）与 rename 事件
    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]?.canonicalName).toBe('登录提交');
    expect(harness.saved[0]?.projections.component).toBe('LoginSubmit');
    expect(harness.saved[0]?.nameHistory.map((history) => history.name)).toEqual([
      '登录按钮',
      '登录提交',
    ]);
    expect(harness.events.list('p1')).toHaveLength(1);
    expect(harness.events.list('p1')[0]?.commitSha).toBe('sha-e2e-0001');
    expect(result.changeset?.commitMessage).toBe('refactor(rename): 登录按钮 → 登录提交');
    expect(toHistoryEntry(harness.events.list('p1')[0]!).changes).toBeGreaterThan(0);
    expect(result.changeset?.scope).toBe('project');
    expect(result.changeset?.snapshots.length).toBeGreaterThan(0);
    expect(result.changeset?.stateSnapshots.length).toBeGreaterThan(0);
  });

  it('E2E-16：同名局部变量 / 注释 / 字符串字面量均不被误改', () => {
    const harness = createHarness();
    const report = reportOf(harness);
    executeRename({
      registry: harness.entry,
      newCanonicalName: '登录提交',
      report,
      selection: allSelected(report),
      deps: harness.deps,
    });
    const main = harness.files.get('src/pages/Login.tsx') ?? '';
    expect(main).toContain('// LoginButton 在注释里，不能被改');
    expect(main).toContain('const LoginButton = shadow();');
    expect(main).toContain("const text = 'LoginButton 在字符串里，不能改';");
  });

  it('文档修订标记可切换（显示时写入「原：」标注）', () => {
    const harness = createHarness({ showRevisionMarks: true });
    const report = reportOf(harness);
    executeRename({
      registry: harness.entry,
      newCanonicalName: '登录提交',
      report,
      selection: allSelected(report),
      deps: harness.deps,
    });
    expect(harness.docs.get('doc-1')).toContain('〔原：登录按钮〕');
  });
});

describe('T7-04 事务化执行：E2E-17 一键撤销', () => {
  it('撤销后代码 / 文档 / 记忆 / 逻辑结构 / 锚点 / 注册表全部还原', () => {
    const harness = createHarness();
    const report = reportOf(harness);
    const executed = executeRename({
      registry: harness.entry,
      newCanonicalName: '登录提交',
      report,
      selection: allSelected(report),
      deps: harness.deps,
    });
    const event = executed.event as RenameEvent;
    expect(event).not.toBeNull();

    const undo = undoRename({ event, deps: harness.deps });
    expect(undo.ok).toBe(true);
    expect(undo.failures).toEqual([]);
    expect(undo.restored.length).toBeGreaterThan(0);

    expect(harness.files.get('src/pages/Login.tsx')).toBe(FILE_MAIN);
    expect(harness.files.get('src/service/LoginService.ts')).toBe(FILE_SERVICE);
    expect(harness.docs.get('doc-1')).toBe(DOC);
    expect(JSON.stringify(harness.memories.get('mem-1')?.structured)).toContain('loginButton');
    expect(harness.memories.get('mem-1')?.content).toBe(MEMORY_CONTENT);
    expect(JSON.stringify(harness.logicDocs.get('page-login'))).toContain('登录按钮');
    expect(harness.anchors.get('anchor-1')).toBe('LoginButton');
    expect(harness.saved[1]?.canonicalName).toBe('登录按钮');
    expect(harness.events.get(event.id)?.undone).toBe(true);

    // 重复撤销被拒绝
    const again = undoRename({ event, deps: harness.deps });
    expect(again.ok).toBe(false);
    expect(again.failures.join()).toContain('已撤销');
  });

  it('缺少变更集时拒绝撤销', () => {
    const harness = createHarness();
    const result = undoRename({
      event: {
        id: 'evt-x',
        projectId: 'p1',
        registryId: 'reg-1',
        oldName: 'a',
        newName: 'b',
        changeset: null,
        scope: 'project',
        commitSha: null,
        undone: false,
        createdAt: NOW,
      },
      deps: harness.deps,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('缺少变更集');
  });
});

describe('T7-04 事务化执行：边界与失败注入', () => {
  it('未勾选任何变更项时不执行、不提交', () => {
    const harness = createHarness();
    const result = executeRename({
      registry: harness.entry,
      newCanonicalName: '登录提交',
      report: reportOf(harness),
      selection: new Set(),
      deps: harness.deps,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('未勾选');
    expect(harness.events.list('p1')).toHaveLength(0);
    expect(harness.saved).toHaveLength(0);
  });

  it('中断（AbortSignal）视为失败并整体回滚', () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness({ signal: controller.signal });
    const report = reportOf(harness);
    const result = executeRename({
      registry: harness.entry,
      newCanonicalName: '登录提交',
      report,
      selection: allSelected(report),
      deps: harness.deps,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join()).toContain('中断');
    expect(result.applied).toBe(0);
    expect(harness.files.get('src/pages/Login.tsx')).toBe(FILE_MAIN);
    expect(harness.saved).toHaveLength(0);
  });

  it('位置漂移（索引过期）时拒绝盲替换并整体回滚', () => {
    const harness = createHarness();
    const report = reportOf(harness);
    // 执行前文件被外部改动：原位置上的文本已不再是旧符号
    harness.files.set('src/pages/Login.tsx', FILE_MAIN.replace('<LoginButton', '<span'));
    const result = executeRename({
      registry: harness.entry,
      newCanonicalName: '登录提交',
      report,
      selection: allSelected(report),
      deps: harness.deps,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join()).toContain('位置漂移');
    expect(harness.docs.get('doc-1')).toBe(DOC);
    expect(harness.saved).toHaveLength(0);
  });

  const cases: { name: string; failures: readonly string[] }[] = [
    { name: 'code-ast（文件写入失败）', failures: ['fileWrite'] },
    { name: 'doc-replace（文档写入失败）', failures: ['docWrite'] },
    { name: 'memory-update（记忆写入失败）', failures: ['memoryWrite'] },
    { name: 'logic-recalc（DSL 改名失败）', failures: ['logicRename'] },
    { name: 'anchor-sync（锚点更新失败）', failures: ['anchorUpdate'] },
  ];

  for (const testCase of cases) {
    it(`失败注入：${testCase.name} → 整体回滚且无中间态（NFR-R-04）`, () => {
      const harness = createHarness({ failures: testCase.failures });
      const report = reportOf(harness);
      const result = executeRename({
        registry: harness.entry,
        newCanonicalName: '登录提交',
        report,
        selection: allSelected(report),
        deps: harness.deps,
      });

      expect(result.ok).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
      expect(result.rollback.performed).toBe(true);
      expect(result.applied).toBe(0);

      expect(harness.files.get('src/pages/Login.tsx')).toBe(FILE_MAIN);
      expect(harness.files.get('src/service/LoginService.ts')).toBe(FILE_SERVICE);
      expect(harness.docs.get('doc-1')).toBe(DOC);
      expect(JSON.stringify(harness.memories.get('mem-1')?.structured)).toContain('loginButton');
      expect(harness.memories.get('mem-1')?.content).toBe(MEMORY_CONTENT);
      expect(JSON.stringify(harness.logicDocs.get('page-login'))).toContain('登录按钮');
      expect(harness.anchors.get('anchor-1')).toBe('LoginButton');
      expect(harness.saved).toHaveLength(0);
      expect(harness.events.list('p1')).toHaveLength(0);
    });
  }

  it('失败注入：注册表写回失败 → 五段产物全部回滚', () => {
    const harness = createHarness({ failures: ['registrySave'] });
    const report = reportOf(harness);
    const result = executeRename({
      registry: harness.entry,
      newCanonicalName: '登录提交',
      report,
      selection: allSelected(report),
      deps: harness.deps,
    });
    expect(result.ok).toBe(false);
    expect(result.rollback.performed).toBe(true);
    expect(harness.files.get('src/pages/Login.tsx')).toBe(FILE_MAIN);
    expect(harness.docs.get('doc-1')).toBe(DOC);
    expect(harness.saved).toHaveLength(0);
  });

  it('自定义执行器返回 failures 即触发回滚（可注入故障点）', () => {
    const harness = createHarness();
    const report = reportOf(harness);
    const faulty: RenameExecutor = {
      id: 'code-ast',
      column: 'code',
      label: '故障执行器',
      apply: (): ExecutorResult => ({
        column: 'code',
        applied: 0,
        skipped: 0,
        failures: ['模拟失败'],
        undo: [],
        snapshots: [] as FileSnapshot[],
        stateSnapshots: [],
        warnings: [],
      }),
      revert: () => undefined,
    };
    const result = executeRename({
      registry: harness.entry,
      newCanonicalName: '登录提交',
      report,
      selection: allSelected(report),
      deps: { ...harness.deps, executors: [faulty] },
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join()).toContain('模拟失败');
    expect(harness.files.get('src/pages/Login.tsx')).toBe(FILE_MAIN);
  });
});

describe('T7-04 性能（NFR-P-07：≤200 处变更 ≤5s）', () => {
  it('200 处代码变更在预算内完成（附实测）', () => {
    const FILES_PER_CASE = 10;
    const HITS_PER_FILE = 20;
    const files = new Map<string, string>();
    const occurrences: Occurrence[] = [];
    const entry = createRegistryEntry({
      projectId: 'p1',
      entityType: 'element',
      canonicalName: '登录按钮',
      rule: WEB,
      entityId: 'el-perf',
      id: 'reg-perf',
      scope: 'login',
      now: NOW,
      random: () => 0.5,
    }).entry;

    for (let file = 0; file < FILES_PER_CASE; file += 1) {
      const path = `src/generated/Component${file}.tsx`;
      const lines = [
        "import { LoginButton } from '../LoginButton';",
        ...Array.from(
          { length: HITS_PER_FILE },
          (_unused, index) => `const comp${index} = <LoginButton />;`,
        ),
      ];
      const content = lines.join('\n');
      files.set(path, content);
      for (let hit = 0; hit < HITS_PER_FILE; hit += 1) {
        // 跳过导入路径字符串（第 1 次出现），只用导入名与 JSX 使用处
        const occurrenceIndex = hit === 0 ? 0 : hit + 1;
        let cursor = -1;
        for (let index = 0; index <= occurrenceIndex; index += 1) {
          cursor = content.indexOf('LoginButton', cursor + 1);
        }
        const before = content.slice(0, cursor);
        occurrences.push({
          id: `perf-${file}-${hit}`,
          registryId: 'reg-perf',
          kind: 'code',
          refPath: path,
          locator: `${path}:${before.split('\n').length}:${cursor - before.lastIndexOf('\n')}`,
          matchedSymbol: 'component',
          symbol: 'LoginButton',
          confidence: 1,
          riskLevel: 'auto',
          status: 'active',
          role: 'jsx-tag',
          context: null,
          detail: null,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    }

    const harness = createHarness();
    for (const [path, content] of files) harness.files.set(path, content);
    const report = analyzeImpact({
      registry: entry,
      newCanonicalName: '登录提交',
      rule: WEB,
      occurrences,
      timer: () => NOW,
    });
    const selection = allSelected(report);
    expect(selection.size).toBe(FILES_PER_CASE * HITS_PER_FILE);

    const started = performance.now();
    const result = executeRename({
      registry: entry,
      newCanonicalName: '登录提交',
      report,
      selection,
      deps: { ...harness.deps, timer: () => performance.now() },
    });
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(true);
    // 200 处代码变更 + 1 处 Code Anchor 同步（锚点按符号命中，与代码位置无关）
    expect(result.segments.find((segment) => segment.executorId === 'code-ast')?.applied).toBe(200);
    expect(result.applied).toBe(201);
    expect(harness.files.get('src/generated/Component0.tsx')).toContain('<LoginSubmit />');
    process.stdout.write(
      `[T7-04 性能] 200 处代码变更执行 ${result.elapsedMs}ms（外部计时 ${elapsed.toFixed(2)}ms）\n`,
    );
    expect(result.elapsedMs).toBeLessThan(5000);
  });
});
