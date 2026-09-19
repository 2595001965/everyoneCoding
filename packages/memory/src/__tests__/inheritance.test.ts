import { describe, expect, it } from 'vitest';

import { createMemoryItem, type CreateMemoryInput, type MemoryItem } from '../domain/memory-item';
import { resolveInheritance, isRelevantTo, type ResolveContextRef } from '../domain/inheritance';
import { layerOf } from '../domain/scope';

/** 固定时间戳，保证裁决稳定可复现 */
const T0 = 1_700_000_000_000;

function make(
  input: Partial<CreateMemoryInput> & Pick<CreateMemoryInput, 'scope' | 'title'>,
  offset = 0,
): MemoryItem {
  return createMemoryItem({
    userId: 'U1',
    createdAt: T0 + offset,
    ...input,
  });
}

const REF: ResolveContextRef = { projectId: 'P1', featureId: 'F1', pageId: 'PG1', elementId: 'E1' };

describe('resolveContext 继承链', () => {
  it('长期 → 项目 → 功能 → 页面 → 元素 全链路正确携带并按层级排序', () => {
    const items: MemoryItem[] = [
      make({ scope: 'longterm', title: '全局命名规范', content: '小驼峰' }, 1),
      make({ scope: 'project', projectId: 'P1', title: '项目架构', content: 'React + NestJS' }, 2),
      make(
        {
          scope: 'feature',
          projectId: 'P1',
          featureId: 'F1',
          title: '用户登录',
          content: '手机号 + 密码',
        },
        3,
      ),
      make(
        {
          scope: 'page',
          projectId: 'P1',
          featureId: 'F1',
          pageId: 'PG1',
          title: '登录页 /login',
          content: '卡片式',
        },
        4,
      ),
      make(
        {
          scope: 'page',
          projectId: 'P1',
          featureId: 'F1',
          pageId: 'PG1',
          elementId: 'E1',
          title: '提交按钮',
          content: 'loading 防重复提交',
        },
        5,
      ),
    ];

    const resolved = resolveInheritance(items, REF);
    expect(resolved.layers).toEqual(['longterm', 'project', 'feature', 'page', 'element']);
    expect(resolved.effective.map((item) => layerOf(item))).toEqual([
      'longterm',
      'project',
      'feature',
      'page',
      'element',
    ]);
    expect(resolved.conflicts).toHaveLength(0);
    expect(resolved.candidates).toHaveLength(5);
  });

  it('范围外的条目（其他项目 / 其他页面 / 其他元素）被排除', () => {
    const other: MemoryItem[] = [
      make({ scope: 'project', projectId: 'P2', title: '别的项目' }, 1),
      make(
        { scope: 'page', projectId: 'P1', featureId: 'F1', pageId: 'PG9', title: '别的页面' },
        2,
      ),
      make(
        {
          scope: 'page',
          projectId: 'P1',
          featureId: 'F1',
          pageId: 'PG1',
          elementId: 'E9',
          title: '别的元素',
        },
        3,
      ),
    ];
    for (const item of other) expect(isRelevantTo(item, REF)).toBe(false);
    expect(resolveInheritance(other, REF).candidates).toHaveLength(0);
    // 长期记忆跨项目，任何上下文都携带
    expect(isRelevantTo(make({ scope: 'longterm', title: '全局' }), REF)).toBe(true);
  });
});

