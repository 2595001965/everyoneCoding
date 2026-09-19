import { TABLE_COLUMNS } from '@ec/data';
import { describe, expect, it } from 'vitest';

import { AnchorRepository, type AnchorPersistencePort } from '../anchor-repo';
import {
  ANCHOR_KINDS,
  createCodeAnchor,
  fromCodeAnchorRow,
  toCodeAnchorRow,
  type AnchorDeclaration,
  type CodeAnchorRow,
} from '../anchor-model';
import {
  assertKindCoverage,
  createHeuristicAstAdapter,
  defaultAstAdapter,
  findSymbol,
  verifyDeclaration,
  verifyDeclarations,
} from '../ast-verify';
import {
  buildAnchorComment,
  commentPrefixFor,
  hasMarker,
  injectAnchorComments,
  parseAnchorComments,
  removeAnchorComments,
} from '../comment-marker';
import {
  editDistance,
  findCandidates,
  listMarkedLocations,
  nameSimilarity,
  relocate,
  tokenizeName,
} from '../reassociate';

/* ------------------------------ 夹具 ------------------------------ */

const TS_FILE = 'src/modules/auth/auth.controller.ts';
const TS_CONTENT = [
  '@Injectable()',
  'export class AuthController {',
  '  async login(dto: LoginDto) {',
  '    return this.service.login(dto);',
  '  }',
  '}',
  '',
].join('\n');

const PY_FILE = 'src/captcha/captcha_service.py';
const PY_CONTENT = [
  'class CaptchaService:',
  '    def verify(self, token, answer):',
  '        return True',
  '',
  'def hash_answer(answer):',
  '    return answer',
  '',
].join('\n');

const SQL_FILE = 'src/db/migration.sql';
const SQL_CONTENT = [
  '-- 用户表',
  'CREATE TABLE IF NOT EXISTS user_account (',
  '  id TEXT PRIMARY KEY',
  ');',
  '',
].join('\n');

const JAVA_FILE = 'src/main/java/UserService.java';
const JAVA_CONTENT = [
  'public class UserService {',
  '    public User find(String id) {',
  '        return repo.find(id);',
  '    }',
  '}',
  '',
].join('\n');

const FILES = new Map<string, string>([
  [TS_FILE, TS_CONTENT],
  [PY_FILE, PY_CONTENT],
  [SQL_FILE, SQL_CONTENT],
  [JAVA_FILE, JAVA_CONTENT],
]);

const DECL_LOGIN: AnchorDeclaration = {
  elementId: 'el-btn',
  filePath: TS_FILE,
  symbol: 'AuthController.login',
  kind: 'controller',
};

function repository(options: { persistence?: AnchorPersistencePort } = {}): AnchorRepository {
  let tick = 1_000;
  let sequence = 0;
  return new AnchorRepository({
    projectId: 'P1',
    clock: () => (tick += 1),
    idFactory: (index) => `anc-${index}-${(sequence += 1)}`,
    ...(options.persistence !== undefined ? { persistence: options.persistence } : {}),
  });
}

/* ------------------------------ 符号索引 ------------------------------ */

