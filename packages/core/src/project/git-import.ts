/**
 * Git 仓库导入（T9-01 / FR-WSP-02 第三类来源）。
 *
 * 分工：**领域层只做计划与推断**，克隆与文件读取由 `GitImportPort` 由外壳实现
 * （外壳适配 `@ec/git` 的 GitClient + node:fs）——core 不引 @ec/git，
 * 否则 git 包的 Node 侧实现会污染渲染层浏览器构建。
 *
 * 推断结果（框架 → 目标端 → 技术栈指纹 → 项目记忆初稿）全部为纯函数，可测试。
 */

import type { TargetPlatform } from './project-types';
import type { TemplateMemoryDraft } from './project-templates';

/** 仓库快照：由外壳扫描得到（只读，限制规模） */
export interface RepoSnapshot {
  /** 相对路径清单（外壳限制条数，建议 ≤ 2000） */
  files: string[];
  /** 关键清单文件内容（路径 → 前若干 KB 文本，避免超大文件） */
  manifests: Record<string, string>;
  /** 默认分支名 */
  defaultBranch: string | null;
  /** 规范化后的远程地址 */
  remoteUrl: string;
}

/** 克隆与扫描端口（外壳实现） */
export interface GitImportPort {
  /**
   * 克隆仓库到目标目录。
   * @param onProgress 进度回调（0-1，可缺省）
   */
  clone(url: string, targetDir: string, onProgress?: (ratio: number, message: string) => void): Promise<void>;
  /** 扫描已克隆目录，产出推断所需的快照 */
  inspect(dir: string): Promise<RepoSnapshot>;
  /** 目标目录是否可用（非空目录需提示覆盖） */
  isDirAvailable(dir: string): Promise<boolean>;
}

/** 推断结论 */
export interface ProjectProfile {
  /** 识别到的框架/技术标签（如 ['flutter', 'react']） */
  frameworks: string[];
  /** 推断出的目标端（FR-AI-13 七端） */
  platforms: TargetPlatform[];
  /** 各端技术方案建议（矩阵 value） */
  techStack: Record<string, string>;
  /** 推断依据（供 UI 展示"为什么这样推荐"） */
  evidence: string[];
  /** 生成的项目记忆初稿 */
  memoryDrafts: TemplateMemoryDraft[];
}

function readManifest(snapshot: RepoSnapshot, ...candidates: string[]): string | null {
  for (const candidate of candidates) {
    const hit = Object.keys(snapshot.manifests).find(
      (path) => path === candidate || path.endsWith(`/${candidate}`),
    );
    if (hit) return snapshot.manifests[hit] ?? null;
  }
  return null;
}

function hasFile(snapshot: RepoSnapshot, ...candidates: string[]): boolean {
  return snapshot.files.some((path) => candidates.some((c) => path === c || path.endsWith(`/${c}`)));
}

/** 从 manifest 文本里安全地找子串（不解析 JSON，容错优先） */
function contains(text: string | null, needle: string): boolean {
  return text !== null && text.toLowerCase().includes(needle.toLowerCase());
}

/**
 * 由仓库快照推断项目画像。
 * 判定顺序有意为之：先看更具体的信号（Flutter / RN / 鸿蒙 / Tauri），再看通用 Web 信号。
 */
export function inferProjectProfile(snapshot: RepoSnapshot): ProjectProfile {
  const frameworks: string[] = [];
  const platforms: TargetPlatform[] = [];
  const techStack: Record<string, string> = {};
  const evidence: string[] = [];

  const pubspec = readManifest(snapshot, 'pubspec.yaml');
  const packageJson = readManifest(snapshot, 'package.json');
  const cargoToml = readManifest(snapshot, 'Cargo.toml');
  const ohPackage = readManifest(snapshot, 'oh-package.json5', 'oh-package.json');
  const pomXml = readManifest(snapshot, 'pom.xml');
  const requirements = readManifest(snapshot, 'requirements.txt', 'pyproject.toml');

  if (pubspec !== null || hasFile(snapshot, 'pubspec.lock')) {
    frameworks.push('flutter');
    platforms.push('android', 'ios');
    techStack['android'] = 'flutter';
    techStack['ios'] = 'flutter';
    evidence.push('发现 pubspec.yaml（Dart / Flutter 工程）');
  }

  if (contains(packageJson, 'react-native')) {
    frameworks.push('react-native');
    if (!platforms.includes('android')) platforms.push('android', 'ios');
    techStack['android'] = 'react-native';
    techStack['ios'] = 'react-native';
    evidence.push('package.json 依赖含 react-native');
  }

  if (ohPackage !== null || hasFile(snapshot, 'hvigorfile.ts', 'build-profile.json5')) {
    frameworks.push('arkts');
    if (!platforms.includes('harmonyos')) platforms.push('harmonyos');
    techStack['harmonyos'] = 'arkts';
    evidence.push('发现鸿蒙工程描述文件（oh-package.json5 / hvigorfile.ts）');
  }

  const tauriConf = hasFile(snapshot, 'tauri.conf.json') || contains(cargoToml, 'tauri');
  if (tauriConf) {
    frameworks.push('tauri2');
    for (const p of ['windows', 'linux', 'macos'] as const) {
      if (!platforms.includes(p)) platforms.push(p);
      techStack[p] = 'tauri2';
    }
    evidence.push('发现 tauri.conf.json 或 Cargo.toml 依赖 tauri');
  } else if (contains(packageJson, '"electron"') || hasFile(snapshot, 'electron-builder.yml')) {
    frameworks.push('electron');
    for (const p of ['windows', 'linux', 'macos'] as const) {
      if (!platforms.includes(p)) platforms.push(p);
      techStack[p] = 'electron';
    }
    evidence.push('发现 Electron 依赖 / 打包配置');
  }

  const isWebLike =
    packageJson !== null && !contains(packageJson, 'react-native') && !contains(packageJson, '"electron"');
  if (isWebLike) {
    if (contains(packageJson, '"vue"') || hasFile(snapshot, 'vue.config.js')) {
      frameworks.push('vue3');
      techStack['web'] = 'vue3';
      evidence.push('package.json 依赖含 vue');
    } else {
      frameworks.push('react');
      techStack['web'] = 'react';
      evidence.push(
        hasFile(snapshot, 'next.config.js', 'next.config.mjs', 'vite.config.ts', 'vite.config.js')
          ? '发现前端构建配置（Next / Vite）'
          : 'package.json 为 Web 前端工程',
      );
    }
    if (!platforms.includes('web')) platforms.push('web');
  }

  // 后端/数据库标签：写入技术栈指纹（自由文本，不参与 FR-AI-13 矩阵）
  if (pomXml !== null) {
    frameworks.push('spring');
    techStack['backend'] = 'java-spring';
    evidence.push('发现 pom.xml（Java / Spring 工程）');
  } else if (contains(packageJson, '"express"') || contains(packageJson, '"fastify"') || contains(packageJson, '"koa"')) {
    frameworks.push('node-backend');
    techStack['backend'] = 'node';
    evidence.push('package.json 含 Node 服务端框架依赖');
  } else if (requirements !== null) {
    frameworks.push('python');
    techStack['backend'] = 'python';
    evidence.push('发现 Python 依赖清单');
  }

  const memoryDrafts = buildImportMemoryDrafts(snapshot, frameworks, evidence);
  return { frameworks, platforms, techStack, evidence, memoryDrafts };
}

