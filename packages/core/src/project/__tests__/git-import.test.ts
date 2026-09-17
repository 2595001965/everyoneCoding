import { describe, it, expect } from 'vitest';

import {
  inferProjectProfile,
  isValidGitUrl,
  projectNameFromUrl,
  runGitImport,
  type GitImportPort,
  type RepoSnapshot,
} from '../git-import';

function snapshot(partial: Partial<RepoSnapshot>): RepoSnapshot {
  return {
    files: [],
    manifests: {},
    defaultBranch: 'main',
    remoteUrl: 'https://example.com/x.git',
    ...partial,
  };
}

describe('Git URL 校验与项目名推断', () => {
  it('接受 https / ssh / scp-like / git 协议与本地路径', () => {
    for (const url of [
      'https://github.com/a/b.git',
      'http://gitlab.local/a/b',
      'ssh://git@host:2222/a/b.git',
      'git@github.com:a/b.git',
      'git://host/a/b.git',
      'D:\\repos\\demo',
      '/home/user/demo',
      './local-demo',
      '../sibling-demo',
    ]) {
      expect(isValidGitUrl(url), `${url} 应合法`).toBe(true);
    }
  });

  it('拒绝空串与无协议自由文本', () => {
    expect(isValidGitUrl('')).toBe(false);
    expect(isValidGitUrl('   ')).toBe(false);
    expect(isValidGitUrl('github.com/a/b')).toBe(false);
    expect(isValidGitUrl('随便一句中文')).toBe(false);
  });

  it('从 URL 推断项目名（去 .git 与路径前缀）', () => {
    expect(projectNameFromUrl('https://github.com/team/admin-console.git')).toBe('admin-console');
    expect(projectNameFromUrl('git@github.com:team/mobile-app.git')).toBe('mobile-app');
    expect(projectNameFromUrl('D:\\repos\\demo\\')).toBe('demo');
    expect(projectNameFromUrl('https://example.com/')).toBe('example.com');
  });
});

