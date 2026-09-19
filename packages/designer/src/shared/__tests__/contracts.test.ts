import { describe, expect, it } from 'vitest';

import { createLoginPageDsl } from '../../dsl/factory';
import {
  ComponentRegistry,
  componentRegistry,
  registerCustomComponent,
} from '../../registry/component-registry';
import {
  defineSchema,
  fieldVisible,
  groupFields,
  schemaDefaults,
  validatePropSchema,
} from '../../registry/prop-schema';
import {
  collectConditionPaths,
  createCondition,
  describeCondition,
  evaluateCondition,
  evaluatePermission,
  isConditionExpr,
  parseCondition,
  validateCondition,
} from '../condition';
import {
  createDataSourceProvider,
  findReferencingElements,
  getDataSources,
  listDataSourcePaths,
} from '../data-source';
import {
  collectExpressionPaths,
  formatPath,
  parsePath,
  readPath,
  resolveExpression,
  resolveTemplate,
  toExpression,
  writePath,
} from '../expression';

describe('共享契约：路径表达式', () => {
  it('解析点号与下标路径', () => {
    expect(parsePath('user.list[0].name')).toEqual(['user', 'list', 0, 'name']);
    expect(parsePath('items[2]')).toEqual(['items', 2]);
    expect(parsePath("map['key with space']")).toEqual(['map', 'key with space']);
    expect(formatPath(['user', 'list', 0, 'name'])).toBe('user.list[0].name');
  });

  it('拒绝非法路径与字面量', () => {
    expect(parsePath('')).toBeNull();
    expect(parsePath('.a')).toBeNull();
    expect(parsePath('a..b')).toBeNull();
    expect(parsePath('a[')).toBeNull();
    expect(parsePath('123')).toBeNull();
    expect(parsePath('true')).toBeNull();
    expect(parsePath("'text'")).toBeNull();
  });

  it('读写路径值', () => {
    const scope = { user: { list: [{ name: '张三' }] }, count: 1 };
    expect(readPath(scope, 'user.list[0].name')).toBe('张三');
    expect(readPath(scope, 'user.list[9].name')).toBeUndefined();
    expect(readPath(scope, 'missing.deep')).toBeUndefined();

    expect(writePath(scope, 'user.list[0].name', '李四')).toBe(true);
    expect(readPath(scope, 'user.list[0].name')).toBe('李四');
    expect(writePath(scope, 'missing.deep', 1)).toBe(false);
  });

  it('resolveExpression 区分整串模板 / 混合模板 / 路径 / 字面量', () => {
    const scope = { user: { name: '小吴', age: 3 }, ok: true };
    expect(resolveExpression('${user.age}', scope)).toBe(3);
    expect(resolveExpression('你好 ${user.name}', scope)).toBe('你好 小吴');
    expect(resolveExpression('user.name', scope)).toBe('小吴');
    expect(resolveExpression('42', scope)).toBe(42);
    expect(resolveExpression('true', scope)).toBe(true);
    expect(resolveExpression("'raw'", scope)).toBe('raw');
    // 路径不存在时保留原文，便于用户看到未填字段
    expect(resolveExpression('user.missing', scope)).toBe('user.missing');
  });

  it('resolveTemplate 支持 ${} 与 {{}} 两种插值', () => {
    const scope = { a: 1, b: 'x' };
    expect(resolveTemplate('${a}-{{b}}', scope)).toBe('1-x');
    expect(resolveTemplate('对象 ${obj}', { obj: { k: 1 } })).toBe('对象 {"k":1}');
  });

  it('toExpression 生成字面量或路径文本', () => {
    expect(toExpression({ kind: 'path', value: 'user.name' })).toBe('user.name');
    expect(toExpression({ kind: 'literal', value: '文本' })).toBe("'文本'");
    expect(toExpression({ kind: 'literal', value: 7 })).toBe('7');
    expect(toExpression({ kind: 'literal', value: null })).toBe('null');
  });

  it('collectExpressionPaths 收集模板引用', () => {
    expect(collectExpressionPaths('${user.name} / ${user.age}')).toEqual(['user.name', 'user.age']);
    expect(collectExpressionPaths('user.name')).toEqual(['user.name']);
    expect(collectExpressionPaths('纯文本')).toEqual([]);
  });
});