describe('多语言符号索引（T4-06 要点 3 的默认适配器）', () => {
  it('TS/ArkTS 索引类与方法，并给出精确行范围', () => {
    const entries = defaultAstAdapter.indexSymbols({ path: TS_FILE, content: TS_CONTENT });
    const controller = entries.find((entry) => entry.name === 'AuthController');
    const login = entries.find((entry) => entry.name === 'AuthController.login');
    expect(controller?.form).toBe('class');
    expect(controller?.startLine).toBe(2);
    expect(controller?.endLine).toBe(6);
    expect(login?.form).toBe('method');
    expect(login?.startLine).toBe(3);
    expect(login?.endLine).toBe(5);
  });

  it('Python 按缩进确定块边界', () => {
    const entries = defaultAstAdapter.indexSymbols({ path: PY_FILE, content: PY_CONTENT });
    expect(entries.find((entry) => entry.name === 'CaptchaService')?.form).toBe('class');
    expect(entries.find((entry) => entry.name === 'verify')?.form).toBe('method');
    expect(entries.find((entry) => entry.name === 'hash_answer')?.form).toBe('function');
  });

  it('Java 与 SQL 也能索引', () => {
    expect(
      defaultAstAdapter
        .indexSymbols({ path: JAVA_FILE, content: JAVA_CONTENT })
        .map((entry) => entry.name),
    ).toEqual(['UserService', 'UserService.find']);
    const sql = defaultAstAdapter.indexSymbols({ path: SQL_FILE, content: SQL_CONTENT });
    expect(sql[0]?.name).toBe('user_account');
    expect(sql[0]?.form).toBe('table');
  });

  it('findSymbol 支持完整名与容器内短名', () => {
    const entries = defaultAstAdapter.indexSymbols({ path: TS_FILE, content: TS_CONTENT });
    expect(findSymbol(entries, 'AuthController.login')?.name).toBe('AuthController.login');
    expect(findSymbol(entries, 'login')?.name).toBe('AuthController.login');
    expect(findSymbol(entries, '不存在')).toBeNull();
  });

  it('kind ↔ form 映射覆盖全部 7 类', () => {
    expect(() => assertKindCoverage()).not.toThrow();
    expect(ANCHOR_KINDS).toHaveLength(7);
  });

  it('适配器可替换（外壳可注入 ts-morph 实现）', () => {
    const adapter = createHeuristicAstAdapter();
    const custom = {
      indexSymbols: () => [
        { name: 'Anything', form: 'class' as const, startLine: 1, endLine: 1, container: null },
      ],
    };
    expect(adapter.indexSymbols({ path: 'a.ts', content: 'const a = 1;' }).length).toBeGreaterThan(
      0,
    );
    expect(
      verifyDeclaration({
        declaration: { ...DECL_LOGIN, symbol: 'Anything' },
        path: 'a.ts',
        content: 'x',
        adapter: custom,
      }).status,
    ).toBe('ok');
  });
});

/* ------------------------------ AST 校验反例 ------------------------------ */

describe('AST 校验识别虚假声明（T4-06 验收：3 个反例）', () => {
  it('反例 1：声明的符号在文件中不存在 → missing', () => {
    const result = verifyDeclaration({
      declaration: { ...DECL_LOGIN, symbol: 'AuthController.logout' },
      path: TS_FILE,
      content: TS_CONTENT,
    });
    expect(result.status).toBe('missing');
    expect(result.reason).toContain('不存在符号');
  });

  it('反例 2：声明行号与符号范围无交集 → drift', () => {
    const result = verifyDeclaration({
      declaration: { ...DECL_LOGIN, startLine: 500, endLine: 510 },
      path: TS_FILE,
      content: TS_CONTENT,
    });
    expect(result.status).toBe('drift');
    expect(result.reason).toContain('之外');
    expect(result.resolved?.startLine).toBe(3);
  });

  it('反例 3：kind 与符号实际形态不匹配（拿 SQL 锚点指向方法）→ drift', () => {
    const result = verifyDeclaration({
      declaration: { ...DECL_LOGIN, kind: 'sql' },
      path: TS_FILE,
      content: TS_CONTENT,
    });
    expect(result.status).toBe('drift');
    expect(result.reason).toContain('不匹配');
  });

  it('正例：声明与真实符号一致 → ok，并把真实位置写回', () => {
    const result = verifyDeclaration({
      declaration: DECL_LOGIN,
      path: TS_FILE,
      content: TS_CONTENT,
    });
    expect(result.status).toBe('ok');
    expect(result.resolved).toEqual({
      startLine: 3,
      endLine: 5,
      form: 'method',
      container: 'AuthController',
    });
  });

  it('文件不存在时判 missing（不抛错）', () => {
    const results = verifyDeclarations({
      declarations: [{ ...DECL_LOGIN, filePath: 'missing.ts' }],
      readFile: () => null,
    });
    expect(results[0]?.status).toBe('missing');
    expect(results[0]?.reason).toContain('文件不存在');
  });

  it('批量校验对同一文件只读取一次', () => {
    let reads = 0;
    verifyDeclarations({
      declarations: [DECL_LOGIN, { ...DECL_LOGIN, symbol: 'AuthController' }],
      readFile: () => {
        reads += 1;
        return TS_CONTENT;
      },
    });
    expect(reads).toBe(1);
  });
});

/* ------------------------------ 注释标记 ------------------------------ */