describe('仓库画像推断', () => {
  it('Flutter 工程 → Android + iOS 双端，方案 flutter', () => {
    const profile = inferProjectProfile(
      snapshot({
        files: ['lib/main.dart', 'pubspec.yaml', 'pubspec.lock'],
        manifests: { 'pubspec.yaml': 'name: demo\nenvironment:\n  sdk: ">=3.0.0"' },
      }),
    );
    expect(profile.frameworks).toContain('flutter');
    expect(profile.platforms).toEqual(['android', 'ios']);
    expect(profile.techStack).toMatchObject({ android: 'flutter', ios: 'flutter' });
    expect(profile.evidence.join()).toContain('pubspec.yaml');
  });

  it('React Native → 移动双端方案 react-native（不被 Web 分支覆盖）', () => {
    const profile = inferProjectProfile(
      snapshot({
        manifests: { 'package.json': '{"dependencies":{"react-native":"0.74.0","react":"18.2.0"}}' },
        files: ['package.json', 'App.tsx'],
      }),
    );
    expect(profile.frameworks).toContain('react-native');
    expect(profile.techStack['android']).toBe('react-native');
    expect(profile.techStack['ios']).toBe('react-native');
    expect(profile.platforms).not.toContain('web');
  });

  it('鸿蒙工程 → harmonyos + arkts', () => {
    const profile = inferProjectProfile(
      snapshot({ files: ['oh-package.json5', 'hvigorfile.ts', 'entry/src/main/ets/Index.ets'] }),
    );
    expect(profile.platforms).toContain('harmonyos');
    expect(profile.techStack['harmonyos']).toBe('arkts');
  });

  it('Tauri 工程 → 桌面三端 + tauri2', () => {
    const profile = inferProjectProfile(
      snapshot({ files: ['src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'package.json'] }),
    );
    expect(profile.platforms).toEqual(expect.arrayContaining(['windows', 'linux', 'macos']));
    expect(profile.techStack).toMatchObject({ windows: 'tauri2', macos: 'tauri2' });
  });

  it('Electron 工程 → 桌面三端 + electron（且不误判为 Web 前端）', () => {
    const profile = inferProjectProfile(
      snapshot({
        files: ['electron-builder.yml', 'package.json', 'main.js'],
        manifests: { 'package.json': '{"dependencies":{"electron":"31.0.0"}}' },
      }),
    );
    expect(profile.techStack['windows']).toBe('electron');
    expect(profile.platforms).not.toContain('web');
  });

  it('Vue 前端 → web + vue3；React 前端 → web + react', () => {
    const vue = inferProjectProfile(
      snapshot({
        files: ['package.json', 'vite.config.ts'],
        manifests: { 'package.json': '{"dependencies":{"vue":"3.4.0"}}' },
      }),
    );
    expect(vue.techStack['web']).toBe('vue3');

    const react = inferProjectProfile(
      snapshot({ files: ['package.json', 'next.config.js'], manifests: { 'package.json': '{"dependencies":{"react":"18.0.0"}}' } }),
    );
    expect(react.techStack['web']).toBe('react');
    expect(react.evidence.join()).toContain('Next / Vite');
  });

  it('后端与数据库标签写入指纹（Java / Node / Python）', () => {
    const java = inferProjectProfile(snapshot({ files: ['pom.xml'], manifests: { 'pom.xml': '<project/>' } }));
    expect(java.techStack['backend']).toBe('java-spring');

    const node = inferProjectProfile(
      snapshot({ files: ['package.json'], manifests: { 'package.json': '{"dependencies":{"fastify":"4.0.0"}}' } }),
    );
    expect(node.techStack['backend']).toBe('node');

    const py = inferProjectProfile(snapshot({ files: ['requirements.txt'], manifests: { 'requirements.txt': 'fastapi' } }));
    expect(py.techStack['backend']).toBe('python');
  });

  it('生产级组合：Tauri + React + Spring → 四端 + 后端指纹', () => {
    const profile = inferProjectProfile(
      snapshot({
        files: ['package.json', 'src-tauri/tauri.conf.json', 'pom.xml', 'vite.config.ts'],
        manifests: {
          'package.json': '{"dependencies":{"react":"18.0.0"}}',
          'src-tauri/tauri.conf.json': '{"tauri":{}}',
          'pom.xml': '<project/>',
        },
      }),
    );
    expect(profile.platforms).toEqual(expect.arrayContaining(['web', 'windows', 'linux', 'macos']));
    expect(profile.techStack).toMatchObject({ web: 'react', windows: 'tauri2', backend: 'java-spring' });
  });

  it('识别不到任何信号时给出空画像与"代码约定"记忆，不臆造技术栈', () => {
    const profile = inferProjectProfile(snapshot({ files: ['README.md'] }));
    expect(profile.frameworks).toEqual([]);
    expect(profile.platforms).toEqual([]);
    expect(profile.techStack).toEqual({});
    // 只有导入约定 + 导入信息两条，无技术栈条目
    expect(profile.memoryDrafts.some((d) => d.title.includes('技术栈'))).toBe(false);
    expect(profile.memoryDrafts.some((d) => d.title.includes('代码约定'))).toBe(true);
  });

  it('深路径中的清单文件同样能被识别（monorepo 子目录）', () => {
    const profile = inferProjectProfile(
      snapshot({ files: ['apps/mobile/pubspec.yaml'], manifests: { 'apps/mobile/pubspec.yaml': 'name: app' } }),
    );
    expect(profile.techStack['android']).toBe('flutter');
  });
});

describe('runGitImport 编排', () => {
  function createPort(overrides: Partial<GitImportPort> = {}): GitImportPort & { cloned: string[] } {
    const cloned: string[] = [];
    return {
      cloned,
      clone: (url, dir) => {
        cloned.push(`${url}→${dir}`);
        return Promise.resolve();
      },
      inspect: () =>
        Promise.resolve(
          snapshot({
            files: ['pubspec.yaml'],
            manifests: { 'pubspec.yaml': 'name: x' },
            remoteUrl: 'https://example.com/mobile.git',
          }),
        ),
      isDirAvailable: () => Promise.resolve(true),
      ...overrides,
    } as GitImportPort & { cloned: string[] };
  }

  it('正常导入：克隆 → 扫描 → 推断，返回计划', async () => {
    const port = createPort();
    const plan = await runGitImport(
      { url: 'https://example.com/mobile.git', targetDir: 'D:/projects/mobile' },
      port,
    );
    expect(port.cloned).toEqual(['https://example.com/mobile.git→D:/projects/mobile']);
    expect(plan.projectName).toBe('mobile');
    expect(plan.defaultBranch).toBe('main');
    expect(plan.profile.techStack['android']).toBe('flutter');
  });

  it('自定义项目名优先于 URL 推断', async () => {
    const plan = await runGitImport(
      { url: 'https://example.com/mobile.git', projectName: '  我的 App  ', targetDir: 'D:/p' },
      createPort(),
    );
    expect(plan.projectName).toBe('我的 App');
  });

  it('目标目录不可用时拒绝执行且不克隆', async () => {
    const port = createPort({ isDirAvailable: () => Promise.resolve(false) });
    await expect(
      runGitImport({ url: 'https://example.com/a.git', targetDir: 'D:/busy' }, port),
    ).rejects.toThrowError(/目标目录已存在且非空/);
    expect(port.cloned).toEqual([]);
  });

  it('非法 URL 直接报错，不触碰端口', async () => {
    const port = createPort();
    await expect(runGitImport({ url: '不是地址', targetDir: 'D:/p' }, port)).rejects.toThrowError(
      /不是有效的 Git 地址/,
    );
    expect(port.cloned).toEqual([]);
  });

  it('克隆进度回调被透传', async () => {
    const steps: string[] = [];
    const port = createPort({
      clone: (_url, _dir, onProgress) => {
        onProgress?.(0.5, '接收对象 50%');
        onProgress?.(1, '完成');
        return Promise.resolve();
      },
    });
    await runGitImport({ url: 'https://example.com/a.git', targetDir: 'D:/p' }, port, (ratio, message) =>
      steps.push(`${ratio}:${message}`),
    );
    expect(steps).toEqual(['0.5:接收对象 50%', '1:完成']);
  });
});
