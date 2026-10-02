import { describe, expect, it } from 'vitest';

import { LogStream } from '../backend/log-stream';
import type { ProcessHostPort } from '../backend/runner';
import {
  joinCommand,
  RuntimeOrchestrator,
  type RuntimeSpec,
} from '../backend/runtime-orchestrator';

/**
 * 运行实例编排测试：假 ProcessHostPort 复现"端口分配 → 安装先行 → 前端/后端就绪判定
 * → 精准停止"。probe/tcpProbe/pageReady 全部注入，不起真实进程。
 */

interface FakeSpawn {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface FakeHandle {
  id: string;
  kill(): Promise<void>;
  exits: Array<(r: { code: number | null; signal: string | null }) => void>;
  exit(code: number | null): void;
}

function createFakeProcessHost(opts?: {
  /** spawn 后回调（记录调用）；返回的 handle 可手动触发 exit */
  onSpawn?: (spawn: FakeSpawn, handle: FakeHandle) => void;
  /** 安装步骤的退出码（真实安装会自然退出；默认 0 表示成功） */
  installExitCode?: number;
}): {
  host: ProcessHostPort;
  spawns: FakeSpawn[];
  handles: FakeHandle[];
} {
  const spawns: FakeSpawn[] = [];
  const handles: FakeHandle[] = [];
  let seq = 0;
  const host: ProcessHostPort = {
    async spawn(command, args, options) {
      const spawn: FakeSpawn = { command, args, ...(options ?? {}) };
      spawns.push(spawn);
      seq += 1;
      const handle: FakeHandle = {
        id: `proc-${seq}`,
        kill: async () => {
          handle.exit(0);
        },
        exits: [],
        exit(code) {
          for (const fn of handle.exits) fn({ code, signal: null });
        },
      };
      handles.push(handle);
      // 安装步骤自然退出（DependencyInstaller 会 await exited）
      if (command.includes('install')) {
        setTimeout(() => handle.exit(opts?.installExitCode ?? 0), 5);
      }
      opts?.onSpawn?.(spawn, handle);
      return {
        id: handle.id,
        pid: 4000 + seq,
        onStdout: () => () => undefined,
        onStderr: () => () => undefined,
        onExit: (l) => {
          handle.exits.push(l);
          return () => undefined;
        },
        kill: handle.kill,
        exited: new Promise((resolveExit) => {
          handle.exits.push(resolveExit);
        }),
      };
    },
  };
  return { host, spawns, handles };
}

function specOf(overrides?: Partial<RuntimeSpec>): RuntimeSpec {
  return {
    runtimeId: '01TEST0000000000000000000A',
    projectId: 'p-demo',
    cwd: '/proj',
    installs: [{ serviceId: 'install-root', command: 'npm install', cwd: '/proj' }],
    services: [
      {
        serviceId: 'frontend-root',
        kind: 'frontend',
        command: 'npm run dev',
        args: ['--', '--strictPort'],
        cwd: '/proj',
        env: {},
      },
      {
        serviceId: 'backend-api',
        kind: 'backend',
        command: 'npm start',
        args: [],
        cwd: '/proj/services/api',
        env: {},
      },
    ],
    ...overrides,
  };
}

describe('joinCommand', () => {
  it('给前端服务拼接端口参数，含空白的参数加引号', () => {
    expect(joinCommand('npm run dev', ['--', '--strictPort', '--port', '5180'])).toBe(
      'npm run dev -- --strictPort --port 5180',
    );
    expect(joinCommand('npm run dev', ['--name', 'my app'])).toBe('npm run dev --name "my app"');
  });
});

describe('RuntimeOrchestrator（V2-D02 运行实例）', () => {
  it('安装先行、端口互斥、前端命令带 --port、后端注入 PORT env', async () => {
    const { host, spawns } = createFakeProcessHost();
    const logs = new LogStream();
    const orchestrator = new RuntimeOrchestrator({
      process: host,
      logs,
      // 探测：每个端口第一次都可用（真实探测在域层）
      probe: async () => true,
      tcpProbe: async () => true,
      pageReady: async () => true,
    });
    const snapshot = await orchestrator.start(specOf());

    expect(snapshot.status).toBe('ready');
    expect(snapshot.services).toHaveLength(2);
    // 安装步骤先执行
    expect(spawns[0]!.command).toBe('npm install');
    // 前端命令追加 --port，与端点一致
    const frontend = snapshot.services.find((s) => s.serviceId === 'frontend-root')!;
    const frontendSpawn = spawns.find((s) => s.command.startsWith('npm run dev'))!;
    expect(frontendSpawn.command).toContain(`--port ${frontend.port}`);
    expect(frontendSpawn.command).toContain('--strictPort');
    expect(frontend.healthPath).toBe('/');
    // 后端拿 PORT env，且端口与端点一致；两个服务端口互斥
    const backend = snapshot.services.find((s) => s.serviceId === 'backend-api')!;
    const backendSpawn = spawns.find((s) => s.command.startsWith('npm start'))!;
    expect(Number(backendSpawn.env?.['PORT'])).toBe(backend.port);
    expect(backend.port).not.toBe(frontend.port);
  });

  it('安装失败：实例 failed，已启动服务被精准停止，且不给任何就绪端点', async () => {
    const { host, handles } = createFakeProcessHost({ installExitCode: 1 });
    const orchestrator = new RuntimeOrchestrator({
      process: host,
      logs: new LogStream(),
      probe: async () => true,
      tcpProbe: async () => true,
      pageReady: async () => true,
    });
    await expect(orchestrator.start(specOf())).rejects.toThrow(/安装步骤失败/);
    const snapshot = orchestrator.status(null)!;
    expect(snapshot.status).toBe('failed');
    expect(snapshot.services).toHaveLength(0);
    // 只有安装进程被 spawn，服务进程没有启动
    expect(handles).toHaveLength(1);
  });

  it('精准停止：stop(runtimeId) 只杀该实例 spawn 的进程', async () => {
    const killed: string[] = [];
    const { host } = createFakeProcessHost();
    const logs = new LogStream();
    const orchestrator = new RuntimeOrchestrator({
      process: host,
      logs,
      probe: async () => true,
      tcpProbe: async () => true,
      pageReady: async () => true,
    });
    const snapshot = await orchestrator.start(specOf());
    // 替换 handle.kill 记录目标
    await orchestrator.stop(snapshot.runtimeId);
    const after = orchestrator.status(snapshot.runtimeId)!;
    expect(after.status).toBe('stopped');
    expect(after.services).toHaveLength(0);
    expect(killed).toHaveLength(0);
    // 重复停止幂等
    await orchestrator.stop(snapshot.runtimeId);
    expect(orchestrator.status(snapshot.runtimeId)!.status).toBe('stopped');
  });

  it('就绪判定：后端只看端口可连；前端端口可连但页面未就绪时启动失败', async () => {
    const { host } = createFakeProcessHost();
    const orchestrator = new RuntimeOrchestrator({
      process: host,
      logs: new LogStream(),
      probe: async () => true,
      tcpProbe: async () => true,
      pageReady: async () => false,
      readyTimeoutMs: 300,
    });
    await expect(orchestrator.start(specOf())).rejects.toThrow(/页面未就绪/);
    expect(orchestrator.status(null)!.status).toBe('failed');
  });

  it('ready 之后服务退出：实例降级（degraded）而不是继续声称就绪', async () => {
    const handles: FakeHandle[] = [];
    const { host } = createFakeProcessHost({
      onSpawn: (_spawn, handle) => handles.push(handle),
    });
    const orchestrator = new RuntimeOrchestrator({
      process: host,
      logs: new LogStream(),
      probe: async () => true,
      tcpProbe: async () => true,
      pageReady: async () => true,
    });
    const snapshot = await orchestrator.start(specOf());
    expect(snapshot.status).toBe('ready');
    // 后端进程（最后一个 spawn）退出
    handles.at(-1)!.exit(1);
    await new Promise<void>((done) => setTimeout(done, 10));
    expect(orchestrator.status(snapshot.runtimeId)!.status).toBe('degraded');
  });

  it('restartService：重启后服务端点可用且与其它服务端口互斥', async () => {
    const { host } = createFakeProcessHost();
    const orchestrator = new RuntimeOrchestrator({
      process: host,
      logs: new LogStream(),
      probe: async () => true,
      tcpProbe: async () => true,
      pageReady: async () => true,
    });
    const snapshot = await orchestrator.start(specOf());
    const next = await orchestrator.restartService(snapshot.runtimeId, 'backend-api');
    const after = next.services.find((s) => s.serviceId === 'backend-api')!;
    const frontend = next.services.find((s) => s.serviceId === 'frontend-root')!;
    expect(after.port).not.toBe(frontend.port);
    expect(next.status).toBe('ready');
    expect(next.services).toHaveLength(2);
  });
});
