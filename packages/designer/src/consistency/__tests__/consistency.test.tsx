import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createElement, createLoginPageDsl, createPageDsl } from '../../dsl/factory';
import type { PageDsl, Platform } from '../../dsl/types';
import { ConsistencyPanel } from '../ConsistencyPanel';
import { checkConsistency, groupByFeature, skeletonSignature, workbenchHint } from '../consistency-check';

/** 同一功能在同路由下的两个端版本（结构一致） */
function pair(options: { sameStructure?: boolean; sameName?: boolean } = {}): PageDsl[] {
  const base = createLoginPageDsl();
  const web: PageDsl = { ...base, id: 'login-web', platform: 'web', route: '/login' };
  const androidTree = JSON.parse(JSON.stringify(base.tree)) as PageDsl['tree'];
  if (options.sameStructure === false) {
    androidTree.children = [...(androidTree.children ?? []), createElement({ id: 'extra', type: 'Text', name: '额外区块' })];
  }
  if (options.sameName === false) {
    androidTree.children![0]!.children![0]!.name = '站点图标';
  }
  const android: PageDsl = { ...base, id: 'login-android', platform: 'android', route: '/login', tree: androidTree };
  return [web, android];
}

describe('T3-11 多端一致性：缺失端与缺失页面', () => {
  it('目标端完全缺失时给出提示', () => {
    const pages = [createLoginPageDsl()]; // 只有 web
    const report = checkConsistency({ pages, targetPlatforms: ['web', 'ios', 'harmonyos'] });
    expect(report.summary.missingPlatforms).toEqual(['ios', 'harmonyos']);
    const platformIssues = report.issues.filter((issue) => issue.code === 'MISSING_PLATFORM');
    // 功能级（F1 在 ios / harmonyos 缺失）+ 项目级提示不重复
    expect(platformIssues).toHaveLength(2);
    expect(platformIssues.every((issue) => issue.featureId === 'F1')).toBe(true);
    expect(platformIssues[0]?.message).toContain('没有对应页面');
  });

  it('功能在某端缺失时按功能维度提示', () => {
    const web = createLoginPageDsl();
    const android = createPageDsl({
      id: 'm-home',
      projectId: 'P1',
      name: '移动首页',
      platform: 'android',
      route: '/home',
      featureId: 'F1',
    });
    const report = checkConsistency({ pages: [web, android], targetPlatforms: ['web', 'android', 'ios'] });
    const featureIssues = report.issues.filter((issue) => issue.code === 'MISSING_PLATFORM' && issue.featureId !== null);
    expect(featureIssues.map((issue) => issue.platform)).toContain('ios');
    expect(featureIssues.every((issue) => issue.featureId !== null)).toBe(true);
  });

  it('某端有页面但缺少某个路由时提示缺失页面', () => {
    const web = createLoginPageDsl();
    const webDetail = createPageDsl({ id: 'detail-web', projectId: 'P1', name: '详情页', platform: 'web', route: '/detail' });
    const androidHome = createPageDsl({ id: 'home-android', projectId: 'P1', name: '移动首页', platform: 'android', route: '/home' });
    const report = checkConsistency({ pages: [web, webDetail, androidHome], targetPlatforms: ['web', 'android'] });
    const missing = report.issues.filter((issue) => issue.code === 'MISSING_PAGE');
    // android 缺 /login、/detail；web 缺 /home —— 双向都要报
    expect(missing.map((issue) => `${issue.platform}${issue.path}`).sort()).toEqual([
      'android/detail',
      'android/login',
      'web/home',
    ]);
    expect(missing[0]?.message).toContain('缺少路由');
  });
});

