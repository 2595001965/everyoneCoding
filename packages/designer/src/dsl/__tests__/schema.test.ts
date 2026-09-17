import { describe, expect, it } from 'vitest';

import { createElement, createLoginPageDsl, createPageDsl } from '../factory';
import { DslValidationError, checkDslInvariants, parsePageDsl, validatePageDsl, walkElements, MAX_NESTING_DEPTH } from '../schema';
import type { ElementNode, PageDsl } from '../types';

function chain(depth: number): ElementNode {
  let node: ElementNode = createElement({ id: `chain-${depth - 1}`, type: 'Container' });
  for (let level = depth - 2; level >= 0; level -= 1) {
    node = createElement({ id: `chain-${level}`, type: 'Container', children: [node] });
  }
  return node;
}

describe('T3-01 zod 形状校验', () => {
  it('登录页样例通过校验', () => {
    const result = validatePageDsl(createLoginPageDsl());
    expect(result.ok).toBe(true);
  });

  it('缺失必填字段时给出可读问题列表', () => {
    const result = validatePageDsl({ id: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.join('|')).toContain('projectId');
    }
  });

  it('platform 只接受七端枚举', () => {
    const page = createLoginPageDsl();
    const bad = { ...page, platform: 'symbian' };
    const result = validatePageDsl(bad);
    expect(result.ok).toBe(false);
  });

  it('route 必须以 / 开头', () => {
    const page = createLoginPageDsl();
    expect(validatePageDsl({ ...page, route: 'login' }).ok).toBe(false);
  });

  it('动作 kind 只接受 5 类规范值（别名在迁移阶段归一化）', () => {
    const page = createLoginPageDsl();
    const bad: PageDsl = {
      ...page,
      events: [{ id: 'ev', trigger: 'click', actions: [{ id: 'a', kind: 'setState' as unknown as 'assign' }] }],
    };
    expect(validatePageDsl(bad).ok).toBe(false);
  });

  it('parsePageDsl 失败时抛 DslValidationError', () => {
    expect(() => parsePageDsl({ id: 'x' })).toThrow(DslValidationError);
  });
});

describe('T3-01 结构不变量', () => {
  it('id 重复被检出', () => {
    const page = createPageDsl({
      id: 'p',
      projectId: 'P1',
      name: '重复 id 页',
      platform: 'web',
      route: '/dup',
      tree: createElement({
        id: 'root',
        type: 'Container',
        children: [createElement({ id: 'dup', type: 'Text' }), createElement({ id: 'dup', type: 'Button' })],
      }),
    });
    const issues = checkDslInvariants(page);
    expect(issues.map((issue) => issue.code)).toContain('DUPLICATE_ELEMENT_ID');
  });

  it('嵌套深度恰好 8 层放行，第 9 层被拒', () => {
    const okTree = chain(MAX_NESTING_DEPTH);
    const tooDeep = chain(MAX_NESTING_DEPTH + 1);
    expect(walkElements(okTree).length).toBe(MAX_NESTING_DEPTH);
    expect(walkElements(tooDeep).length).toBe(MAX_NESTING_DEPTH + 1);

    const page = (tree: ElementNode): PageDsl =>
      createPageDsl({ id: 'p', projectId: 'P1', name: '深嵌套', platform: 'web', route: '/deep', tree });

    expect(checkDslInvariants(page(okTree))).toHaveLength(0);
    expect(checkDslInvariants(page(tooDeep)).map((issue) => issue.code)).toContain('NESTING_TOO_DEEP');
  });

  it('悬空备注 / 锚点 / 事件目标 / 动作连线均被检出', () => {
    const page = createLoginPageDsl();
    const broken: PageDsl = {
      ...page,
      tree: { ...page.tree, noteId: 'note-missing' },
      anchors: {
        'el-missing': {
          id: 'anchor-1',
          elementId: 'el-missing',
          pageId: page.id,
          filePath: 'src/a.ts',
          symbol: 'A',
          startLine: 1,
          endLine: 2,
          kind: 'controller',
        },
      },
      events: [
        { id: 'ev-x', trigger: 'click', elementId: 'el-404', actions: [{ id: 'a1', kind: 'navigate', next: 'a9' }] },
      ],
    };
    const codes = checkDslInvariants(broken).map((issue) => issue.code);
    expect(codes).toContain('DANGLING_NOTE');
    expect(codes).toContain('DANGLING_ANCHOR');
    expect(codes).toContain('DANGLING_EVENT_TARGET');
    expect(codes).toContain('DANGLING_FLOW_LINK');
  });

  it('事件入口节点缺失被检出', () => {
    const page = createLoginPageDsl();
    const broken: PageDsl = {
      ...page,
      events: [{ id: 'ev-y', trigger: 'click', entry: 'nope', actions: [{ id: 'a1', kind: 'notify' }] }],
    };
    expect(checkDslInvariants(broken).map((issue) => issue.code)).toContain('DANGLING_FLOW_ENTRY');
  });
});
