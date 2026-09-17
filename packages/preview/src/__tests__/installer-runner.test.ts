import { describe, expect, it } from 'vitest';
import { LogStream } from '../backend/log-stream';
import { DependencyInstaller } from '../backend/dependency-installer';
import { BackendRunner, type ProcessHostPort } from '../backend/runner';
import { detectProjectType } from '../backend/project-detector';

type ExitResult = { code: number | null; signal: string | null };

class FakeHandle {
  id = 'proc-1';
  pid = 999;
  killed = false;
  private stdoutLs: Array<(c: string) => void> = [];
  private stderrLs: Array<(c: string) => void> = [];
  private exitLs: Array<(r: ExitResult) => void> = [];
  private resolveExit!: (r: ExitResult) => void;
  readonly exited: Promise<ExitResult>;

  constructor() {
    this.exited = new Promise((res) => {
      this.resolveExit = res;
    });
  }

  onStdout(l: (c: string) => void): () => void {
    this.stdoutLs.push(l);
    return () => {};
  }
  onStderr(l: (c: string) => void): () => void {
    this.stderrLs.push(l);
    return () => {};
  }
  onExit(l: (r: ExitResult) => void): () => void {
    this.exitLs.push(l);
    return () => {};
  }
  async kill(): Promise<void> {
    this.killed = true;
    this.emitExit(0);
  }
  emitStdout(c: string): void {
    for (const l of this.stdoutLs) l(c);
  }
  emitStderr(c: string): void {
    for (const l of this.stderrLs) l(c);
  }
  emitExit(code: number): void {
    const r: ExitResult = { code, signal: null };
    for (const l of this.exitLs) l(r);
    this.resolveExit(r);
  }
}

class FakeProcessHost implements ProcessHostPort {
  commands: string[] = [];
  private handles: FakeHandle[] = [];
  spawn(
    command: string,
    _args: string[],
    _options?: { cwd?: string; env?: Record<string, string>; shell?: boolean },
  ): Promise<FakeHandle> {
    this.commands.push(command);
    const h = new FakeHandle();
    this.handles.push(h);
    return Promise.resolve(h);
  }
  latest(): FakeHandle {
    const h = this.handles.at(-1);
    if (!h) throw new Error('no handle');
    return h;
  }
}

describe('DependencyInstaller', () => {
  it('安装命令经 shell 触发并回显结构化日志', async () => {
    const host = new FakeProcessHost();
    const logs = new LogStream({ clock: () => 1000 });
    const installer = new DependencyInstaller({ process: host, logs });
    const profile = detectProjectType(['package.json']);
    const p = installer.run(profile, '/proj');
    expect(host.commands).toContain('npm install');
    await Promise.resolve();
    const handle = host.latest();
    handle.emitStdout('added 10 packages');
    handle.emitExit(0);
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.data?.command).toBe('npm install');
    expect(result.data?.exitCode).toBe(0);
    expect(logs.lines().some((l) => l.text.includes('added 10 packages'))).toBe(true);
  });

  it('stderr 行登记为 error 级别', async () => {
    const host = new FakeProcessHost();
    const logs = new LogStream({ clock: () => 1000 });
    const installer = new DependencyInstaller({ process: host, logs });
    const profile = detectProjectType(['package.json']);
    const p = installer.run(profile, '/proj');
    await Promise.resolve();
    const handle = host.latest();
    handle.emitStderr('npm ERR! peer dep');
    handle.emitExit(1);
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INSTALL_FAILED');
    const errLine = logs.lines().find((l) => l.text.includes('npm ERR'));
    expect(errLine?.level).toBe('error');
  });

  it('不支持安装的项目类型返回失败且不触发命令', async () => {
    const host = new FakeProcessHost();
    const logs = new LogStream({ clock: () => 1000 });
    const installer = new DependencyInstaller({ process: host, logs });
    const profile = detectProjectType([]);
    const result = await installer.run(profile, '/proj');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INSTALL_UNSUPPORTED');
    expect(host.commands).toHaveLength(0);
  });
});

describe('BackendRunner', () => {
  it('启动后端并通过事件回显', async () => {
    const host = new FakeProcessHost();
    const logs = new LogStream({ clock: () => 1000 });
    const runner = new BackendRunner({ process: host, logs });
    const profile = detectProjectType(['package.json']);
    const events: string[] = [];
    runner.onEvent((e) => events.push(e.type));
    const result = await runner.start(profile, '/proj');
    const handle = host.latest();
    expect(result.ok).toBe(true);
    expect(result.data?.url).toBe('http://localhost:4173');
    expect(runner.status().running).toBe(true);
    expect(events).toContain('started');
    handle.emitStdout('listening on 3000');
    handle.emitExit(0);
    await handle.exited;
    expect(runner.status().running).toBe(false);
    expect(events).toContain('exited');
  });

  it('停止后端调用 kill', async () => {
    const host = new FakeProcessHost();
    const logs = new LogStream({ clock: () => 1000 });
    const runner = new BackendRunner({ process: host, logs });
    const profile = detectProjectType(['package.json']);
    const result = await runner.start(profile, '/proj');
    const handle = host.latest();
    expect(result.ok).toBe(true);
    await runner.stop();
    expect(handle.killed).toBe(true);
    expect(runner.status().running).toBe(false);
  });

  it('重启先后停止再启动（二次确认由渲染层负责）', async () => {
    const host = new FakeProcessHost();
    const logs = new LogStream({ clock: () => 1000 });
    const runner = new BackendRunner({ process: host, logs });
    const profile = detectProjectType(['package.json']);
    const result = await runner.start(profile, '/proj');
    const h1 = host.latest();
    expect(result.ok).toBe(true);
    h1.emitExit(0);
    await h1.exited;
    const pr = await runner.restart();
    expect(pr.ok).toBe(true);
    expect(host.commands.filter((c) => c === 'npm run dev')).toHaveLength(2);
  });

  it('无启动命令返回失败', async () => {
    const host = new FakeProcessHost();
    const logs = new LogStream({ clock: () => 1000 });
    const runner = new BackendRunner({ process: host, logs });
    const profile = detectProjectType([]);
    const result = await runner.start(profile, '/proj');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('START_UNSUPPORTED');
  });
});
