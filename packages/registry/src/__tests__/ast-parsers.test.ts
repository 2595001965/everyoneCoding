/**
 * 出现位置 AST 解析器测试（TS / Python / Java）。
 *
 * 仅用 vitest（`globals: false`），断言精确到「某条命中存在 / 不存在」与行列号。
 */

import { describe, expect, it } from 'vitest';

import { createTsParser } from '../occurrence/ast/ts-parser';
import { createPythonParser } from '../occurrence/ast/python-parser';
import { createJavaParser } from '../occurrence/ast/java-parser';
import type { ExternalAstParserPort, SymbolTarget } from '../occurrence/types';

const COMPONENT: SymbolTarget[] = [{ kind: 'component', value: 'UserLoginButton' }];
const ROUTE: SymbolTarget[] = [{ kind: 'routeSegment', value: '/user-login-button' }];
const METHOD_PY: SymbolTarget[] = [{ kind: 'methodName', value: 'handle_login_button' }];
const STRING_PY: SymbolTarget[] = [{ kind: 'routeSegment', value: '/user-login-button' }];
const METHOD_JAVA: SymbolTarget[] = [{ kind: 'methodName', value: 'handleUserLoginButton' }];
const APIFIELD: SymbolTarget[] = [{ kind: 'apiField', value: 'userLoginButton' }];