function buildImportMemoryDrafts(
  snapshot: RepoSnapshot,
  frameworks: string[],
  evidence: string[],
): TemplateMemoryDraft[] {
  const drafts: TemplateMemoryDraft[] = [];
  if (frameworks.length > 0) {
    drafts.push({
      scope: 'project',
      title: '导入项目的技术栈（自动识别）',
      content: `识别到技术标签：${frameworks.join('、')}。识别依据：${evidence.join('；')}。请在技术选型阶段确认各端最终方案。`,
      tags: ['技术栈', '导入'],
    });
  }
  drafts.push({
    scope: 'project',
    title: '导入项目的代码约定',
    content: [
      '本项目的既有代码由外部导入，AI 生成需与既有风格保持一致：',
      '- 先读取现有目录结构与依赖清单，再生成新代码；',
      '- 不修改与本需求无关的既有文件；',
      '- 命名与注释遵循仓库现有习惯。',
    ].join('\n'),
    tags: ['规范', '导入'],
  });
  if (snapshot.defaultBranch) {
    drafts.push({
      scope: 'project',
      title: '导入信息',
      content: `远程地址：${snapshot.remoteUrl}；默认分支：${snapshot.defaultBranch}。`,
      tags: ['导入'],
    });
  }
  return drafts;
}

/** 校验 Git URL（http(s) / ssh / git 协议；本地路径需明显是路径） */
export function isValidGitUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^https?:\/\/\S+$/i.test(trimmed)) return true;
  if (/^ssh:\/\/\S+$/i.test(trimmed)) return true;
  if (/^git@[\w.-]+:[\w./-]+$/.test(trimmed)) return true;
  if (/^git:\/\/\S+$/i.test(trimmed)) return true;
  // 本地路径（绝对路径 / 盘符 / 相对路径）
  return /^([a-zA-Z]:[\\/]|\/|\.{1,2}[\\/])\S*$/.test(trimmed);
}

/** 由 URL 推断默认项目名（去掉 .git 后缀与路径前缀） */
export function projectNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '');
  const last = trimmed.split(/[\\/:]/).filter(Boolean).pop() ?? '导入项目';
  return last.replace(/\.git$/i, '') || '导入项目';
}

/** 导入计划（UI 在执行前展示） */
export interface GitImportPlan {
  url: string;
  projectName: string;
  targetDir: string;
  defaultBranch: string | null;
  profile: ProjectProfile;
}

/** 执行 Git 导入：克隆 → 扫描 → 推断，返回计划供服务层建项目 */
export async function runGitImport(
  options: { url: string; projectName?: string | undefined; targetDir: string },
  port: GitImportPort,
  onProgress?: (ratio: number, message: string) => void,
): Promise<GitImportPlan> {
  if (!isValidGitUrl(options.url)) {
    throw new Error(`不是有效的 Git 地址：${options.url}`);
  }
  const available = await port.isDirAvailable(options.targetDir);
  if (!available) {
    throw new Error(`目标目录已存在且非空：${options.targetDir}，请更换目录或先清空`);
  }
  await port.clone(options.url, options.targetDir, onProgress);
  const snapshot = await port.inspect(options.targetDir);
  return {
    url: options.url,
    projectName: options.projectName?.trim() || projectNameFromUrl(options.url),
    targetDir: options.targetDir,
    defaultBranch: snapshot.defaultBranch,
    profile: inferProjectProfile(snapshot),
  };
}