describe('注释标记（T4-06 要点 2）', () => {
  it('按语言选择注释前缀', () => {
    expect(commentPrefixFor('a.ts')).toBe('//');
    expect(commentPrefixFor('a.py')).toBe('#');
    expect(commentPrefixFor('a.sql')).toBe('--');
    expect(commentPrefixFor('a.ets')).toBe('//');
    expect(commentPrefixFor('unknown.xyz')).toBe('//');
  });

  it('生成 / 解析 / 移除标记（往返一致）', () => {
    const comment = buildAnchorComment({
      elementId: 'el-btn',
      symbol: 'AuthController.login',
      kind: 'controller',
      pathOrLanguage: TS_FILE,
    });
    expect(comment).toBe('// @everyonecoding:anchor el-btn AuthController.login controller');

    const parsed = parseAnchorComments(`\n${comment}\nexport class AuthController {}\n`, TS_FILE);
    expect(parsed).toEqual([
      { elementId: 'el-btn', symbol: 'AuthController.login', kind: 'controller', line: 2 },
    ]);

    const withMarker = `${comment}\n${TS_CONTENT}`;
    expect(hasMarker(withMarker, 'el-btn')).toBe(true);
    expect(removeAnchorComments(withMarker, 'el-btn').removed).toBe(1);
    expect(hasMarker(removeAnchorComments(withMarker, 'el-btn').content, 'el-btn')).toBe(false);
  });

  it('注入标记到符号声明上方（找不到符号时不乱插）', () => {
    const injected = injectAnchorComments(TS_CONTENT, {
      elementId: 'el-btn',
      symbols: [
        { symbol: 'AuthController.login', kind: 'controller' },
        { symbol: 'AuthController.ghost', kind: 'service' },
      ],
      pathOrLanguage: TS_FILE,
    });

    expect(injected.injected).toEqual(['AuthController.login']);
    expect(injected.unmatched).toEqual(['AuthController.ghost']);
    const lines = injected.content.split('\n');
    // 标记插在 `async login` 声明的上一行（index 2），而不是文件头
    expect(lines[2]).toBe(
      buildAnchorComment({
        elementId: 'el-btn',
        symbol: 'AuthController.login',
        kind: 'controller',
        pathOrLanguage: TS_FILE,
      }),
    );
    expect(lines[3]).toContain('async login');
    expect(lines[0]).toBe('@Injectable()');
    // 文件行数只增加 1（未匹配的符号没有产生空标记）
    expect(lines.length).toBe(TS_CONTENT.split('\n').length + 1);
  });

  it('注入后 AST 校验与标记解析都能定位到同一位置', () => {
    const injected = injectAnchorComments(TS_CONTENT, {
      elementId: 'el-btn',
      symbols: [{ symbol: 'AuthController.login', kind: 'controller' }],
      pathOrLanguage: TS_FILE,
    });
    const locations = listMarkedLocations(injected.content, TS_FILE);
    expect(locations).toEqual([
      { elementId: 'el-btn', symbol: 'AuthController.login', startLine: 4, endLine: 6 },
    ]);
  });
});

/* ------------------------------ 仓库与入库 ------------------------------ */

