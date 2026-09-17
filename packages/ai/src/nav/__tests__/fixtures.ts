import type { AnchorKind, AnchorSyncState, CodeAnchor } from '../../anchors';
import type {
  NavApiRef,
  NavDocSectionRef,
  NavElementRef,
  NavModuleRef,
  NavPageRef,
  NavSourcePort,
  NavTableRef,
  NavTestRef,
} from '../source-model';

/**
 * 测试夹具：提供若干可注入的 `NavSourcePort` 实现。
 * - `makeBidirectionalSource`：20 组 element↔anchor（含 2 组"文件不存在"失败路径），供双向跳转成功率测试
 * - `makeRelationSource`：页面/元素/接口/模块/表/测试齐全，供关系图测试
 * - `makeHoverSource`：单元素 + 四类清单，供悬停解析测试
 * - `makeLayeredSource`：单元素 4 层锚点，供层级分组测试
 */

/** 构造一个完整 CodeAnchor（缺省为已同步且三重锚定） */
interface AnchorSeed {
  id: string;
  projectId: string;
  elementId: string | null;
  pageId: string | null;
  filePath: string;
  symbol: string | null;
  kind: AnchorKind;
  startLine: number | null;
  endLine: number | null;
  syncState?: AnchorSyncState;
  commentMarker?: boolean;
  astVerified?: boolean;
}

function makeAnchor(seed: AnchorSeed): CodeAnchor {
  const syncState: AnchorSyncState = seed.syncState ?? 'synced';
  const healthy = syncState === 'synced';
  return {
    id: seed.id,
    projectId: seed.projectId,
    elementId: seed.elementId,
    pageId: seed.pageId,
    featureId: null,
    filePath: seed.filePath,
    symbol: seed.symbol,
    startLine: seed.startLine,
    endLine: seed.endLine,
    kind: seed.kind,
    commitSha: null,
    syncState,
    syncDetail: healthy ? null : '锚点丢失',
    evidence: {
      declared: true,
      commentMarker: seed.commentMarker ?? healthy,
      astVerified: seed.astVerified ?? healthy,
    },
    createdAt: 1000,
    updatedAt: 1000,
  };
}

interface SourceInput {
  anchors: CodeAnchor[];
  pages: NavPageRef[];
  apis?: NavApiRef[];
  tables?: NavTableRef[];
  tests?: NavTestRef[];
  docSections?: NavDocSectionRef[];
  modules?: NavModuleRef[];
  files?: Map<string, string>;
}

/** 通用数据源工厂：把内存数据适配成 NavSourcePort（全只读） */
function makeSource(input: SourceInput): NavSourcePort {
  const files = input.files ?? new Map<string, string>();
  return {
    listAnchors: () => input.anchors,
    listPages: () => input.pages,
    listApis: () => input.apis ?? [],
    listTables: () => input.tables ?? [],
    listTests: () => input.tests ?? [],
    listDocSections: () => input.docSections ?? [],
    listModules: () => input.modules ?? [],
    readFile: (path: string) => files.get(path) ?? null,
    listCodeFiles: () => [...files.keys()],
  };
}

/**
 * 20 组 element↔anchor。第 13、17 组为"文件不存在"（forward 跳转失败路径），
 * 其余 18 组文件真实存在；所有 20 个元素的 anchor 标记都写在 `markers.ts` 里（反向跳转均命中）。
 * 正向 20 次（2 失败）+ 反向 20 次（0 失败）= 40 次，成功率 38/40 = 0.95。
 */
export function makeBidirectionalSource(): NavSourcePort {
  const anchors: CodeAnchor[] = [];
  const elements: NavElementRef[] = [];
  const files = new Map<string, string>();
  const markerLines: string[] = [];

  for (let i = 1; i <= 20; i += 1) {
    const elementId = `el-g${i}`;
    const lost = i === 13 || i === 17;
    const filePath = lost ? `src/lost/group${i}.ts` : `src/app/groups/group${i}.ts`;
    elements.push({ elementId, name: `按钮${i}`, type: 'Button', pageId: 'p-login', pageName: '登录页' });
    anchors.push(
      makeAnchor({
        id: `anc-g${i}`,
        projectId: 'P1',
        elementId,
        pageId: 'p-login',
        filePath,
        symbol: `Group${i}Service.handle`,
        kind: 'service',
        startLine: 10,
        endLine: 20,
        syncState: lost ? 'missing' : 'synced',
        commentMarker: !lost,
        astVerified: !lost,
      }),
    );
    if (!lost) {
      files.set(
        filePath,
        [`export class Group${i}Service {`, `  handle() {`, `    return ${i};`, `  }`, `}`].join('\n'),
      );
    }
    markerLines.push(`// @everyonecoding:anchor ${elementId} Group${i}Service.handle service`);
  }

  files.set('src/app/groups/markers.ts', markerLines.join('\n'));

  const page: NavPageRef = {
    pageId: 'p-login',
    name: '登录页',
    route: '/auth/login',
    featureId: 'feat-auth',
    elements,
    apiDeps: [],
  };

  return makeSource({ anchors, pages: [page], files });
}