// ---------------------------------------------------------------------------
// TS / TSX
// ---------------------------------------------------------------------------
describe('ts-parser (ts/tsx/js/jsx)', () => {
  const parser = createTsParser('tsx');

  it('基本命中：import 绑定名 + JSX 标签，行列号正确', () => {
    const content = [
      "import { UserLoginButton } from './x';",
      'const el = <UserLoginButton />;',
    ].join('\n');
    const { hits } = parser.parse({ path: 'a.tsx', content, targets: COMPONENT });

    const imp = hits.find((h) => h.role === 'import');
    const jsx = hits.find((h) => h.role === 'jsx-tag');
    expect(imp).toBeDefined();
    expect(imp!.line).toBe(1);
    expect(imp!.column).toBe(10); // import { ░UserLoginButton
    expect(imp!.length).toBe(15);
    expect(jsx).toBeDefined();
    expect(jsx!.line).toBe(2);
    expect(jsx!.column).toBe(13); // const el = <░UserLoginButton
    expect(jsx!.length).toBe(15);
  });

  it('基本命中（ts）：new 表达式作为调用引用', () => {
    const content = [
      "import { UserLoginButton } from './x';",
      'const el = new UserLoginButton();',
    ].join('\n');
    const { hits } = parser.parse({ path: 'a.ts', content, targets: COMPONENT });
    const call = hits.find((h) => h.role === 'call');
    expect(call).toBeDefined();
    expect(call!.line).toBe(2);
    expect(call!.column).toBe(16); // const el = new ░UserLoginButton
    expect(call!.length).toBe(15);
  });

  it('反例①：注释中的同名文本不命中', () => {
    const content = [
      "import { UserLoginButton } from './x';",
      '// UserLoginButton',
      'const a = new UserLoginButton(); /* userLoginButton */',
    ].join('\n');
    const { hits } = parser.parse({ path: 'a.tsx', content, targets: COMPONENT });
    // 只应有 import 与 new 两处
    expect(hits).toHaveLength(2);
    expect(hits.filter((h) => h.line === 2).length).toBe(0);
    expect(hits.find((h) => h.role === 'import')!.line).toBe(1);
    expect(hits.find((h) => h.role === 'call')!.line).toBe(3);
    expect(hits.find((h) => h.role === 'call')!.column).toBe(15);
  });

  it('反例②：标识符投影不匹配字符串字面量；字符串投影整串精确匹配', () => {
    const content = [
      "import { UserLoginButton } from './x';",
      "const s = 'UserLoginButton';",
      "const p = '/user-login-button';",
      'const el = <UserLoginButton />;',
    ].join('\n');
    const { hits } = parser.parse({
      path: 'a.tsx',
      content,
      targets: [...COMPONENT, ...ROUTE],
    });
    // 字符串里的 'UserLoginButton' 不应作为 component 命中
    expect(hits.filter((h) => h.symbol === 'UserLoginButton' && h.line === 2).length).toBe(0);
    // 但路由字符串整串精确匹配
    const str = hits.find((h) => h.role === 'string-literal');
    expect(str).toBeDefined();
    expect(str!.symbol).toBe('/user-login-button');
    expect(str!.matchedSymbol).toBe('routeSegment');
    expect(str!.line).toBe(3);
    expect(str!.column).toBe(12); // const p = '░/user-login-button
    expect(str!.length).toBe(18);
  });

  it('反例③：内层同名局部变量遮蔽，模块级引用仍命中', () => {
    const content = [
      'function helper() {',
      '  const UserLoginButton = 1;',
      '  return UserLoginButton;',
      '}',
      'const el = new UserLoginButton();',
    ].join('\n');
    const { hits } = parser.parse({ path: 'a.ts', content, targets: COMPONENT });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(5);
    expect(hits[0]!.column).toBe(16);
    expect(hits.filter((h) => h.line === 2 || h.line === 3).length).toBe(0);
  });

  it('反例④：第三方库同名符号排除；this 成员访问收录且置信度 0.8', () => {
    const content = [
      "import { UserLoginButton } from './x';",
      'lib.UserLoginButton();',
      'foo.userLoginButton();',
      'this.UserLoginButton();',
      'const el = new UserLoginButton();',
    ].join('\n');
    const { hits } = parser.parse({
      path: 'a.ts',
      content,
      targets: [...COMPONENT, ...APIFIELD],
    });
    // lib / foo 成员访问排除
    expect(hits.filter((h) => h.line === 2 || h.line === 3).length).toBe(0);
    const member = hits.find((h) => h.role === 'member-access');
    expect(member).toBeDefined();
    expect(member!.confidence).toBe(0.8);
    expect(member!.note).toContain('this/super');
    expect(member!.symbol).toBe('UserLoginButton');
    expect(hits.find((h) => h.role === 'call')!.line).toBe(5);
  });

  it('degradation 恒为 null', () => {
    const { degradation } = parser.parse({ path: 'a.ts', content: '', targets: COMPONENT });
    expect(degradation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------
describe('python-parser (builtin scope tokenizer)', () => {
  const parser = createPythonParser();

  it('基本命中：def 声明名作为 declaration', () => {
    const content = ['def handle_login_button():', '    return', 'handle_login_button = 1'].join(
      '\n',
    );
    const { hits } = parser.parse({ path: 'a.py', content, targets: METHOD_PY });
    const decl = hits.filter((h) => h.role === 'declaration');
    expect(decl.length).toBeGreaterThanOrEqual(1);
    expect(decl.some((h) => h.line === 1 && h.symbol === 'handle_login_button')).toBe(true);
  });

  it('反例：三引号串、# 注释、字符串中的符号名不命中；module 级赋值命中', () => {
    const content = [
      '# handle_login_button',
      "'''handle_login_button inside triple quote'''",
      'def handle_login_button():',
      '    return',
      'handle_login_button = 1',
      'def outer():',
      '    handle_login_button = 2',
      '    return handle_login_button',
    ].join('\n');
    const { hits } = parser.parse({ path: 'a.py', content, targets: METHOD_PY });
    // 注释 / 三引号串 / 内部局部遮蔽均不应产生命中
    expect(hits.filter((h) => h.line === 1).length).toBe(0);
    expect(hits.filter((h) => h.line === 2).length).toBe(0);
    expect(hits.filter((h) => h.line === 7 || h.line === 8).length).toBe(0);
    // module 级 def + 赋值共两处 declaration
    const decl = hits.filter((h) => h.role === 'declaration' && h.symbol === 'handle_login_button');
    expect(decl).toHaveLength(2);
  });

  it('字符串投影：整串精确匹配', () => {
    const content = ["x = '/user-login-button'", "y = '''/user-login-button'''"].join('\n');
    const { hits } = parser.parse({ path: 'a.py', content, targets: STRING_PY });
    const strs = hits.filter((h) => h.role === 'string-literal');
    expect(strs).toHaveLength(2);
    expect(strs.every((h) => h.symbol === '/user-login-button')).toBe(true);
  });

  it('degradation 非 null（内置解析器）', () => {
    const { degradation } = parser.parse({ path: 'a.py', content: '', targets: METHOD_PY });
    expect(degradation).not.toBeNull();
    expect(degradation!.fallback).toBe('builtin-scope-tokenizer');
  });

  it('degradation 为 null 当 port 返回非 null', () => {
    const fakePort: ExternalAstParserPort = {
      language: 'python',
      parse: () => ({ hits: [], degradation: null }),
    };
    const p = createPythonParser(fakePort);
    const { degradation } = p.parse({ path: 'a.py', content: '', targets: METHOD_PY });
    expect(degradation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------
describe('java-parser (builtin brace tokenizer)', () => {
  const parser = createJavaParser();

  it('基本命中：字段声明 + this 成员访问', () => {
    const content = [
      '/** handleUserLoginButton doc */',
      'class Page {',
      '  String handleUserLoginButton = "x";',
      '  void render() {',
      '    String handleUserLoginButton = "y";',
      '    this.handleUserLoginButton();',
      '  }',
      '}',
    ].join('\n');
    const { hits } = parser.parse({ path: 'A.java', content, targets: METHOD_JAVA });
    // javadoc / 行注释不应命中
    expect(hits.filter((h) => h.line === 1).length).toBe(0);
    // 字段 declaration
    const decl = hits.find((h) => h.role === 'declaration' && h.symbol === 'handleUserLoginButton');
    expect(decl).toBeDefined();
    expect(decl!.line).toBe(3);
    // 局部同名遮蔽不应命中
    expect(hits.filter((h) => h.line === 5).length).toBe(0);
    // this 成员访问 0.8
    const member = hits.find((h) => h.role === 'member-access');
    expect(member).toBeDefined();
    expect(member!.confidence).toBe(0.8);
    expect(member!.note).toContain('this/super');
    expect(member!.line).toBe(6);
  });

  it('字符串里的标识符名不命中', () => {
    const content = ['class A {', '  String s = "handleUserLoginButton";', '}'].join('\n');
    const { hits } = parser.parse({ path: 'A.java', content, targets: METHOD_JAVA });
    expect(hits.filter((h) => h.symbol === 'handleUserLoginButton').length).toBe(0);
  });

  it('degradation 非 null（内置解析器）', () => {
    const { degradation } = parser.parse({ path: 'A.java', content: '', targets: METHOD_JAVA });
    expect(degradation).not.toBeNull();
    expect(degradation!.fallback).toBe('builtin-brace-tokenizer');
  });

  it('degradation 为 null 当 port 返回非 null', () => {
    const fakePort: ExternalAstParserPort = {
      language: 'java',
      parse: () => ({ hits: [], degradation: null }),
    };
    const p = createJavaParser(fakePort);
    const { degradation } = p.parse({ path: 'A.java', content: '', targets: METHOD_JAVA });
    expect(degradation).toBeNull();
  });
});
