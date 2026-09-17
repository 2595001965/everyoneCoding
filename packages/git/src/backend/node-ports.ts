import { spawn } from 'node:child_process';
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { GitFilerPort, GitProcessRunner, GitRunOptions, GitRunResult } from './types';

/**
 * Node 侧端口实现（仅 Node 环境；**不进 browser.ts**）。
 *
 * 为什么不用 `execFile`：git 的 stderr 会比 stdout 大很多（进度输出），
 * 而且 `rebase`/`merge` 可能需要 stdin，`spawn` + 手动收集缓冲更可控。
 *
 * 编码：以 Buffer 收集后按 UTF-8 解码。Windows 下若 git 输出的是本地代码页
 * （GBK），中文会变成 U+FFFD；因此这里默认补 `LC_ALL=C.UTF-8`（调用方未显式设置时），
 * 配合 CLI 后端的 `-c core.quotepath=false` 与 `-c i18n.logOutputEncoding=UTF-8`，
 * 中文路径与提交信息可以正常往返。实测（T6-01 集成测试）中文文件名全程正确。
 */

export interface NodeGitRunnerOptions {
  /** 单个流的最大缓冲（字节），默认 64MB；超出即截断并置 exitCode -1 */
  maxBuffer?: number;
  /** git 可执行文件路径，默认 'git' */
  gitPath?: string;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export function createNodeGitRunner(options: NodeGitRunnerOptions = {}): GitProcessRunner {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const gitPath = options.gitPath ?? 'git';

  return {
    run(args: readonly string[], runOptions: GitRunOptions): Promise<GitRunResult> {
      // 第一个元素是可执行文件（与 GitBackend 约定一致）
      const [command = gitPath, ...rest] = args;
      return spawnCollect(command, rest, runOptions, maxBuffer);
    },
  };
}

function spawnCollect(
  command: string,
  args: readonly string[],
  options: GitRunOptions,
  maxBuffer: number,
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    if (process.platform === 'win32' && env['LC_ALL'] === undefined) env['LC_ALL'] = 'C.UTF-8';
    if (options.env !== undefined) Object.assign(env, options.env);

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let overflow = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > maxBuffer) {
        overflow = true;
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > maxBuffer) {
        overflow = true;
        return;
      }
      stderrChunks.push(chunk);
    });

    if (options.input !== undefined) child.stdin?.end(options.input, 'utf8');
    else child.stdin?.end();

    let settled = false;
    const settle = (exitCode: number, extraStderr?: string): void => {
      if (settled) return;
      settled = true;
      resolve({
        args: [command, ...args],
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks) + (extraStderr ?? ''),
        exitCode: overflow ? -1 : exitCode,
      });
    };

    child.on('error', (error: Error) => {
      settle(127, `\n${error.message}`);
    });
    child.on('close', (code: number | null) => {
      settle(code ?? 0);
    });
  });
}

function decode(chunks: readonly Buffer[]): string {
  const text = Buffer.concat(chunks).toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 基于 node:fs/promises 的文件端口（临时文件 + 原子替换，符合硬约束 6） */
export function createNodeFiler(): GitFilerPort {
  return {
    async readText(path: string): Promise<string | null> {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    async writeAtomic(path: string, data: string): Promise<void> {
      const temp = `${path}.ec-tmp-${Date.now().toString(36)}`;
      await writeFile(temp, data, 'utf8');
      await rename(temp, path);
    },
    async exists(path: string): Promise<boolean> {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async size(path: string): Promise<number | null> {
      try {
        return (await stat(path)).size;
      } catch {
        return null;
      }
    },
    async remove(path: string): Promise<void> {
      await rm(path, { force: true });
    },
    async listNames(path: string): Promise<string[]> {
      try {
        return await readdir(path);
      } catch {
        return [];
      }
    },
  };
}

/** 目录的父路径（供 .gitignore 定位） */
export function parentDir(path: string): string {
  return dirname(path);
}