describe('T3-11 多端一致性：结构差异与命名差异', () => {
  it('结构一致时不报结构差异', () => {
    const report = checkConsistency({ pages: pair(), targetPlatforms: ['web', 'android'] });
    expect(report.issues.filter((issue) => issue.code === 'STRUCTURE_DIFF')).toHaveLength(0);
    expect(report.issues.filter((issue) => issue.code === 'NAMING_DIFF')).toHaveLength(0);
    expect(report.issues.filter((issue) => issue.code === 'MISSING_PAGE')).toHaveLength(0);
  });

  it('骨架层结构不同时给出结构差异', () => {
    const report = checkConsistency({ pages: pair({ sameStructure: false }), targetPlatforms: ['web', 'android'] });
    const structure = report.issues.filter((issue) => issue.code === 'STRUCTURE_DIFF');
    expect(structure).toHaveLength(1);
    expect(structure[0]?.message).toContain('骨架结构');
    expect(structure[0]?.platform).toBe('android');
  });

  it('同 id 元素显示名不同时给出命名差异（severity=info）', () => {
    const report = checkConsistency({ pages: pair({ sameName: false }), targetPlatforms: ['web', 'android'] });
    const naming = report.issues.filter((issue) => issue.code === 'NAMING_DIFF');
    expect(naming).toHaveLength(1);
    expect(naming[0]?.severity).toBe('info');
    expect(naming[0]?.message).toContain('站点标识');
    expect(naming[0]?.message).toContain('站点图标');
  });

  it('skeletonSignature 只取前两层类型', () => {
    const dsl = createLoginPageDsl();
    expect(skeletonSignature(dsl.tree)).toBe('Container>Navbar>Container>Container');
  });

  it('完成度统计与工作台提示', () => {
    const report = checkConsistency({
      pages: [createLoginPageDsl()],
      targetPlatforms: ['web', 'android', 'ios', 'harmonyos', 'windows', 'linux', 'macos'] as Platform[],
    });
    expect(report.summary.coveredPlatforms).toEqual(['web']);
    expect(report.summary.missingPlatforms).toHaveLength(6);
    expect(report.summary.counts.MISSING_PLATFORM).toBeGreaterThan(0);
    const hint = workbenchHint(report);
    expect(hint).toContain('缺失端');
    expect(hint).toContain('android');
  });

  it('全部一致时工作台提示为 null', () => {
    const report = checkConsistency({ pages: pair(), targetPlatforms: ['web', 'android'] });
    expect(workbenchHint(report)).toBeNull();
  });

  it('groupByFeature 按功能分组：有功能归属的归到功能，无归属的归到项目级', () => {
    // 有 featureId → 功能级提示
    const withFeature = groupByFeature(checkConsistency({ pages: [createLoginPageDsl()], targetPlatforms: ['web', 'ios'] }));
    expect(withFeature.map((group) => group.featureId)).toEqual(['F1']);

    // 无 featureId → 项目级（null）
    const orphan = createPageDsl({ id: 'orphan', projectId: 'P1', name: '无归属页', platform: 'web', route: '/orphan' });
    const withoutFeature = groupByFeature(checkConsistency({ pages: [orphan], targetPlatforms: ['web', 'ios'] }));
    expect(withoutFeature.map((group) => group.featureId)).toEqual([null]);
    expect(withoutFeature[0]?.issues.length).toBeGreaterThan(0);
  });
});

describe('T3-11 一致性面板', () => {
  it('展示四类计数、缺失端标签与分组清单', () => {
    const report = checkConsistency({ pages: pair({ sameStructure: false, sameName: false }), targetPlatforms: ['web', 'android', 'ios'] });
    render(<ConsistencyPanel pages={pair({ sameStructure: false, sameName: false })} targetPlatforms={['web', 'android', 'ios']} />);

    expect(screen.getByTestId('consistency-panel')).toBeInTheDocument();
    expect(screen.getByTestId('missing-platforms')).toHaveTextContent('ios');
    expect(screen.getByTestId('consistency-count-STRUCTURE_DIFF')).toHaveTextContent('结构差异 1');
    expect(screen.getByTestId('consistency-count-NAMING_DIFF')).toHaveTextContent('命名差异 1');
    expect(screen.getByTestId('consistency-hint')).toHaveTextContent('多端一致性');
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it('全部一致时展示通过提示与空态', () => {
    render(<ConsistencyPanel pages={pair()} targetPlatforms={['web', 'android']} />);
    expect(screen.getByTestId('consistency-hint')).toHaveTextContent('全部通过');
    expect(screen.getByText('一致')).toBeInTheDocument();
  });
});
