/**
 * 内存假导航端口：不碰 SQLite / 文件系统，只驱动渲染层测试。
 *
 * 关键数据形态（与验收口径对齐）：
 * - `hoverTargets` 返回 4 类目标（后端接口 / 数据库表 / 测试用例 / 技术文档章节），
 *   score 严格降序（1.40 / 1.10 / 0.90 / 0.60），且有两个 > 1 的原始分；
 * - `resolveJump` 返回 4 个层级（Controller → Service → 数据访问层 → 测试）且 needsChoice 为真；
 * - `relationGraph` 覆盖 5 类节点 + 6 类边；
 * - `dataFlow` 覆盖 6 个环节，其中「后端处理」失败。
 */
import type {
  JumpOutcome,
  JumpResolution,
  NavTarget,
  RelationEdge,
  RelationGraph,
  RelationNode,
  ReverseJumpResult,
} from '@ec/ai';

import type { DataFlowStep, JumpStats, NavApi, NavJumpRequest } from '../nav-api';

function target(
  id: string,
  kind: NavTarget['kind'],
  label: string,
  detail: string,
  score: number,
  layer: number,
): NavTarget {
  return {
    id,
    kind,
    label,
    detail,
    filePath: kind === 'element' || kind === 'page' ? null : `src/${id}.ts`,
    symbol: null,
    startLine: 10,
    endLine: 30,
    layer,
    score,
    reasons: [`相关度 ${score}`],
  };
}

/** 4 类目标，分数降序（前两个 raw > 1，验证不是并列 1.0 后被字典序打乱） */
export const HOVER_TARGETS: readonly NavTarget[] = [
  target(
    'anc-login',
    'backend-api',
    'POST /auth/login',
    'server/auth/auth.controller.ts · login',
    1.4,
    0,
  ),
  target('tbl-user', 'db-table', 'users 表', 'server/db/schema.ts · users', 1.1, 2),
  target('test-login', 'test-case', '登录接口用例', 'tests/auth/login.spec.ts · 登录成功', 0.9, 3),
  target('doc-auth', 'doc-section', '技术文档 · 认证设计', 'docs/tech/auth.md · 认证', 0.6, 4),
];

function layeredResolution(): JumpResolution {
  const controller = target(
    'anc-ctl',
    'backend-api',
    'AuthController.login',
    'server/auth/auth.controller.ts',
    1.4,
    0,
  );
  const service = target(
    'anc-svc',
    'backend-module',
    'AuthService.verify',
    'server/auth/auth.service.ts',
    1.3,
    1,
  );
  const repo = target(
    'anc-repo',
    'backend-module',
    'UserRepository.findByEmail',
    'server/auth/user.repo.ts',
    1.2,
    2,
  );
  const test = target('anc-test', 'test-case', 'login.spec.ts', 'tests/auth/login.spec.ts', 1.1, 3);
  return {
    elementId: 'e-login',
    layers: [
      { layer: 0, label: 'Controller 方法', targets: [controller] },
      { layer: 1, label: 'Service', targets: [service] },
      { layer: 2, label: '数据访问层', targets: [repo] },
      { layer: 3, label: '测试', targets: [test] },
    ],
    targets: [controller, service, repo, test],
    preferred: null,
    needsChoice: true,
  };
}

