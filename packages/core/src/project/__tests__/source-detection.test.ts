import { describe, expect, it } from 'vitest';

import {
  anchorDraftToRoot,
  detectSource,
  SOURCE_SCANNER_VERSION,
  type SourceSnapshot,
} from '../source-detection';

/** 快照构造辅助 */
const snap = (files: string[], manifests: Record<string, string> = {}): SourceSnapshot => ({
  files,
  manifests,
});

const pkg = (
  name: string,
  deps: Record<string, string> = {},
  scripts: Record<string, string> = {},
) => JSON.stringify({ name, dependencies: deps, devDependencies: {}, scripts });

describe('统一静态识别（V2-D01：四路接入共用管线）', () => {
  it('React+Vite：supported + 安装/运行计划 + 锁文件判定包管理器', () => {
    const draft = detectSource(
      snap(['package.json', 'pnpm-lock.yaml', 'src/main.tsx', 'index.html'], {
        'package.json': pkg('web', { react: '^19', vite: '^7' }, { dev: 'vite' }),
      }),
    );
    expect(draft.scannerVersion).toBe(SOURCE_SCANNER_VERSION);
    const [sub] = draft.subProjects;
    expect(sub?.framework).toBe('react-vite');
    expect(sub?.supportLevel).toBe('supported');
    expect(sub?.packageManager).toBe('pnpm');
    expect(sub?.role).toBe('frontend');
    const plan = sub?.suggestedRunPlan;
    expect(plan?.services.map((service) => service.role)).toEqual(['install', 'frontend']);
    expect(plan?.services[1]?.args).toEqual(['run', 'dev']);
    expect(plan?.envVarNames).toEqual([]);
    expect(plan?.startupOrder).toEqual([
      plan?.services[0]?.serviceId,
      plan?.services[1]?.serviceId,
    ]);
    // 首次安装/运行前需要信任确认（V2-SRC-05）
    expect(draft.requiresConfirmation).toBe(true);
  });

  it('Vue+Vite：supported', () => {
    const draft = detectSource(
      snap(['package.json'], {
        'package.json': pkg('web', { vue: '^3', vite: '^7' }, { dev: 'vite' }),
      }),
    );
    expect(draft.subProjects[0]?.framework).toBe('vue-vite');
    expect(draft.subProjects[0]?.supportLevel).toBe('supported');
  });

  it('Express 后端：走既有 dev 脚本给运行计划，环境变量只携带名称', () => {
    const draft = detectSource(
      snap(['package.json', 'package-lock.json'], {
        'package.json': pkg('api', { express: '^5' }, { dev: 'node server.js' }),
      }),
    );
    const [sub] = draft.subProjects;
    expect(sub?.framework).toBe('express');
    expect(sub?.role).toBe('backend');
    expect(sub?.packageManager).toBe('npm');
    expect(sub?.suggestedRunPlan?.services[1]?.command).toBe('npm');
    expect(sub?.suggestedRunPlan?.envVarNames).toEqual(['PORT', 'NODE_ENV']);
  });

  it('Express 无 dev/start 脚本：不编造运行命令（计划为空）', () => {
    const draft = detectSource(
      snap(['package.json'], { 'package.json': pkg('api', { express: '^5' }) }),
    );
    expect(draft.subProjects[0]?.suggestedRunPlan).toBeNull();
    expect(draft.requiresConfirmation).toBe(false);
  });

  it('纯静态站：supported、无运行计划、备注说明由预览托管（不是缺失）', () => {
    const draft = detectSource(snap(['index.html', 'styles.css', 'app.js']));
    const [sub] = draft.subProjects;
    expect(sub?.framework).toBe('static-html');
    expect(sub?.supportLevel).toBe('supported');
    expect(sub?.packageManager).toBeNull();
    expect(sub?.suggestedRunPlan).toBeNull();
    expect(draft.requiresConfirmation).toBe(false);
    expect(draft.notes.join('')).toContain('静态站无需安装依赖');
  });

  it('FastAPI：requirements.txt + fastapi 依赖 → supported + uvicorn 建议命令', () => {
    const draft = detectSource(
      snap(['requirements.txt', 'main.py'], {
        'requirements.txt': 'fastapi==0.115\nuvicorn==0.30\n',
      }),
    );
    const [sub] = draft.subProjects;
    expect(sub?.framework).toBe('fastapi');
    expect(sub?.language).toBe('python');
    expect(sub?.suggestedRunPlan?.services[0]?.args).toContain('-m');
    expect(sub?.suggestedRunPlan?.services[0]?.args).toContain('main:app');
  });

  it('Flask：partial（P1 范围，不宣称 P0 支持）', () => {
    const draft = detectSource(snap(['requirements.txt'], { 'requirements.txt': 'flask==3.0\n' }));
    expect(draft.subProjects[0]?.framework).toBe('flask');
    expect(draft.subProjects[0]?.supportLevel).toBe('partial');
    expect(draft.subProjects[0]?.suggestedRunPlan).toBeNull();
  });

  it('Next.js：partial（P1 专用适配，不装作 supported 也不装作未知）', () => {
    const draft = detectSource(
      snap(['package.json'], {
        'package.json': pkg('site', { next: '^15', react: '^19' }, { dev: 'next dev' }),
      }),
    );
    expect(draft.subProjects[0]?.supportLevel).toBe('partial');
    expect(draft.notes.join('')).toContain('Next.js 属 P1');
  });

  it('完全未知栈：unknown、无计划、备注明确不自动给命令（不误报支持）', () => {
    const draft = detectSource(snap(['data/blob.bin']));
    const [sub] = draft.subProjects;
    expect(sub?.supportLevel).toBe('unknown');
    expect(sub?.confidence).toBe(0);
    expect(sub?.suggestedRunPlan).toBeNull();
    expect(draft.notes.join('')).toContain('不会自动给出运行命令');
  });

  it('单仓多应用（无根 package.json）：两个子工程都列出，备注要求用户选择', () => {
    const draft = detectSource(
      snap(['apps/web/package.json', 'apps/api/package.json', 'pnpm-lock.yaml'], {
        'apps/web/package.json': pkg('web', { react: '^19', vite: '^7' }, { dev: 'vite' }),
        'apps/api/package.json': pkg('api', { express: '^5' }, { dev: 'node server.js' }),
      }),
    );
    expect(draft.subProjects).toHaveLength(2);
    // 按目录字典序稳定输出；两个都可运行，UI 必须让用户选择
    expect(draft.subProjects.map((sub) => sub.entryHints[0])).toEqual(['apps/api', 'apps/web']);
    expect(draft.notes.join('')).toContain('运行前需在运行计划中选择其一');
  });

  it('根工程存在时，examples 下的嵌套清单不当独立应用（不误报多应用）', () => {
    const draft = detectSource(
      snap(['package.json', 'examples/demo/package.json'], {
        'package.json': pkg('main', { react: '^19', vite: '^7' }, { dev: 'vite' }),
        'examples/demo/package.json': pkg('demo', { react: '^19' }),
      }),
    );
    expect(draft.subProjects).toHaveLength(1);
    expect(draft.subProjects[0]?.entryHints[0]).toBe('.');
  });

  it('node_modules 下的 package.json 不参与识别', () => {
    const draft = detectSource(
      snap(['package.json', 'node_modules/vite/package.json'], {
        'package.json': pkg('main', { react: '^19', vite: '^7' }, { dev: 'vite' }),
      }),
    );
    expect(draft.subProjects).toHaveLength(1);
  });

  it('pnpm workspace：根工程与成员证据齐备，可运行成员是候选子工程', () => {
    const draft = detectSource(
      snap(
        [
          'pnpm-workspace.yaml',
          'package.json',
          'apps/web/package.json',
          'packages/lib/package.json',
        ],
        {
          'package.json': pkg('root', {}, {}),
          'apps/web/package.json': pkg('web', { react: '^19', vite: '^7' }, { dev: 'vite' }),
          'packages/lib/package.json': pkg('lib'),
        },
      ),
    );
    // 根（无脚本无框架 → 保留为候选但角色 library）+ 可运行成员
    const hints = draft.subProjects.map((sub) => sub.entryHints[0]);
    expect(hints).toContain('apps/web');
    // 成员 web 是 react-vite + supported
    const web = draft.subProjects.find((sub) => sub.entryHints[0] === 'apps/web');
    expect(web?.framework).toBe('react-vite');
    expect(web?.supportLevel).toBe('supported');
  });

  it('anchorDraftToRoot 把 cwd/entryHints 锚定到代码根（含尾部斜杠归一）', () => {
    const draft = detectSource(
      snap(['apps/web/package.json', 'pnpm-lock.yaml'], {
        'apps/web/package.json': pkg('web', { react: '^19', vite: '^7' }, { dev: 'vite' }),
      }),
    );
    const anchored = anchorDraftToRoot(draft, 'D:/projects/我的 应用/');
    const sub = anchored.subProjects[0]!;
    expect(sub.entryHints[0]).toBe('D:/projects/我的 应用/apps/web');
    expect(sub.suggestedRunPlan?.cwd).toBe('D:/projects/我的 应用/apps/web');
  });

  it('清单 JSON 损坏时回退到原文匹配，不抛错', () => {
    const draft = detectSource(
      snap(['package.json'], { 'package.json': '{broken json with "vite" and "react"' }),
    );
    expect(draft.subProjects[0]?.framework).toBe('react-vite');
  });
});
