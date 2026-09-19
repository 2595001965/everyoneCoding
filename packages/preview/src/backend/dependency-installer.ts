/**
 * 依赖安装：通过注入的 ProcessHostPort 执行安装命令，并把输出汇入日志流（供 UI 结构化回显）。
 *
 * 领域层只暴露能力；生产由外壳 Shell API process 提供 ProcessHostPort，不在本包引用 node:*。
 */

import type { PreviewLogEntry, PreviewResult } from '../models';
import { fail, ok } from '../models';
import type { LogStream } from './log-stream';
import type { ProjectProfile } from './project-detector';
import type { ProcessHostPort } from './runner';

export class DependencyInstaller {
  private readonly process: ProcessHostPort;
  private readonly logs: LogStream;

  constructor(opts: { process: ProcessHostPort; logs: LogStream; clock?: () => number }) {
    this.process = opts.process;
    this.logs = opts.logs;
  }

  async run(
    profile: ProjectProfile,
    cwd: string,
  ): Promise<PreviewResult<{ command: string; exitCode: number | null }>> {
    if (profile.installCmd === null) {
      this.logs.warn(`该项目无需安装依赖或需手动安装：${profile.label}`);
      return fail(
        'INSTALL_UNSUPPORTED',
        `项目类型 ${profile.label} 暂不支持自动安装依赖`,
        this.entries(),
      );
    }
    const command = profile.installCmd;
    this.logs.info(`开始安装依赖：${command}（${cwd}）`);
    const handle = await this.process.spawn(command, [], { cwd, shell: true });
    handle.onStdout((chunk) => this.ingest(chunk, 'stdout'));
    handle.onStderr((chunk) => this.ingest(chunk, 'stderr'));
    const result = await handle.exited;
    const exitCode = result.code;
    if (exitCode !== null && exitCode !== 0) {
      this.logs.warn(`依赖安装失败，退出码 ${exitCode}`);
      return fail('INSTALL_FAILED', `依赖安装失败，退出码 ${exitCode}`, this.entries());
    }
    this.logs.info(`依赖安装完成（退出码 ${exitCode ?? 'null'}）`);
    return ok({ command, exitCode }, this.entries());
  }

  private ingest(chunk: string, stream: 'stdout' | 'stderr'): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      this.logs.push({ source: 'install', text: line, stream });
    }
  }

  private entries(): PreviewLogEntry[] {
    return this.logs.lines().map((l) => ({ level: l.level, message: l.text, at: l.at }));
  }
}
