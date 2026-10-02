import { describe, expect, it } from 'vitest';

import type { PlanningEvidence } from '../backend/run-planner';
import { RUN_PLANNER_VERSION, packageManagerOf, suggestRunPlan } from '../backend/run-planner';

const pkg = (input: Record<string, unknown>): PlanningEvidence['packages'][string] =>
  input as PlanningEvidence['packages'][string];

const viteReactPkg = pkg({
  scripts: { dev: 'vite' },
  dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
  devDependencies: { vite: '^5.0.0' },
});

const expressPkg = pkg({
  scripts: { start: 'node server.js' },
  dependencies: { express: '^4.0.0' },
});

describe('run-planner（V2-D02 运行计划识别）', () => {
  it('React Vite 工程：识别 frontend，给出 install + dev 两步计划（env 只有变量名）', () => {
    const suggestion = suggestRunPlan({
      files: { '': ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts'] },
      packages: { '': viteReactPkg },
      envNames: { '': ['VITE_API_BASE'] },
    });
    expect(suggestion.plannerVersion).toBe(RUN_PLANNER_VERSION);
    expect(suggestion.subProjects).toHaveLength(1);
    const sub = suggestion.subProjects[0]!;
    expect(sub.role).toBe('frontend');
    expect(sub.framework).toBe('react-vite');
    expect(sub.packageManager).toBe('npm');
    expect(sub.supportLevel).toBe('supported');

    const plan = suggestion.plan;
    expect(plan).not.toBeNull();
    expect(plan!.startupOrder).toEqual(['install-root', 'frontend-root']);
    const [install, dev] = plan!.services;
    expect(install!.role).toBe('install');
    expect(install!.command).toBe('npm install');
    expect(dev!.role).toBe('frontend');
    expect(dev!.command).toBe('npm run dev');
    // npm run-script 必须带 `--` 分隔符：编排器追加的 --port 才能透传到脚本
    expect(dev!.args).toEqual(['--', '--strictPort']);
    expect(plan!.envVarNames).toEqual(['VITE_API_BASE']);
  });

  it('锁文件决定包管理器：pnpm / yarn / bun / npm', () => {
    expect(packageManagerOf(['pnpm-lock.yaml'])).toBe('pnpm');
    expect(packageManagerOf(['yarn.lock'])).toBe('yarn');
    expect(packageManagerOf(['bun.lockb'])).toBe('bun');
    expect(packageManagerOf(['package-lock.json'])).toBe('npm');
    expect(packageManagerOf([])).toBeNull();
  });

  it('静态站（无 package.json，有 index.html）：无需运行计划，明确说明', () => {
    const suggestion = suggestRunPlan({
      files: { '': ['index.html', 'style.css'] },
      packages: {},
      envNames: {},
    });
    expect(suggestion.subProjects).toHaveLength(1);
    expect(suggestion.subProjects[0]!.role).toBe('frontend');
    expect(suggestion.subProjects[0]!.suggestedRunPlan).toBeNull();
    expect(suggestion.plan).toBeNull();
    expect(suggestion.notes.join('\n')).toContain('静态');
  });

  it('前后端分离（Vite 前端 + express 后端）：两份子工程识别合并成一个计划', () => {
    const suggestion = suggestRunPlan({
      files: {
        '': ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'],
        'apps/web': ['package.json', 'index.html'],
        'services/api': ['package.json', 'server.js'],
      },
      packages: {
        '': pkg({ workspaces: ['apps/*', 'services/*'] }),
        'apps/web': viteReactPkg,
        'services/api': pkg({ dependencies: { express: '^4.0.0' } }),
      },
      envNames: { 'services/api': ['DATABASE_URL'] },
    });
    expect(suggestion.subProjects.length).toBeGreaterThanOrEqual(2);
    const plan = suggestion.plan!;
    const roles = plan.services.map((s) => s.role);
    expect(roles).toContain('frontend');
    expect(roles).toContain('backend');
    // 安装步骤先于服务启动
    const firstRun = plan.startupOrder.findIndex((id) => !id.startsWith('install-'));
    const lastInstall = plan.startupOrder.reduce(
      (acc, id, idx) => (id.startsWith('install-') ? idx : acc),
      -1,
    );
    const firstRunIdx = plan.startupOrder.findIndex((id) => !id.startsWith('install-'));
    expect(firstRun).toBeGreaterThan(-1);
    expect(lastInstall).toBeLessThan(firstRunIdx);
    expect(plan.envVarNames).toContain('DATABASE_URL');
    // 多可运行子工程必须提示用户确认选择
    expect(suggestion.notes.join('\n')).toContain('多个可运行子工程');
  });

  it('Node 后端：scripts.start 存在时给 npm start；role=backend', () => {
    const suggestion = suggestRunPlan({
      files: { '': ['package.json', 'package-lock.json'] },
      packages: { '': expressPkg },
      envNames: {},
    });
    const sub = suggestion.subProjects[0]!;
    expect(sub.role).toBe('backend');
    const backend = suggestion.plan!.services.find((s) => s.role === 'backend')!;
    expect(backend.command).toBe('npm start');
  });

  it('未知栈：不误报支持，不出计划', () => {
    const suggestion = suggestRunPlan({
      files: { '': ['README.md'] },
      packages: {},
      envNames: {},
    });
    expect(suggestion.plan).toBeNull();
    expect(suggestion.subProjects).toHaveLength(0);
    expect(suggestion.notes.join('\n')).toContain('未识别到');
  });

  it('Python 工程：识别为 partial 支持但不给自动启动计划', () => {
    const suggestion = suggestRunPlan({
      files: { '': ['requirements.txt', 'app.py'] },
      packages: {},
      envNames: {},
    });
    expect(suggestion.subProjects[0]!.role).toBe('backend');
    expect(suggestion.subProjects[0]!.supportLevel).toBe('partial');
    expect(suggestion.plan).toBeNull();
  });
});
