import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { GitImportPort, RepoSnapshot } from '@ec/core';
import { ShellError } from '@ec/shell-api';

/**
 * `GitImportPort` 的系统实现（契约由 `@ec/core` 的 `git-import` 定义）。
 *
 * 走**系统 git CLI**而非绑定库：
 * - 克隆需要凭据助手、代理、SSH 等用户既有配置，CLI 天然继承；
 * - 进度可从 `--progress` 的 stderr 解析（`Receiving objects: 42%`）。
 * 与本仓库 git 集成测试"CLI 优先"的取向一致。
 *
 * **扫描规模限制**：文件清单上限 `MAX_FILES` 条、清单文件只读前 `MANIFEST_BYTES` 字节——
 * `inferProjectProfile` 只需要清单内容，读全文会让超大仓库的导入变成分钟级阻塞。
 * `.git` 与常见构建产物目录一律跳过。
 */

const MAX_FILES = 2000;
const MANIFEST_BYTES = 64 * 1024;

/** 推断所需的清单文件（`inferProjectProfile` 按 basename 后缀匹配） */
const MANIFEST_NAMES: readonly string[] = [
  'package.json',
  'pubspec.yaml',
  'pubspec.yml',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'composer.json',
  'Podfile',
  'Gemfile',
  'CMakeLists.txt',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'manifest.json',
  'Info.plist',
  'oh-package.json5',
  'build-profile.json5',
];

/** 扫描时跳过的目录（成本高且对推断无价值） */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  'Pods',
  'DerivedData',
  '.idea',
  '.vscode',
]);

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function readManifestText(file: string): string {
  const stat = statSync(file);
  // 超限只读前若干字节（解析器只看开头字段）
  return stat.size <= MANIFEST_BYTES
    ? readFileSync(file, 'utf8')
    : readFileSync(file, 'utf8').slice(0, MANIFEST_BYTES);
}

/** 递归扫描：收集相对路径清单（带上限）与关键清单文件内容 */
function scan(dir: string): { files: string[]; manifests: Record<string, string> } {
  const files: string[] = [];
  const manifests: Record<string, string> = {};
  let full = false;

  const walk = (current: string): void => {
    if (full) return;
    // 显式标注 Dirent[]：ReturnType<typeof readdirSync> 会落到 Buffer 重载上
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (full) return;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_FILES) {
        full = true;
        return;
      }
      const rel = toPosix(relative(dir, path));
      files.push(rel);
      if (MANIFEST_NAMES.includes(entry.name) && manifests[rel] === undefined) {
        try {
          manifests[rel] = readManifestText(path);
        } catch {
          /* 读不到就当没有，不阻断扫描 */
        }
      }
    }
  };

  walk(dir);
  return { files, manifests };
}

/** 解析 git clone 的 stderr 进度行（`Receiving objects:  42% (…/…)`） */
export function parseCloneProgress(line: string): number | null {
  const match = /(\d{1,3})%/.exec(line);
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? Math.max(0, Math.min(1, percent / 100)) : null;
}

export interface GitCliPortOptions {
  /** git 可执行文件（缺省走 PATH 上的 git） */
  gitExecutable?: string | undefined;
}

export function createGitImportPort(options: GitCliPortOptions = {}): GitImportPort {
  const git = options.gitExecutable ?? 'git';

  /** 跑一条 git 命令；不抛错（退出码由调用方判读） */
  const run = (
    args: string[],
    onStderr?: ((line: string) => void) | undefined,
  ): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(git, args, { windowsHide: true });
      } catch (error) {
        reject(
          new ShellError(
            'PROCESS_SPAWN_FAILED',
            `无法启动 git：${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      let stdout = '';
      let stderr = '';
      let stderrBuffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderr += text;
        if (onStderr === undefined) return;
        // git 的进度用 \r 刷新：按 \r 与 \n 双分隔逐行解析
        stderrBuffer += text;
        const parts = stderrBuffer.split(/[\r\n]/);
        stderrBuffer = parts.pop() ?? '';
        for (const line of parts) if (line.trim().length > 0) onStderr(line);
      });
      child.on('error', (error) => {
        reject(
          new ShellError(
            'PROCESS_SPAWN_FAILED',
            `无法启动 git（请确认已安装并加入 PATH）：${error.message}`,
          ),
        );
      });
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });

  return {
    async isDirAvailable(dir: string): Promise<boolean> {
      if (!existsSync(dir)) return true;
      try {
        return readdirSync(dir).length === 0;
      } catch {
        return false;
      }
    },

    async clone(url, targetDir, onProgress): Promise<void> {
      const result = await run(
        ['clone', '--progress', '--', url, targetDir],
        onProgress === undefined
          ? undefined
          : (line) => {
              const ratio = parseCloneProgress(line);
              if (ratio !== null) onProgress(ratio, line.trim());
            },
      );
      if (result.code !== 0) {
        throw new ShellError(
          'IO_ERROR',
          `克隆失败（git 退出码 ${result.code}）：${result.stderr.trim().slice(-400)}`,
        );
      }
      onProgress?.(1, '克隆完成');
    },

    async inspect(dir): Promise<RepoSnapshot> {
      const { files, manifests } = scan(dir);
      // 克隆下来的仓库 HEAD 即默认分支
      const branch = await run(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      const branchName = branch.code === 0 ? branch.stdout.trim() : '';
      const remote = await run(['-C', dir, 'remote', 'get-url', 'origin']);
      return {
        files,
        manifests,
        // 分离头指针时 rev-parse 会回 'HEAD'，那不是分支名
        defaultBranch: branchName.length > 0 && branchName !== 'HEAD' ? branchName : null,
        remoteUrl: remote.code === 0 ? remote.stdout.trim() : '',
      };
    },
  };
}