/** 关系图夹具：页面(1)→元素(2)→接口(2)→模块(2)→表(2)，测试覆盖接口 */
export function makeRelationSource(): NavSourcePort {
  const page: NavPageRef = {
    pageId: 'p-order',
    name: '订单页',
    route: '/order',
    featureId: 'feat-order',
    elements: [
      { elementId: 'el-order-btn', name: '提交按钮', type: 'Button', pageId: 'p-order', pageName: '订单页' },
      { elementId: 'el-order-list', name: '订单列表', type: 'List', pageId: 'p-order', pageName: '订单页' },
    ],
    apiDeps: ['api-create-order', 'api-list-order'],
  };
  const apis: NavApiRef[] = [
    { id: 'api-create-order', name: 'createOrder', method: 'POST', path: '/api/orders', module: 'order-service' },
    { id: 'api-list-order', name: 'listOrder', method: 'GET', path: '/api/orders', module: 'order-service' },
  ];
  const modules: NavModuleRef[] = [
    { id: 'mod-order-svc', name: 'order-service', filePath: 'src/order/order.service.ts', role: 'service' },
    { id: 'mod-order-repo', name: 'order-repo', filePath: 'src/order/order.repo.ts', role: 'repo' },
  ];
  const tables: NavTableRef[] = [
    { id: 'tbl-order', name: 'order', module: 'order-repo' },
    { id: 'tbl-order-item', name: 'order_item', module: 'order-service' },
  ];
  const tests: NavTestRef[] = [
    { id: 'test-order', name: 'OrderServiceTest', filePath: 'src/order/order.service.spec.ts', coversApi: 'api-create-order' },
  ];
  return makeSource({ anchors: [], pages: [page], apis, modules, tables, tests, docSections: [], files: new Map() });
}

/** 悬停解析夹具：单元素 + 该元素的 controller 锚点 + 四类清单各一条 */
export function makeHoverSource(): NavSourcePort {
  const page: NavPageRef = {
    pageId: 'p-login',
    name: '登录页',
    route: '/auth/login',
    featureId: 'feat-auth',
    elements: [{ elementId: 'el-login-btn', name: '登录按钮', type: 'Button', pageId: 'p-login', pageName: '登录页' }],
    apiDeps: [],
  };
  const anchors: CodeAnchor[] = [
    makeAnchor({
      id: 'anc-login',
      projectId: 'P1',
      elementId: 'el-login-btn',
      pageId: 'p-login',
      filePath: 'src/auth/auth.controller.ts',
      symbol: 'AuthController.login',
      kind: 'controller',
      startLine: 12,
      endLine: 18,
      commentMarker: true,
      astVerified: true,
    }),
  ];
  const apis: NavApiRef[] = [{ id: 'api-login', name: 'login', method: 'POST', path: '/api/login', module: 'auth-service' }];
  const tables: NavTableRef[] = [{ id: 'tbl-user', name: 'user_account', module: 'auth-repo' }];
  const tests: NavTestRef[] = [
    { id: 'test-login', name: 'AuthLoginTest', filePath: 'src/auth/auth.spec.ts', coversApi: 'api-login' },
  ];
  const docSections: NavDocSectionRef[] = [
    { id: 'doc-login', title: '登录流程', documentId: 'doc-auth', documentTitle: '认证技术文档', anchor: 'login' },
  ];
  return makeSource({ anchors, pages: [page], apis, tables, tests, docSections, files: new Map() });
}

/** 层级分组夹具：单元素具备 Controller(0)/Service(1)/Repo(2)/Test(3) 四个锚点 */
export function makeLayeredSource(): NavSourcePort {
  const page: NavPageRef = {
    pageId: 'p-x',
    name: 'X 页',
    route: '/x',
    featureId: null,
    elements: [{ elementId: 'el-x', name: 'X 按钮', type: 'Button', pageId: 'p-x', pageName: 'X 页' }],
    apiDeps: [],
  };
  const anchors: CodeAnchor[] = [
    makeAnchor({ id: 'a0', projectId: 'P1', elementId: 'el-x', pageId: 'p-x', filePath: 'c.ts', symbol: 'Ctrl.m', kind: 'controller', startLine: 1, endLine: 2, commentMarker: true, astVerified: true }),
    makeAnchor({ id: 'a1', projectId: 'P1', elementId: 'el-x', pageId: 'p-x', filePath: 's.ts', symbol: 'Svc.m', kind: 'service', startLine: 1, endLine: 2, commentMarker: true, astVerified: true }),
    makeAnchor({ id: 'a2', projectId: 'P1', elementId: 'el-x', pageId: 'p-x', filePath: 'r.ts', symbol: 'Repo.m', kind: 'repo', startLine: 1, endLine: 2, commentMarker: true, astVerified: true }),
    makeAnchor({ id: 'a3', projectId: 'P1', elementId: 'el-x', pageId: 'p-x', filePath: 't.ts', symbol: 'SvcTest.m', kind: 'test', startLine: 1, endLine: 2, commentMarker: true, astVerified: true }),
  ];
  return makeSource({ anchors, pages: [page], files: new Map() });
}

/** 反向扫描夹具：含缩进、行尾注释、重复标记的示例文件 */
export function makeReverseSource(): NavSourcePort {
  const page: NavPageRef = {
    pageId: 'p-rev',
    name: '反向页',
    route: '/rev',
    featureId: null,
    elements: [
      { elementId: 'el-a', name: '元素A', type: 'Button', pageId: 'p-rev', pageName: '反向页' },
      { elementId: 'el-b', name: '元素B', type: 'Input', pageId: 'p-rev', pageName: '反向页' },
    ],
    apiDeps: [],
  };
  const content = [
    '  // @everyonecoding:anchor el-a Button.click controller',
    'const x = 1; // @everyonecoding:anchor el-b Widget.render service',
    '// 普通注释，无标记',
    '// @everyonecoding:anchor el-a Button.click controller',
  ].join('\n');
  const files = new Map<string, string>([['sample.ts', content]]);
  return makeSource({ anchors: [], pages: [page], files });
}
