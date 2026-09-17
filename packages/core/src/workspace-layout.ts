import type { ShellHost } from '@ec/shell-api';

/**
 * 工程目录约定：
 * ```
 * <workspace>/
 *   projects/
 *     <projectId>/
 *       design/     页面 DSL 与设计器产物
 *       docs/       需求文档 / 技术文档
 *       pipeline/   S1–S7 阶段产物与状态
 *       code/       生成的源码工程
 *       meta/       项目元数据（记忆索引、锚点、设置快照）
 * ```
 */

export const PROJECT_SUBDIRS = ['design', 'docs', 'pipeline', 'code', 'meta'] as const;

export type ProjectSubdir = (typeof PROJECT_SUBDIRS)[number];

export interface WorkspaceValidateResult {
  projectId: string;
  root: string;
  missing: string[];
  ok: boolean;
}

export interface WorkspaceLayoutOptions {
  /** 工作区根目录（FR-SET-03 可自定义） */
  root: string;
}

export class WorkspaceLayout {
  private rootDir: string;

  constructor(
    private readonly shell: ShellHost,
    options: WorkspaceLayoutOptions,
  ) {
    this.rootDir = options.root;
  }

  get root(): string {
    return this.rootDir;
  }

  get projectsDir(): string {
    return this.shell.path.join(this.rootDir, 'projects');
  }

  /** 迁移工作区：仅更新根引用，不搬运数据（搬运由 .ecpkg 导入负责） */
  setRoot(root: string): void {
    this.rootDir = root;
  }

  projectDir(projectId: string): string {
    return this.shell.path.join(this.projectsDir, projectId);
  }

  subdir(projectId: string, subdir: ProjectSubdir): string {
    return this.shell.path.join(this.projectDir(projectId), subdir);
  }

  /** 创建工作区与项目目录（幂等） */
  async create(projectId: string): Promise<string[]> {
    const created: string[] = [];
    const root = this.projectDir(projectId);
    await this.shell.fs.mkdir(root, { recursive: true });
    created.push(root);
    for (const subdir of PROJECT_SUBDIRS) {
      const dir = this.subdir(projectId, subdir);
      await this.shell.fs.mkdir(dir, { recursive: true });
      created.push(dir);
    }
    return created;
  }

  /** 校验目录结构，返回缺失项 */
  async validate(projectId: string): Promise<WorkspaceValidateResult> {
    const root = this.projectDir(projectId);
    const missing: string[] = [];
    if (!(await this.shell.fs.exists(root))) missing.push(root);
    for (const subdir of PROJECT_SUBDIRS) {
      const dir = this.subdir(projectId, subdir);
      if (!(await this.shell.fs.exists(dir))) missing.push(dir);
    }
    return { projectId, root, missing, ok: missing.length === 0 };
  }

  /** 修复缺失目录，返回被修复的目录列表 */
  async repair(projectId: string): Promise<string[]> {
    const result = await this.validate(projectId);
    if (result.ok) return [];
    for (const dir of result.missing) {
      await this.shell.fs.mkdir(dir, { recursive: true });
    }
    return result.missing;
  }
}
