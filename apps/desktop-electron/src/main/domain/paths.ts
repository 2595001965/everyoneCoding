import { isAbsolute, join, resolve, sep } from 'node:path';

import { ShellError } from '@ec/shell-api';

/**
 * 工程根目录安全校验（T12-04 实现要点 1：「所有路径必须经过工程根目录安全校验」）。
 *
 * 为什么集中一处：git / preview / rename / nav 四个域都会「拿着渲染层给的
 * projectId 或相对路径去拼绝对路径」。这种拼法最容易出的两类事故是
 * ① `projectId` 里塞 `..\\..\\` 直接读写用户其它目录；
 * ② 相对路径里塞绝对路径或 `..`，让 `join` 把根目录整段吃掉
 * （`join('/root', 'C:/x')` 在 Windows 上会得到 `C:\root\C:\x` 这类畸形结果，
 * 而 `resolve` 会真的跑出根）。
 *
 * 因此本模块提供**唯一的**拼接入口，并统一在越界时抛 `PATH_ESCAPE`：
 * 上层（域路由）不需要各自写一遍 `startsWith(root + sep)` —— 那种写法
 * 一旦有人忘了加 `+ sep`，`/root-evil` 就会被判成 `/root` 的子路径。
 */

/** 工程目录根（`<workspaceRoot>/projects`）下的标准子目录（WorkspaceLayout 约定） */
export const PROJECT_SUBDIRS = {
  design: 'design',
  pages: join('design', 'pages'),
  docs: 'docs',
  code: 'code',
  pipeline: 'pipeline',
  meta: 'meta',
} as const;

export type ProjectSubdir = keyof typeof PROJECT_SUBDIRS;

/**
 * projectId 合法性。
 *
 * 允许字母 / 数字 / `.` `_` `-`（覆盖 ULID 与测试用的 `p-journey` 形态），
 * 显式拒绝 `.` `..` 与任何路径分隔符。ULID 大小写敏感，故不做大小写归一。
 */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isSafeProjectId(projectId: string): boolean {
  if (projectId.length === 0 || projectId.length > 128) return false;
  if (projectId === '.' || projectId === '..') return false;
  return PROJECT_ID_PATTERN.test(projectId);
}

/** 越界错误：带上「哪个动作被拒」，便于日志定位；**不带绝对路径**（面向用户的错误不泄漏目录结构） */
function pathEscape(action: string): ShellError {
  return new ShellError('PATH_ESCAPE', `路径越出工程根目录，已拒绝：${action}`);
}

function invalidArgument(message: string): ShellError {
  return new ShellError('INVALID_ARGUMENT', message);
}

/**
 * 工程路径解析器工厂。
 *
 * 用法：`const paths = createProjectPaths({ projectsDir })`，
 * 之后所有域内路径都走 `paths.*`，不要再各自 `join(options.projectsDir, ...)`。
 */
export interface ProjectPaths {
  /** 工程目录根（已 resolve，后续比较都基于它） */
  readonly projectsDir: string;
  /** `<projectsDir>/<projectId>`；非法 id 抛 INVALID_ARGUMENT，越界抛 PATH_ESCAPE */
  projectRoot(projectId: string): string;
  /** `<projectsDir>/<projectId>/<subdir...>` */
  projectDir(projectId: string, ...segments: string[]): string;
  /** 常用快捷：代码根 */
  codeRoot(projectId: string): string;
  /** 常用快捷：设计器 DSL 根（`design/pages`） */
  pagesDir(projectId: string): string;
  /** 常用快捷：文档根 */
  docsDir(projectId: string): string;
  /**
   * 把**工作区相对路径**解析到 `root` 之下。
   *
   * 拒绝：绝对路径、含 `..` 的路径、Windows 驱动器前缀、UNC 前缀。
   * 返回的是已 resolve 的绝对路径，调用方可直接读写。
   */
  inside(root: string, relativePath: string): string;
  /**
   * 把绝对路径还原为 `root` 下的**正斜杠相对路径**（给仓库 / 索引用）。
   * 不在 `root` 之下时抛 PATH_ESCAPE。
   */
  relative(root: string, absolutePath: string): string;
  /** 判断绝对路径是否落在 `root` 之内（不抛错，供过滤用） */
  contains(root: string, absolutePath: string): boolean;
}

export interface CreateProjectPathsOptions {
  /** 工程目录根；调用方负责保证它自身已是绝对路径 */
  projectsDir: string;
}

export function createProjectPaths(options: CreateProjectPathsOptions): ProjectPaths {
  const projectsDir = resolve(options.projectsDir);

  /** 子树判定：必须 `root + sep` 前缀，否则 `/root-evil` 会被误判为 `/root` 的子路径 */
  const contains = (root: string, absolutePath: string): boolean => {
    const target = resolve(absolutePath);
    const base = resolve(root);
    return target === base || target.startsWith(base + sep);
  };

  const projectRoot = (projectId: string): string => {
    if (projectId.length === 0) throw invalidArgument('缺少 projectId');
    if (!isSafeProjectId(projectId)) throw invalidArgument('非法项目标识');
    const root = resolve(join(projectsDir, projectId));
    // 双保险：即使 id 校验将来被放宽，这里也不会把根拼出去
    if (!contains(projectsDir, root) || root === projectsDir) throw pathEscape('projectId');
    return root;
  };

  const projectDir = (projectId: string, ...segments: string[]): string => {
    const root = projectRoot(projectId);
    if (segments.length === 0) return root;
    const joined = segments.join('/');
    return inside(root, joined);
  };

  function inside(root: string, relativePath: string): string {
    const base = resolve(root);
    const raw = relativePath.trim();
    if (raw.length === 0) throw invalidArgument('缺少文件路径');
    if (raw.includes('\0')) throw invalidArgument('文件路径含非法字符');
    // 绝对路径与驱动器 / UNC 前缀一律拒绝：这类输入应被上层识别为"调用方搞错了"
    if (
      isAbsolute(raw) ||
      /^[A-Za-z]:/.test(raw) ||
      raw.startsWith('\\\\') ||
      raw.startsWith('//')
    ) {
      throw pathEscape('拒绝绝对路径');
    }
    const normalized = raw.replace(/\\/g, '/');
    if (normalized.split('/').includes('..')) throw pathEscape('拒绝向上越界（..）');
    const target = resolve(base, normalized);
    if (!contains(base, target)) throw pathEscape('相对路径');
    return target;
  }

  const relative = (root: string, absolutePath: string): string => {
    const base = resolve(root);
    const target = resolve(absolutePath);
    if (!contains(base, target)) throw pathEscape('相对化');
    if (target === base) return '';
    return target.slice(base.length + 1).replace(/\\/g, '/');
  };

  return {
    projectsDir,
    projectRoot,
    projectDir,
    codeRoot: (projectId) => projectDir(projectId, PROJECT_SUBDIRS.code),
    pagesDir: (projectId) => projectDir(projectId, PROJECT_SUBDIRS.pages),
    docsDir: (projectId) => projectDir(projectId, PROJECT_SUBDIRS.docs),
    inside,
    relative,
    contains,
  };
}