describe('共享契约：结构化条件', () => {
  const scope = { loading: false, count: 3, user: { role: 'admin', name: '小吴' }, list: [] };

  it('比较 / 逻辑 / 集合 / 空值运算求值正确', () => {
    expect(evaluateCondition({ op: 'eq', left: 'count', right: 3 }, scope)).toBe(true);
    expect(evaluateCondition({ op: 'gt', left: 'count', right: 5 }, scope)).toBe(false);
    expect(evaluateCondition({ op: 'truthy', left: 'loading' }, scope)).toBe(false);
    expect(evaluateCondition({ op: 'empty', left: 'list' }, scope)).toBe(true);
    expect(
      evaluateCondition({ op: 'in', left: 'user.role', right: ['admin', 'owner'] }, scope),
    ).toBe(true);
    expect(evaluateCondition({ op: 'contains', left: 'user.name', right: '小' }, scope)).toBe(true);
    expect(evaluateCondition({ op: 'startsWith', left: 'user.name', right: '小' }, scope)).toBe(
      true,
    );
    expect(evaluateCondition({ op: 'endsWith', left: 'user.name', right: '吴' }, scope)).toBe(true);
    expect(evaluateCondition({ op: 'eq', left: 'user.role', right: 'admin' }, scope)).toBe(true);
  });

  it('and / or / not 组合', () => {
    const expr = {
      op: 'and' as const,
      items: [
        { op: 'eq' as const, left: 'user.role', right: 'admin' as const },
        { op: 'not' as const, item: { op: 'truthy' as const, left: 'loading' } },
      ],
    };
    expect(evaluateCondition(expr, scope)).toBe(true);
    expect(
      evaluateCondition(
        {
          op: 'or',
          items: [
            { op: 'truthy', left: 'loading' },
            { op: 'eq', left: 'count', right: 3 },
          ],
        },
        scope,
      ),
    ).toBe(true);
  });

  it('空条件视为通过（无限制）', () => {
    expect(evaluateCondition(null, scope)).toBe(true);
    expect(evaluateCondition(undefined, scope)).toBe(true);
  });

  it('parseCondition 校验并保留结构，非法结构返回 null', () => {
    const parsed = parseCondition({ op: 'eq', left: 'a', right: 1 });
    expect(parsed).toEqual({ op: 'eq', left: 'a', right: 1 });
    expect(parseCondition({ op: 'eval', left: 'a' })).toBeNull();
    expect(parseCondition({ op: 'and' })).toBeNull();
    expect(parseCondition({ op: 'eq' })).toBeNull();
    expect(isConditionExpr({ op: 'truthy', left: 'a' })).toBe(true);
    expect(isConditionExpr('a==1')).toBe(false);
  });

  it('createCondition 生成各形态空节点', () => {
    expect(createCondition('and')).toEqual({ op: 'and', items: [] });
    expect(createCondition('truthy')).toEqual({ op: 'truthy', left: '' });
    expect(createCondition('in')).toEqual({ op: 'in', left: '', right: [] });
    expect(createCondition('not')).toMatchObject({ op: 'not' });
    expect(createCondition('eq')).toEqual({ op: 'eq', left: '', right: '' });
  });

  it('describeCondition 输出中文描述', () => {
    expect(describeCondition({ op: 'eq', left: 'count', right: 1 })).toBe('count 等于 1');
    expect(describeCondition({ op: 'truthy', left: 'loading' })).toBe('loading 为真');
    expect(describeCondition(null)).toBe('始终渲染');
  });

  it('collectConditionPaths / validateCondition', () => {
    expect(
      collectConditionPaths({
        op: 'and',
        items: [
          { op: 'eq', left: 'a', right: 1 },
          { op: 'truthy', left: 'b' },
        ],
      }),
    ).toEqual(['a', 'b']);
    expect(validateCondition({ op: 'and', items: [] })).toEqual(['条件：逻辑组至少需要一个子条件']);
    expect(validateCondition({ op: 'eq', left: '  ', right: 1 })).toEqual(['条件：左侧字段未填写']);
    expect(validateCondition({ op: 'eq', left: 'a', right: 1 })).toEqual([]);
  });

  it('权限规则：角色 + 条件共同决定', () => {
    const rule = {
      mode: 'visible' as const,
      roles: ['admin'],
      condition: { op: 'truthy' as const, left: 'loading' },
    };
    expect(evaluatePermission(rule, { roles: ['admin'], scope: { loading: 1 } })).toBe(true);
    expect(evaluatePermission(rule, { roles: ['guest'], scope: { loading: 1 } })).toBe(false);
    expect(evaluatePermission(rule, { roles: ['admin'], scope: { loading: 0 } })).toBe(false);
    expect(evaluatePermission({ mode: 'editable', roles: [] })).toBe(true);
    expect(evaluatePermission(null)).toBe(true);
  });
});

