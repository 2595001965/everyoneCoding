import { describe, expect, it } from 'vitest';

import {
  ancestorOwnerships,
  isValidOwnership,
  layerOf,
  LAYER_ORDER,
  ownershipKeyOf,
  ownershipWarnings,
  validateOwnership,
} from '../domain/scope';

/** 构造归属对象（默认全空），避免每个用例重复写五个 null */
function owners(patch: Partial<Parameters<typeof validateOwnership>[1]> = {}) {
  return {
    project_id: null,
    feature_id: null,
    page_id: null,
    element_id: null,
    issue_id: null,
    ...patch,
  };
}

describe('scope 归属不变量', () => {
  it('长期记忆不得携带 project_id（跨项目生效）', () => {
    expect(validateOwnership('longterm', owners())).toEqual([]);
    const violations = validateOwnership('longterm', owners({ project_id: 'P1' }));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.field).toBe('project_id');
    expect(violations[0]?.message).toContain('project_id 必须为空');
  });

  it('项目记忆必须带 project_id，且不得带下层归属', () => {
    expect(isValidOwnership('project', owners({ project_id: 'P1' }))).toBe(true);
    expect(validateOwnership('project', owners())[0]?.code).toBe('MISSING_OWNER');
    const pageOwner = validateOwnership('project', owners({ project_id: 'P1', page_id: 'PG1' }));
    expect(pageOwner.map((item) => item.code)).toEqual(['UNEXPECTED_OWNER']);
  });

  it('功能记忆必须同时带 project_id 与 feature_id', () => {
    expect(isValidOwnership('feature', owners({ project_id: 'P1', feature_id: 'F1' }))).toBe(true);
    expect(
      validateOwnership('feature', owners({ project_id: 'P1' })).map((item) => item.field),
    ).toEqual(['feature_id']);
  });

  it('页面记忆必须带 project_id + page_id，允许带 element_id（元素备注层）', () => {
    expect(isValidOwnership('page', owners({ project_id: 'P1', page_id: 'PG1' }))).toBe(true);
    expect(
      isValidOwnership('page', owners({ project_id: 'P1', page_id: 'PG1', element_id: 'E1' })),
    ).toBe(true);
    expect(
      validateOwnership('page', owners({ project_id: 'P1' })).map((item) => item.field),
    ).toEqual(['page_id']);
    expect(
      validateOwnership('page', owners({ project_id: 'P1', page_id: 'PG1', issue_id: 'I1' })),
    ).toHaveLength(1);
  });

  it('问题记忆必须带 issue_id，且带 feature/page/element 中至少一项（仅为警告）', () => {
    expect(isValidOwnership('issue', owners({ project_id: 'P1', issue_id: 'I1' }))).toBe(true);
    expect(
      validateOwnership('issue', owners({ project_id: 'P1' })).map((item) => item.field),
    ).toEqual(['issue_id']);
    expect(ownershipWarnings('issue', owners({ project_id: 'P1', issue_id: 'I1' }))).toHaveLength(
      1,
    );
    expect(
      ownershipWarnings('issue', owners({ project_id: 'P1', issue_id: 'I1', page_id: 'PG1' })),
    ).toHaveLength(0);
  });
});

describe('layer 推导与顺序', () => {
  it('page + element_id 推导为 element 层', () => {
    expect(layerOf({ scope: 'page', element_id: null })).toBe('page');
    expect(layerOf({ scope: 'page', element_id: 'E1' })).toBe('element');
    expect(layerOf({ scope: 'longterm' })).toBe('longterm');
  });

  it('继承顺序：长期 < 项目 < 功能 < 页面 < 元素 < 问题', () => {
    expect(LAYER_ORDER.longterm).toBeLessThan(LAYER_ORDER.project);
    expect(LAYER_ORDER.project).toBeLessThan(LAYER_ORDER.feature);
    expect(LAYER_ORDER.feature).toBeLessThan(LAYER_ORDER.page);
    expect(LAYER_ORDER.page).toBeLessThan(LAYER_ORDER.element);
    expect(LAYER_ORDER.element).toBeLessThan(LAYER_ORDER.issue);
  });
});

describe('归属工具', () => {
  it('ownershipKeyOf 把空值统一为 "-"，可直接用于槽位比较', () => {
    expect(ownershipKeyOf(owners())).toBe('-|-|-|-|-');
    expect(ownershipKeyOf(owners({ project_id: 'P1', page_id: 'PG1' }))).toBe('P1|-|PG1|-|-');
  });

  it('ancestorOwnerships 按层级链返回，元素层包含页面层与功能层', () => {
    const chain = ancestorOwnerships({
      project_id: 'P1',
      feature_id: 'F1',
      page_id: 'PG1',
      element_id: 'E1',
      issue_id: null,
    });
    expect(chain).toHaveLength(5);
    expect(chain[0]?.project_id).toBeNull();
    expect(chain[4]).toMatchObject({
      project_id: 'P1',
      feature_id: 'F1',
      page_id: 'PG1',
      element_id: 'E1',
    });
  });
});