describe('AnchorRepository 入库（T4-06 要点 1、2）', () => {
  it('注册锚点后字段与 PRD §6.2 code_anchor 表逐列一致', () => {
    const repo = repository();
    const [registration] = repo.register({
      declarations: [
        DECL_LOGIN,
        { elementId: 'el-captcha', filePath: PY_FILE, symbol: 'verify', kind: 'service' },
      ],
      readFile: (path) => FILES.get(path) ?? null,
      pageId: 'page-login',
      featureId: 'feat-auth',
      commitSha: 'abc123',
    });

    expect(registration?.created).toBe(true);
    expect(registration?.verification.status).toBe('ok');

    const row = toCodeAnchorRow(registration!.anchor);
    expect(Object.keys(row)).toEqual(TABLE_COLUMNS.code_anchor);
    expect(row).toMatchObject({
      project_id: 'P1',
      element_id: 'el-btn',
      page_id: 'page-login',
      feature_id: 'feat-auth',
      file_path: TS_FILE,
      symbol: 'AuthController.login',
      start_line: 3,
      end_line: 5,
      kind: 'controller',
      commit_sha: 'abc123',
    });
    // 行来回转换不丢字段
    expect(fromCodeAnchorRow(row).symbol).toBe('AuthController.login');
  });

  it('三重锚定证据如实记录（声明 / 注释标记 / AST 校验）', () => {
    const withMarker = injectAnchorComments(TS_CONTENT, {
      elementId: 'el-btn',
      symbols: [{ symbol: 'AuthController.login', kind: 'controller' }],
      pathOrLanguage: TS_FILE,
    }).content;
    const files = new Map(FILES);
    files.set(TS_FILE, withMarker);

    const repo = repository();
    const [ok] = repo.register({
      declarations: [DECL_LOGIN],
      readFile: (path) => files.get(path) ?? null,
    });
    expect(ok?.markerFound).toBe(true);
    expect(ok?.anchor.evidence).toEqual({ declared: true, commentMarker: true, astVerified: true });
    expect(ok?.anchor.syncState).toBe('synced');

    const repo2 = repository();
    const [noMarker] = repo2.register({ declarations: [DECL_LOGIN], readFile: () => TS_CONTENT });
    expect(noMarker?.markerFound).toBe(false);
    expect(noMarker?.anchor.evidence.commentMarker).toBe(false);
  });

  it('虚假声明入库存为 missing，不会静默变成正常锚点', () => {
    const repo = repository();
    const [bad] = repo.register({
      declarations: [{ ...DECL_LOGIN, symbol: 'AuthController.ghost' }],
      readFile: () => TS_CONTENT,
    });
    expect(bad?.anchor.syncState).toBe('missing');
    expect(bad?.anchor.syncDetail).toContain('不存在符号');
    expect(repo.stats()).toMatchObject({ total: 1, synced: 0, missing: 1, drift: 0 });
    expect(repo.listUnhealthy()).toHaveLength(1);
  });

  it('同一 elementId + filePath + symbol 视为同一锚点（更新而非新增）', () => {
    const repo = repository();
    repo.register({ declarations: [DECL_LOGIN], readFile: () => TS_CONTENT });
    const [second] = repo.register({ declarations: [DECL_LOGIN], readFile: () => TS_CONTENT });
    expect(second?.created).toBe(false);
    expect(repo.list()).toHaveLength(1);
  });

  it('查询：按元素 / 按文件 / 统计分布', () => {
    const repo = repository();
    repo.register({
      declarations: [
        DECL_LOGIN,
        { elementId: 'el-btn', filePath: SQL_FILE, symbol: 'user_account', kind: 'sql' },
        { elementId: 'el-other', filePath: JAVA_FILE, symbol: 'UserService.find', kind: 'service' },
      ],
      readFile: (path) => FILES.get(path) ?? null,
    });

    expect(repo.listByElement('el-btn')).toHaveLength(2);
    expect(repo.listByFile(SQL_FILE)).toHaveLength(1);
    const stats = repo.stats();
    expect(stats.total).toBe(3);
    expect(stats.byKind.sql).toBe(1);
    expect(stats.byKind.service).toBe(1);
    expect(repo.list().map((anchor) => anchor.filePath)).toEqual(
      [TS_FILE, SQL_FILE, JAVA_FILE].sort(),
    );
  });

  it('订阅、删除、移出元素、持久化端口回读', async () => {
    const stored: CodeAnchorRow[] = [];
    const port: AnchorPersistencePort = {
      load: () => stored,
      save: ({ rows }) => {
        stored.splice(0, stored.length, ...rows);
      },
    };
    const repo = repository({ persistence: port });
    const listener = (): void => undefined;
    const off = repo.subscribe(listener);

    repo.register({ declarations: [DECL_LOGIN], readFile: () => TS_CONTENT });
    expect(stored).toHaveLength(1);
    expect(repo.getRevision()).toBe(1);

    off();
    const anchor = repo.list()[0];
    expect(anchor).toBeDefined();
    expect(repo.markDrift(anchor!.id, '手工标记')?.syncState).toBe('drift_detected');
    expect(repo.removeByElement('el-btn')).toBe(1);
    expect(repo.list()).toHaveLength(0);

    const second = new AnchorRepository({ projectId: 'P1', persistence: port });
    repo.register({ declarations: [DECL_LOGIN], readFile: () => TS_CONTENT });
    expect(await second.load()).toBe(1);
  });

  it('createCodeAnchor 的非法入参被 zod 拒绝', () => {
    expect(() => createCodeAnchor({ projectId: 'P1', filePath: '', kind: 'service' })).toThrow();
    expect(() =>
      createCodeAnchor({ projectId: 'P1', filePath: 'a.ts', kind: 'service', startLine: 0 }),
    ).toThrow();
  });
});

/* ------------------------------ 重定位与候选 ------------------------------ */