describe('共享契约：数据源目录', () => {
  it('收集页面状态与接口依赖', () => {
    const dsl = createLoginPageDsl();
    const catalog = getDataSources(dsl);
    expect(catalog.pageId).toBe('login');
    expect(catalog.states.map((state) => state.name)).toEqual([
      'phone',
      'password',
      'remember',
      'loading',
      'errorMsg',
    ]);
    expect(catalog.apis.map((api) => api.path)).toEqual(['/api/auth/login']);
    // 无显式方法时按路径推断
    expect(catalog.apis[0]?.method).toBe('POST');
  });

  it('接口清单可补全响应字段并平铺为路径', () => {
    const dsl = createLoginPageDsl();
    const catalog = getDataSources(dsl, [
      {
        id: '/api/auth/login',
        method: 'POST',
        path: '/api/auth/login',
        source: 'catalog',
        responseFields: [
          {
            name: 'data',
            type: 'object',
            children: [
              { name: 'token', type: 'string' },
              { name: 'user', type: 'object', children: [{ name: 'id', type: 'number' }] },
            ],
          },
        ],
      },
    ]);
    const paths = listDataSourcePaths(catalog).map((ref) => ref.path);
    expect(paths).toContain('response.data.token');
    expect(paths).toContain('response.data.user.id');
    expect(paths).toContain('phone');
    // 根层级 depth 为 0，子字段递增
    const token = listDataSourcePaths(catalog).find((ref) => ref.path === 'response.data.token');
    expect(token?.depth).toBe(1);
  });

  it('createDataSourceProvider 以 pageId 解析', () => {
    const dsl = createLoginPageDsl();
    const provider = createDataSourceProvider({
      getDsl: (pageId) => (pageId === 'login' ? dsl : null),
    });
    expect(provider('login')?.pageId).toBe('login');
    expect(provider('nope')).toBeNull();
  });

  it('引用检查能定位绑定该状态的元素', () => {
    const dsl = createLoginPageDsl();
    // el-15 的 disabled 绑定到 loading
    expect(findReferencingElements(dsl, 'loading').map((node) => node.id)).toContain('el-15');
    expect(findReferencingElements(dsl, '不存在')).toEqual([]);
    expect(findReferencingElements(dsl, '')).toEqual([]);
  });
});

