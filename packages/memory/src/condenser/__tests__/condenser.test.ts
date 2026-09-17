import { describe, test, expect } from 'vitest';
import { createLoginPageDslFixture, type PageDsl, type PageDslElement } from '../page-dsl';
import { condensePage } from '../condenser';
import { mergeRules } from '../rules';
import { enforceTokenBudget } from '../token-estimator';

function countElements(node: PageDslElement): number {
  return 1 + (node.children ?? []).reduce((sum, child) => sum + countElements(child), 0);
}

/** 构造一个带样式与业务 props 的小 DSL，用于验证样式剥离 */
function makeStyledDsl(): PageDsl {
  return {
    id: 'pg',
    projectId: 'P1',
    name: 't',
    platform: 'web',
    route: '/t',
    tree: {
      id: 'root',
      type: 'Container',
      style: { color: 'red', padding: 10 },
      props: { text: 'hello' },
      children: [
        {
          id: 'btn',
          type: 'Button',
          style: { fontSize: 14, background: '#fff' },
          props: { placeholder: 'x', name: 'submit' },
          bindings: { value: 'name' },
        },
      ],
    },
  };
}

/** 构造深度为 depth 的纯嵌套 Container 链 */
function deepDsl(depth: number): PageDsl {
  let node: PageDslElement = { id: `d${String(depth)}`, type: 'Container' };
  for (let i = depth - 1; i >= 0; i -= 1) {
    node = { id: `d${String(i)}`, type: 'Container', children: [node] };
  }
  return { id: 'pg', projectId: 'P1', name: 'deep', platform: 'web', route: '/deep', tree: node };
}

describe('condensePage', () => {
  test('登录页 fixture 恰好 20 个元素', () => {
    const dsl = createLoginPageDslFixture();
    expect(countElements(dsl.tree)).toBe(20);
  });

  test('20 元素登录页摘要 token ≤ 2000（实测）', () => {
    const dsl = createLoginPageDslFixture();
    const summary = condensePage(dsl);
    const { tokens, truncated } = enforceTokenBudget(summary);
    console.info(`[bench] login page summary tokens=${tokens.tokens} truncated=${truncated}`);
    expect(tokens.tokens).toBeLessThanOrEqual(2000);
  });

  test('纯样式被剥离，组件类型与层级被保留', () => {
    const dsl = makeStyledDsl();
    const summary = condensePage(dsl);
    // skeleton 不含任何 style 键
    expect(summary.skeleton).not.toContain('color');
    expect(summary.skeleton).not.toContain('padding');
    expect(summary.skeleton).not.toContain('fontSize');
    expect(summary.skeleton).not.toContain('background');
    // 类型保留
    expect(summary.elementIndex['btn']?.type).toBe('Button');
    expect(summary.elementIndex['root']?.type).toBe('Container');
    // 层级（parentId）保留
    expect(summary.elementIndex['btn']?.parentId).toBe('root');
    expect(summary.elementIndex['root']?.parentId).toBeNull();
    // elementIndex 本身不含 style
    expect(summary.elementIndex['btn']).not.toHaveProperty('style');
  });

  test('bindings 保留为 elementIndex.boundProps，并推导 dataFlow', () => {
    const dsl = createLoginPageDslFixture();
    const summary = condensePage(dsl);
    expect(summary.elementIndex['el-phone']?.boundProps).toContain('value');
    expect(
      summary.dataFlow.some((d) => d.from === 'el-phone' && d.to === 'phone' && d.field === 'value'),
    ).toBe(true);
  });

  test('apiDeps 汇总 dsl.apiDeps 与 request 动作目标（去重）', () => {
    const dsl = createLoginPageDslFixture();
    const summary = condensePage(dsl);
    expect(summary.apiDeps).toContain('/api/auth/login');
    expect(summary.apiDeps.filter((d) => d === '/api/auth/login')).toHaveLength(1);
  });

  test('深度截断：超过 maxDepth 的嵌套折叠为占位节点', () => {
    const dsl = deepDsl(10);
    const summary = condensePage(dsl, mergeRules({ maxDepth: 3 }));
    expect(summary.truncated).toBe(true);
    expect(summary.skeleton).toContain('深度截断');
  });
});
