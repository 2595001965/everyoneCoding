import { describe, expect, it } from 'vitest';

import {
  createElement,
  createEmptyPage,
  createLoginPageDsl,
  createPageDsl,
  createRandomIdFactory,
  createSequentialIdFactory,
  defaultViewportFor,
  needsSafeArea,
} from '../factory';
import { parsePageDsl } from '../schema';
import { findById, walkElements } from '../traverse';

describe('T3-01 工厂', () => {
  it('顺序 id 工厂可复现，随机 id 工厂不重复', () => {
    const seq = createSequentialIdFactory('el');
    expect([seq(), seq(), seq()]).toEqual(['el-1', 'el-2', 'el-3']);
    const random = createRandomIdFactory('el');
    const ids = new Set(Array.from({ length: 200 }, () => random()));
    expect(ids.size).toBe(200);
  });

  it('各平台默认视口符合 PRD §FR-DSG-01', () => {
    expect(defaultViewportFor('web')).toMatchObject({ width: 1440, height: 900 });
    expect(defaultViewportFor('android')).toMatchObject({ width: 360, height: 800 });
    expect(defaultViewportFor('ios')).toMatchObject({ width: 390, height: 844 });
    expect(defaultViewportFor('harmonyos')).toMatchObject({ width: 360, height: 780 });
    expect(defaultViewportFor('macos')).toMatchObject({ width: 1440, height: 900 });
  });

  it('needsSafeArea 只对移动端与鸿蒙为真', () => {
    expect(needsSafeArea('ios')).toBe(true);
    expect(needsSafeArea('android')).toBe(true);
    expect(needsSafeArea('harmonyos')).toBe(true);
    expect(needsSafeArea('web')).toBe(false);
    expect(needsSafeArea('windows')).toBe(false);
  });

  it('createElement 只写入显式提供的可选字段', () => {
    expect(Object.keys(createElement({ id: 'a', type: 'Text' }))).toEqual(['id', 'type']);
    expect(Object.keys(createElement({ id: 'a', type: 'Text', name: '文本', locked: true }))).toEqual([
      'id', 'type', 'name', 'locked',
    ]);
  });

  it('createPageDsl 补齐数组类字段且页面通过校验', () => {
    const page = createEmptyPage({ id: 'p2', projectId: 'P1', platform: 'android', name: '空页' });
    expect(page.state).toEqual([]);
    expect(page.events).toEqual([]);
    expect(page.apiDeps).toEqual([]);
    expect(page.notes).toEqual([]);
    expect(page.anchors).toEqual({});
    expect(page.viewport).toMatchObject({ presetId: 'android-360x800' });
    expect(() => parsePageDsl(page)).not.toThrow();
  });

  it('createPageDsl 支持显式 featureId 与自定义 viewport', () => {
    const page = createPageDsl({
      id: 'p3',
      projectId: 'P1',
      name: '详情页',
      platform: 'web',
      route: '/detail',
      featureId: 'F9',
      viewport: { width: 1920, height: 1080 },
    });
    expect(page.featureId).toBe('F9');
    expect(page.viewport.width).toBe(1920);
  });
});

describe('T3-01 登录页样例（Wave 3 出口检查基线）', () => {
  it('恰好 20 个元素，且通过完整校验', () => {
    const dsl = createLoginPageDsl();
    expect(walkElements(dsl.tree)).toHaveLength(20);
    expect(() => parsePageDsl(dsl)).not.toThrow();
  });

  it('元素类型与业务语义对齐 PRD §13.1', () => {
    const dsl = createLoginPageDsl();
    const byName = (name: string) => walkElements(dsl.tree).find((walked) => walked.node.name === name)?.node;
    expect(byName('登录表单')?.type).toBe('Form');
    expect(byName('手机号输入框')?.type).toBe('Input');
    expect(byName('登录按钮')?.type).toBe('Button');
    expect(findById(dsl.tree, 'el-15')?.bindings).toEqual({ disabled: 'loading' });
  });

  it('状态、动作流与接口依赖成套', () => {
    const dsl = createLoginPageDsl();
    expect(dsl.state.map((item) => item.name)).toEqual(['phone', 'password', 'remember', 'loading', 'errorMsg']);
    expect(dsl.apiDeps).toEqual(['/api/auth/login']);
    const kinds = dsl.events[0]?.actions.map((action) => action.kind);
    expect(kinds).toEqual(['assign', 'request', 'branch', 'navigate', 'notify']);
    // 分支连线指向真实节点，结构不变量校验通过
    expect(() => parsePageDsl(dsl)).not.toThrow();
  });

  it('功能归属可被精简器分层沉淀消费', () => {
    const dsl = createLoginPageDsl();
    const featureRefs = new Set(walkElements(dsl.tree).map((walked) => walked.node.featureRef).filter(Boolean));
    expect([...featureRefs].sort()).toEqual(['F1', 'F2']);
    expect(dsl.featureId).toBe('F1');
  });
});