describe('同名/同键冲突：下层覆盖上层且可溯源', () => {
  it('长期 + 项目 + 功能 + 页面 四层同时命中同标题时，仅最下层生效并给出三条溯源', () => {
    const items: MemoryItem[] = [
      make({ scope: 'longterm', title: '命名规范', content: '长期：小驼峰' }, 1),
      make(
        { scope: 'project', projectId: 'P1', title: '命名规范', content: '项目：大驼峰组件' },
        2,
      ),
      make(
        {
          scope: 'feature',
          projectId: 'P1',
          featureId: 'F1',
          title: '命名规范',
          content: '功能：接口用 kebab',
        },
        3,
      ),
      make(
        {
          scope: 'page',
          projectId: 'P1',
          featureId: 'F1',
          pageId: 'PG1',
          title: '命名规范',
          content: '页面：按钮用 btn 前缀',
        },
        4,
      ),
    ];

    const resolved = resolveInheritance(items, REF);

    // 只有页面级生效
    expect(resolved.effective).toHaveLength(1);
    expect(resolved.effective[0]?.content).toBe('页面：按钮用 btn 前缀');
    // 另外三条全部被整体接管
    expect(resolved.overridden).toHaveLength(3);

    // 冲突溯源：每条都给出"上层条目 id + 字段名"
    expect(resolved.conflicts).toHaveLength(3);
    for (const trace of resolved.conflicts) {
      expect(trace.field).toBe('title');
      expect(trace.kind).toBe('title');
      expect(trace.winnerLayer).toBe('page');
      expect(trace.winnerId).toBe(resolved.effective[0]?.id);
      expect(trace.loserId).toBeTruthy();
      expect(trace.loserTitle).toBe('命名规范');
      expect(trace.sameLayer).toBe(false);
    }
    expect(resolved.conflicts.map((trace) => trace.loserLayer).sort()).toEqual([
      'feature',
      'longterm',
      'project',
    ]);
    expect(resolved.conflicts.map((trace) => trace.loserValue).sort()).toEqual([
      '功能：接口用 kebab',
      '长期：小驼峰',
      '项目：大驼峰组件',
    ]);

    // UI 徽标数据：胜者覆盖了 3 条上层记忆
    expect(resolved.coverage).toHaveLength(1);
    expect(resolved.coverage[0]?.overriddenIds).toHaveLength(3);
  });

  it('同 structured 叶子路径冲突按路径覆盖：上层条目其余键仍然生效', () => {
    const items: MemoryItem[] = [
      make(
        {
          scope: 'longterm',
          title: '编码风格',
          structured: { indent: 2, quotes: 'single', semi: true },
        },
        1,
      ),
      make(
        {
          scope: 'project',
          projectId: 'P1',
          title: '项目编码风格',
          structured: { indent: 4 },
        },
        2,
      ),
    ];

    const resolved = resolveInheritance(items, REF);
    // 标题不同 → 不产生整体覆盖；结构化路径 indent 冲突由项目层胜出
    expect(resolved.effective).toHaveLength(2);
    expect(resolved.overridden).toHaveLength(0);
    expect(resolved.conflicts).toHaveLength(1);
    expect(resolved.conflicts[0]?.field).toBe('indent');
    expect(resolved.conflicts[0]?.winnerLayer).toBe('project');
    expect(resolved.conflicts[0]?.loserLayer).toBe('longterm');
    expect(resolved.conflicts[0]?.winnerValue).toBe(4);
    expect(resolved.conflicts[0]?.loserValue).toBe(2);
    expect(resolved.pathOverrides).toEqual([
      {
        itemId: resolved.conflicts[0]!.loserId,
        paths: ['indent'],
        by: resolved.conflicts[0]!.winnerId,
      },
    ]);
  });

  it('取值相同的同键不产生冲突记录', () => {
    const items: MemoryItem[] = [
      make({ scope: 'longterm', title: '开发语言', content: 'TypeScript' }, 1),
      make({ scope: 'project', projectId: 'P1', title: '开发语言', content: 'TypeScript' }, 2),
    ];
    const resolved = resolveInheritance(items, REF);
    expect(resolved.conflicts).toHaveLength(0);
    // 同标题仍在同一槽位，仅保留最下层
    expect(resolved.effective).toHaveLength(1);
    expect(resolved.effective[0]?.scope).toBe('project');
  });

  it('同层冲突按 updatedAt 新者胜，并标记 sameLayer', () => {
    const items: MemoryItem[] = [
      make({ scope: 'project', projectId: 'P1', title: '构建工具', content: '旧：webpack' }, 1),
      make({ scope: 'project', projectId: 'P1', title: '构建工具', content: '新：vite' }, 10),
    ];
    const resolved = resolveInheritance(items, REF);
    expect(resolved.effective).toHaveLength(1);
    expect(resolved.effective[0]?.content).toBe('新：vite');
    expect(resolved.conflicts[0]?.sameLayer).toBe(true);
  });

  it('多次解析结果一致（裁决稳定）', () => {
    const items: MemoryItem[] = [
      make({ scope: 'longterm', title: '规范', content: 'a' }, 1),
      make({ scope: 'project', projectId: 'P1', title: '规范', content: 'b' }, 1),
    ];
    const first = resolveInheritance(items, REF);
    const second = resolveInheritance([...items].reverse(), REF);
    expect(first.effective.map((item) => item.id)).toEqual(second.effective.map((item) => item.id));
    expect(first.conflicts.map((trace) => trace.winnerId)).toEqual(
      second.conflicts.map((trace) => trace.winnerId),
    );
  });
});

describe('问题记忆进入上下文', () => {
  it('命中同页面/同元素的问题记忆进入解析结果，并位于最后（优先级最高）', () => {
    const items: MemoryItem[] = [
      make({ scope: 'longterm', title: '全局约定', content: 'x' }, 1),
      make({ scope: 'page', projectId: 'P1', pageId: 'PG1', title: '登录页', content: 'y' }, 2),
      make(
        {
          scope: 'issue',
          projectId: 'P1',
          pageId: 'PG1',
          elementId: 'E1',
          issueId: 'ISSUE-1',
          title: '提交后白屏',
          content: '现象：白屏',
          issueStatus: 'unsolved',
        },
        3,
      ),
    ];
    const resolved = resolveInheritance(items, REF);
    const layers = resolved.effective.map((item) => layerOf(item));
    expect(layers).toEqual(['longterm', 'page', 'issue']);
    expect(layers[layers.length - 1]).toBe('issue');
  });
});