describe('共享契约：属性 Schema 与组件注册表', () => {
  const schema = defineSchema([
    { key: 'text', label: '文本', type: 'text', group: '内容', default: '按钮' },
    {
      key: 'variant',
      label: '风格',
      type: 'enum',
      group: '外观',
      options: [{ value: 'primary', label: '主按钮' }],
      default: 'primary',
    },
    {
      key: 'block',
      label: '撑满宽度',
      type: 'boolean',
      group: '外观',
      visibleWhen: { field: 'variant', equals: 'primary' },
    },
  ]);

  it('默认值 / 分组 / 条件显隐', () => {
    expect(schemaDefaults(schema)).toEqual({ text: '按钮', variant: 'primary' });
    expect(groupFields(schema).map((item) => item.group)).toEqual(['内容', '外观']);
    expect(fieldVisible(schema.fields[2] as never, { variant: 'primary' })).toBe(true);
    expect(fieldVisible(schema.fields[2] as never, { variant: 'ghost' })).toBe(false);
  });

  it('schema 自检捕获重复 key、缺 label、枚举缺 options、悬空 visibleWhen', () => {
    expect(validatePropSchema(schema)).toEqual([]);
    const issues = validatePropSchema({
      fields: [
        { key: 'a', label: 'A', type: 'text', group: '内容' },
        { key: 'a', label: '', type: 'enum', group: '内容' },
        { key: 'b', label: 'B', type: 'text', group: '内容', visibleWhen: { field: 'missing' } },
      ],
    });
    expect(issues.join('|')).toContain('key 重复：a');
    expect(issues.join('|')).toContain('缺少中文标签');
    expect(issues.join('|')).toContain('缺少 options');
    expect(issues.join('|')).toContain('visibleWhen 引用了不存在的字段');
  });

  it('注册表：注册 / 查询 / 分组 / 白名单 / 重复注册防护', () => {
    const registry = new ComponentRegistry();
    registry.register({
      meta: {
        type: 'Button',
        displayName: '按钮',
        group: '基础',
        icon: 'button',
        defaultProps: {},
        defaultStyle: {},
        acceptsChildren: false,
        propSchema: schema,
      },
    });
    registry.register({
      meta: {
        type: 'Container',
        displayName: '容器',
        group: '布局',
        icon: 'container',
        defaultProps: {},
        defaultStyle: {},
        acceptsChildren: true,
        propSchema: { fields: [] },
      },
    });

    expect(registry.has('Button')).toBe(true);
    expect(registry.get('Button')?.displayName).toBe('按钮');
    expect(registry.get('Nope')).toBeNull();
    expect(registry.acceptsChildren('Button')).toBe(false);
    expect(registry.acceptsChildren('Container')).toBe(true);
    expect(registry.types()).toEqual(['Button', 'Container']);
    expect(registry.groups().map((item) => item.group)).toEqual(['基础', '布局']);
    const duplicate = {
      meta: {
        type: 'Button',
        displayName: '按钮2',
        group: '基础' as const,
        icon: 'button',
        defaultProps: {},
        defaultStyle: {},
        acceptsChildren: false,
        propSchema: { fields: [] },
      },
    };
    expect(() => registry.register(duplicate)).toThrow(/已注册/);

    expect(registry.unregister('Button')).toBe(true);
    expect(registry.has('Button')).toBe(false);
  });

  it('自定义组件注册到自定义分组并可覆盖', () => {
    const registry = new ComponentRegistry();
    const meta = registerCustomComponent(
      {
        meta: {
          type: 'MyCard',
          displayName: '我的卡片',
          group: '自定义',
          icon: 'card',
          defaultProps: { title: 'x' },
          defaultStyle: {},
          acceptsChildren: true,
          propSchema: { fields: [] },
        },
      },
      registry,
    );
    expect(meta.type).toBe('MyCard');
    expect(registry.list('自定义').map((item) => item.type)).toEqual(['MyCard']);
  });

  it('全局注册表初始为空（内置组件由 components/index.ts 注册）', () => {
    expect(componentRegistry.types()).toEqual([]);
  });
});