describe('行号漂移重定位（T4-06 要点 5）', () => {
  it('文件头部插入内容后，按符号名重新定位并更新行号', () => {
    const shifted = `// 新增的一行注释\n// 又一行\n${TS_CONTENT}`;
    const repo = repository();
    repo.register({ declarations: [DECL_LOGIN], readFile: () => TS_CONTENT });
    const anchor = repo.list()[0];
    expect(anchor?.startLine).toBe(3);

    const result = relocate({
      anchor: {
        elementId: 'el-btn',
        symbol: 'AuthController.login',
        filePath: TS_FILE,
        kind: 'controller',
      },
      content: shifted,
    });
    expect(result.status).toBe('ok');
    expect(result.startLine).toBe(5);
    expect(result.reason).toContain('符号名');

    const updated = repo.updateLocation(anchor!.id, {
      startLine: result.startLine!,
      endLine: result.endLine!,
    });
    expect(updated?.startLine).toBe(5);
    expect(updated?.syncState).toBe('synced');
  });

  it('优先依据代码内锚点标记定位（符号被改名也能找到）', () => {
    const renamed = TS_CONTENT.replace('async login(', 'async signIn(');
    const withMarker = injectAnchorComments(renamed, {
      elementId: 'el-btn',
      symbols: [{ symbol: 'signIn', kind: 'controller' }],
      pathOrLanguage: TS_FILE,
    }).content;

    const result = relocate({
      anchor: {
        elementId: 'el-btn',
        symbol: 'AuthController.login',
        filePath: TS_FILE,
        kind: 'controller',
      },
      content: withMarker,
    });
    expect(result.status).toBe('ok');
    expect(result.symbol).toBe('AuthController.signIn');
    expect(result.reason).toContain('锚点标记');
  });

  it('符号彻底找不到时给出候选而不是错误地自动改锚点', () => {
    const renamed = TS_CONTENT.replace('async login(', 'async signIn(');
    const result = relocate({
      anchor: {
        elementId: 'el-btn',
        symbol: 'AuthController.login',
        filePath: TS_FILE,
        kind: 'controller',
      },
      content: renamed,
    });
    expect(result.status).toBe('ambiguous');
    expect(result.startLine).toBeNull();
    expect(result.candidates[0]?.symbol).toBe('AuthController.signIn');
    expect(result.candidates[0]?.reason).toContain('名称相似度');
  });

  it('文件里完全没有可关联符号时判 missing', () => {
    const result = relocate({
      anchor: {
        elementId: 'el-btn',
        symbol: 'AuthController.login',
        filePath: TS_FILE,
        kind: 'controller',
      },
      content: '// 空文件\n',
    });
    expect(result.status).toBe('missing');
    expect(result.candidates).toEqual([]);
  });
});

describe('候选推荐排序（T4-06 要点 4）', () => {
  it('同文件 + kind 匹配的候选排在前面', () => {
    const contents = new Map(FILES);
    contents.set(TS_FILE, TS_CONTENT.replace('async login(', 'async signIn('));

    const candidates = findCandidates({
      anchor: {
        symbol: 'AuthController.login',
        kind: 'controller',
        filePath: TS_FILE,
        elementId: 'el-btn',
      },
      contents,
    });

    expect(candidates[0]?.symbol).toBe('AuthController.signIn');
    expect(candidates[0]?.score).toBeGreaterThan(0.5);
    expect(
      candidates.every(
        (candidate, index) => index === 0 || candidate.score <= (candidates[index - 1]?.score ?? 0),
      ),
    ).toBe(true);
  });

  it('元素规范名也可作为匹配依据（锚点已彻底丢失时）', () => {
    const candidates = findCandidates({
      anchor: null,
      elementName: 'CaptchaService',
      contents: new Map(FILES),
    });
    expect(candidates[0]?.symbol).toBe('CaptchaService');
  });

  it('limit 生效且低相似度被过滤', () => {
    expect(
      findCandidates({
        anchor: null,
        elementName: 'CaptchaService',
        contents: new Map(FILES),
        limit: 1,
      }),
    ).toHaveLength(1);
    expect(
      findCandidates({
        anchor: null,
        elementName: 'CompletelyDifferentName',
        contents: new Map(FILES),
      }),
    ).toEqual([]);
  });

  it('名称相似度与切词符合"命名投影"预期', () => {
    expect(tokenizeName('AuthController.login')).toEqual(['auth', 'controller', 'login']);
    expect(nameSimilarity('login', 'AuthController.login')).toBeLessThanOrEqual(1);
    expect(nameSimilarity('authcontrollerlogin', 'AuthController.login')).toBe(1);
    expect(nameSimilarity('login', 'signIn')).toBeLessThan(0.5);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});
