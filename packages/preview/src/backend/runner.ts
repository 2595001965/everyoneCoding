/**
 * 后端进程托管：通过注入的 ProcessHostPort 启动/停止/重启后端子进程，并把输出汇入日志流。
 *
 * 领域层只暴露能力；停止进程、切换模式导致的服务重启属于破坏性操作，二次确认由渲染层负责
 * （见各方法注释）。本模块不引用 node:child_process，生产由外壳 Shell API 提供 ProcessHostPort。
 */

import { type PortProbe, DEFAULT_PREVIEW_PORT, allocatePort } from '../port-manager';
import { type PreviewLogEntry, type PreviewResult, fail, ok } from '../models';
import type { LogStream } from './log-stream';
import type { ProjectProfile } from './project-detector';

/** 子进程能力端口（生产由 Shell API process 提供）。 */
export interface ProcessHostPort {
  spawn(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string>; shell?: boolean },
  ): Promise<{
    id: string;
    pid: number | null;
    onStdout(l: (chunk: string) => void): () => void;
    onStderr(l: (chunk: string) => void): () => void;
    onExit(l: (r: { code: number | null; signal: string | null }) => void): () => void;
    kill(): Promise<void>;
    readonly exited: Promise<{ code: number | null; signal: string | null }>;
  }>;
}

export interface ManagedProcess {
  id: string;
  pid: number | null;
  command: string;
  port: number;
  url: string;
  startedAt: number;
}

type RunnerEvent = { type: 'started' | 'stopped' | 'log' | 'exited'; detail?: string };

export class BackendRunner {
  private readonly process: ProcessHostPort;
  private readonly logs: LogStream;
  private readonly startPort: number;
  private readonly probe: PortProbe;
  private readonly clock: () => number;
  private current: { handle: Awaited<ReturnType<ProcessHostPort['spawn']>>; proc: ManagedProcess; profile: ProjectProfile; cwd: string } | null = null;
  private running = false;
  private listeners = new Set<(event: RunnerEvent) => void>();

  constructor(opts: {
    process: ProcessHostPort;
    logs: LogStream;
    startPort?: number;
    probe?: PortProbe;
    clock?: () => number;
  }) {
    this.process = opts.process;
    this.logs = opts.logs;
    this.startPort = opts.startPort ?? DEFAULT_PREVIEW_PORT;
    this.probe = opts.probe ?? (async () => true);
    this.clock = opts.clock ?? (() => Date.now());
  }

  async start(profile: ProjectProfile, cwd: string): Promise<PreviewResult<ManagedProcess>> {
    if (profile.startCmd === null) {
      this.logs.warn(`该项目无法自动启动：${profile.label}`);
      return fail('START_UNSUPPORTED', `项目类型 ${profile.label} 暂不支持自动启动，请手动配置启动命令`, this.logsEntries());
    }
    const alloc = await allocatePort({ start: this.startPort, probe: this.probe });
    if (alloc.log) this.logs.info(alloc.log);

    const handle = await this.process.spawn(profile.startCmd, [], { cwd, shell: true });
    this.attach(handle, 'run');

    const proc: ManagedProcess = {
      id: handle.id,
      pid: handle.pid,
      command: profile.startCmd,
      port: alloc.port,
      url: `http://localhost:${alloc.port}`,
      startedAt: this.clock(),
    };
    this.current = { handle, proc, profile, cwd };
    this.running = true;
    this.logs.info(`后端已启动：${proc.command}（端口 ${proc.port}）`);
    this.emit({ type: 'started', detail: proc.url });
    return ok(proc, this.logsEntries());
  }

  /** 停止后端。破坏性操作：二次确认由渲染层负责。 */
  async stop(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    await cur.handle.kill();
    await cur.handle.exited;
    this.running = false;
    this.current = null;
    this.logs.info('后端已停止');
    this.emit({ type: 'stopped' });
  }

  /**
   * 重启后端：先停止再启动。破坏性操作（会短暂打断预览），二次确认由渲染层负责。
   * 复用上一次 start 的 profile / cwd。
   */
  async restart(): Promise<PreviewResult<ManagedProcess>> {
    const cur = this.current;
    if (!cur) {
      this.logs.warn('没有可重启的后端进程');
      return fail('RESTART_NO_PROCESS', '尚未启动后端，无法重启', this.logsEntries());
    }
    await this.stop();
    return this.start(cur.profile, cur.cwd);
  }

  status(): { running: boolean; process: ManagedProcess | null } {
    return { running: this.running, process: this.current?.proc ?? null };
  }

  onEvent(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private attach(
    handle: Awaited<ReturnType<ProcessHostPort['spawn']>>,
    source: 'run' | 'install' | 'build' | 'task',
  ): void {
    handle.onStdout((chunk) => this.ingest(chunk, 'stdout', source));
    handle.onStderr((chunk) => this.ingest(chunk, 'stderr', source));
    handle.onExit((r) => {
      this.running = false;
      const detail = `exit code=${r.code ?? 'null'} signal=${r.signal ?? 'null'}`;
      this.logs.info(`后端进程退出：${detail}`);
      this.emit({ type: 'exited', detail });
    });
  }

  private ingest(chunk: string, stream: 'stdout' | 'stderr', source: 'run' | 'install' | 'build' | 'task'): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      this.logs.push({ source, text: line, stream });
    }
  }

  private emit(event: RunnerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private logsEntries(): PreviewLogEntry[] {
    return this.logs.lines().map((l) => ({ level: l.level, message: l.text, at: l.at }));
  }
}