function sampleGraph(): RelationGraph {
  const nodes: RelationNode[] = [
    { id: 'p1', type: 'page', label: '登录页', group: 'p1', filePath: null, degree: 1 },
    { id: 'e1', type: 'element', label: '登录按钮', group: 'p1', filePath: null, degree: 2 },
    {
      id: 'a1',
      type: 'api',
      label: 'POST /auth/login',
      group: 'auth',
      filePath: 'server/auth/auth.controller.ts',
      degree: 3,
    },
    {
      id: 'm1',
      type: 'module',
      label: 'AuthService',
      group: 'auth',
      filePath: 'server/auth/auth.service.ts',
      degree: 3,
    },
    {
      id: 'm2',
      type: 'module',
      label: 'login.spec.ts',
      group: 'auth',
      filePath: 'tests/auth/login.spec.ts',
      degree: 1,
    },
    { id: 't1', type: 'table', label: 'users', group: 'auth', filePath: null, degree: 1 },
    { id: 't2', type: 'table', label: 'login_logs', group: 'auth', filePath: null, degree: 1 },
  ];
  const edges: RelationEdge[] = [
    { id: 'x1', type: 'contains', from: 'p1', to: 'e1', label: '包含' },
    { id: 'x2', type: 'binds', from: 'e1', to: 'a1', label: '绑定' },
    { id: 'x3', type: 'calls', from: 'a1', to: 'm1', label: '调用' },
    { id: 'x4', type: 'reads', from: 'm1', to: 't1', label: '读取' },
    { id: 'x5', type: 'writes', from: 'm1', to: 't2', label: '写入' },
    { id: 'x6', type: 'tests', from: 'm2', to: 'a1', label: '覆盖' },
  ];
  return { nodes, edges, stats: { page: 1, element: 1, api: 1, module: 2, table: 2 } };
}

const FLOW_STEPS: readonly DataFlowStep[] = [
  { id: 'f1', kind: 'element', label: '登录按钮', detail: 'Button#login', at: 0, ok: true },
  { id: 'f2', kind: 'event', label: 'onClick 触发', detail: 'submitForm', at: 2, ok: true },
  { id: 'f3', kind: 'api', label: 'POST /auth/login', detail: '200 OK', at: 26, ok: true },
  {
    id: 'f4',
    kind: 'backend',
    label: 'AuthService.verify',
    detail: '数据库连接超时',
    at: 1024,
    ok: false,
  },
  { id: 'f5', kind: 'writeback', label: '写入 login_logs', detail: '1 行', at: 1030, ok: true },
  { id: 'f6', kind: 'render', label: '按钮进入错误态', detail: null, at: 1040, ok: true },
];

export interface FakeNavCalls {
  hoverTargets: NavJumpRequest[];
  resolveJump: NavJumpRequest[];
  commitJump: NavTarget[];
}

export interface FakeNavApi extends NavApi {
  readonly calls: FakeNavCalls;
}

export function createFakeNavApi(): FakeNavApi {
  const calls: FakeNavCalls = { hoverTargets: [], resolveJump: [], commitJump: [] };

  return {
    ready: true,
    calls,

    async hoverTargets(request) {
      calls.hoverTargets.push(request);
      return HOVER_TARGETS;
    },
    async resolveJump(request): Promise<JumpResolution> {
      calls.resolveJump.push(request);
      return layeredResolution();
    },
    async commitJump(target_): Promise<JumpOutcome> {
      calls.commitJump.push(target_);
      return { success: true, target: target_, message: `已跳转到 ${target_.label}` };
    },
    async jumpStats(): Promise<JumpStats> {
      return {
        forward: { total: 20, success: 19, rate: 0.95 },
        reverse: { total: 20, success: 20, rate: 1 },
      };
    },
    async relationGraph() {
      return sampleGraph();
    },
    async reverseJump(input): Promise<ReverseJumpResult> {
      return {
        success: true,
        hits: [
          {
            elementId: 'e-login',
            filePath: input.filePath,
            line: input.line,
            anchorId: 'anc-login',
            element: {
              elementId: 'e-login',
              name: '登录按钮',
              type: 'Button',
              pageId: 'p1',
              pageName: '登录页',
            },
            page: null,
          },
        ],
        message: '已定位到设计器元素',
      };
    },
    async dataFlow() {
      return FLOW_STEPS;
    },
  };
}

/** 便于测试构造元素引用 */
export const SAMPLE_ELEMENT = {
  elementId: 'e-login',
  name: '登录按钮',
  type: 'Button',
  pageId: 'p1',
  pageName: '登录页',
} as const;
