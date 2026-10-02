/**
 * V2-D02 运行实例编排：一个 runtimeId 对应一次受管运行（安装 → 前端/后端多服务）。
 *
 * 复用既有进程系统而不是重写：
 * - 进程能力走 `ProcessHostPort`（与 BackendRunner 同一端口契约，生产由外壳受控进程提供）；
 * - 每个服务一个 `BackendRunner` 实例（端口分配、env 注入、日志、stop/restart 全部复用）；
 * - 依赖安装走 `DependencyInstaller`（source=install 的日志语义复用）。
 *
 * 本模块新增的三件事：
 * 1. **多服务端口编排**：spawn 前用真实探测给每个服务分配互不相同的端口；
 *    前端服务在命令行追加 `--port`（配合计划中的 `--strictPort`，端口被抢时可见失败，
 *    绝不静默漂移到别的端口），后端服务注入 PORT 环境变量；
 * 2. **真实就绪判定**：后端 = 端口可连；前端 = 端口可连 + 页面可加载（HTTP GET < 500），
 *    不是只看到"启动成功"字样（V2-SRC-06）；
 * 3. **精准停止**：按 runtimeId 只停止该实例自己 spawn 的服务，不碰其它实例/工程。
 */

import type { RuntimeStatus } from '@ec/core';

import { DependencyInstaller } from './dependency-installer';
import type { LogStream } from './log-stream';
import type { PortProbe } from '../port-manager';
import { BackendRunner, type ProcessHostPort } from './runner';

export type RuntimeServiceKind = 'frontend' | 'backend';

/** 一个受管服务的执行规格（来自确认后的 RunPlan，cwd 已解析为绝对路径） */
export interface RuntimeServiceSpec {
  serviceId: string;
  kind: RuntimeServiceKind;
  /** 完整启动命令（不含端口参数） */
  command: string;
  /** 附加参数（计划确认内容；端口参数由编排器追加） */
  args: readonly string[];
  /** 绝对工作目录 */
  cwd: string;
  env: Record<string, string>;
}

/** 端口可连性探测（生产由域层注入 node:net 实现；本包保持不引用 node:*） */
export type TcpProbe = (port: number) => Promise<boolean>;

/** 一个运行实例内全部服务的规格（按启动顺序） */
export interface RuntimeSpec {
  runtimeId: string;
  projectId: string;
  cwd: string;
  /** 安装步骤（顺序执行，全部成功才启动服务） */
  installs: readonly { serviceId: string; command: string; cwd: string }[];
  /** 前端/后端服务（按启动顺序） */
  services: readonly RuntimeServiceSpec[];
}

/** 服务端点快照（与 @ec/core v2 RuntimeServiceEndpoint 形状一致） */
export interface RuntimeEndpointSnapshot {
  serviceId: string;
  kind: RuntimeServiceKind;
  port: number | null;
  baseUrl: string | null;
  healthPath: string | null;
}

/** 运行实例快照（与 @ec/core v2 RuntimeInstance 形状一致，revision 由域层补） */
export interface RuntimeSnapshot {
  runtimeId: string;
  projectId: string;
  cwd: string;
  status: RuntimeStatus;
  services: RuntimeEndpointSnapshot[];
  startedAt: number | null;
  updatedAt: number;
}

export type RuntimeEvent =
  | { type: 'status'; runtimeId: string; status: RuntimeStatus; detail?: string }
  | { type: 'service-ready'; runtimeId: string; serviceId: string; port: number }
  | { type: 'service-exited'; runtimeId: string; serviceId: string; detail: string };

export interface RuntimeOrchestratorOptions {
  process: ProcessHostPort;
  logs: LogStream;
  /** 端口可用性探测（真实 listen 探测；测试可注入） */
  probe?: PortProbe;
  /** 端口可连性探测（后端就绪判定；测试可注入） */
  tcpProbe?: TcpProbe;
  /** 页面可加载探测（前端就绪的第二条件；测试可注入） */
  pageReady?: (port: number) => Promise<boolean>;
  newId?: () => string;
  clock?: () => number;
  /** portHint 为 null 时的起算端口 */
  startPort?: number;
  /** 单服务就绪等待上限（默认 30s：Vite 冷启动比纯后端慢） */
  readyTimeoutMs?: number;
}

interface ServiceRuntime {
  spec: RuntimeServiceSpec;
  port: number;
  command: string;
  runner: BackendRunner;
  endpoint: RuntimeEndpointSnapshot;
}

interface Runtime {
  spec: RuntimeSpec;
  status: RuntimeStatus;
  startedAt: number | null;
  updatedAt: number;
  revision: number;
  services: Map<string, ServiceRuntime>;
  /** 事件退订器，stop 时统一退订 */
  offEvents: Array<() => void>;
  /** 已结束（failed/stopped）后不可再精准停止之外的复用 */
  settled: boolean;
}

/** 把参数数组拼成 shell 命令段：含空白的参数加双引号 */
export function joinCommand(command: string, args: readonly string[]): string {
  const quote = (value: string): string =>
    /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  return [command, ...args.map(quote)].filter((p) => p.length > 0).join(' ');
}

export class RuntimeOrchestrator {
  private readonly process: ProcessHostPort;
  private readonly logs: LogStream;
  private readonly probe: PortProbe;
  private readonly tcpProbe: TcpProbe;
  private readonly pageReady: (port: number) => Promise<boolean>;
  private readonly newId: () => string;
  private readonly clock: () => number;
  private readonly startPort: number;
  private readonly readyTimeoutMs: number;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(opts: RuntimeOrchestratorOptions) {
    this.process = opts.process;
    this.logs = opts.logs;
    this.probe = opts.probe ?? (async () => true);
    this.tcpProbe = opts.tcpProbe ?? (async () => true);
    this.pageReady = opts.pageReady ?? (async () => true);
    this.newId = opts.newId ?? (() => `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.clock = opts.clock ?? (() => Date.now());
    this.startPort = opts.startPort ?? 5180;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** 全部实例快照（最近启动的在前） */
  list(): RuntimeSnapshot[] {
    return [...this.runtimes.values()]
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .map((rt) => this.snapshotOf(rt));
  }

  status(runtimeId: string | null): RuntimeSnapshot | null {
    if (runtimeId === null) return this.list()[0] ?? null;
    const rt = this.runtimes.get(runtimeId);
    return rt === undefined ? null : this.snapshotOf(rt);
  }

  /**
   * 启动一次运行：安装步骤顺序执行（失败即 failed），服务按顺序 spawn 并等待真实就绪。
   * 任何服务启动失败：先精准停掉已启动的服务，实例标记 failed（可诊断，不留半开状态）。
   */
  async start(spec: RuntimeSpec): Promise<RuntimeSnapshot> {
    const runtimeId = spec.runtimeId.length > 0 ? spec.runtimeId : this.newId();
    if (this.runtimes.has(runtimeId)) {
      throw new Error(`运行实例已存在：${runtimeId}`);
    }
    const rt: Runtime = {
      spec: { ...spec, runtimeId },
      status: 'preparing',
      startedAt: this.clock(),
      updatedAt: this.clock(),
      revision: 1,
      services: new Map(),
      offEvents: [],
      settled: false,
    };
    this.runtimes.set(runtimeId, rt);
    const takenByRuntime = new Set<number>();

    try {
      // 1) 安装步骤：顺序执行，输出进 install 日志源
      if (spec.installs.length > 0) {
        this.setStatus(rt, 'preparing', `执行 ${spec.installs.length} 个安装步骤`);
        const installer = new DependencyInstaller({ process: this.process, logs: this.logs });
        for (const step of spec.installs) {
          this.logs.info(`[${step.serviceId}] 安装依赖：${step.command}`);
          const result = await installer.run(
            {
              kind: 'node',
              label: step.serviceId,
              installCmd: step.command,
              startCmd: null,
              portHint: null,
              envHints: [],
              evidence: [],
              confidence: 1,
              requiresManualCommand: false,
            },
            step.cwd,
          );
          if (!result.ok) {
            throw new Error(
              `安装步骤失败（${step.serviceId}）：${result.error?.message ?? '未知错误'}`,
            );
          }
        }
      }

      // 2) 逐服务：先分配端口（真实探测，实例内互斥），再 spawn 并等待真实就绪
      this.setStatus(rt, 'starting');
      for (const serviceSpec of spec.services) {
        const port = await this.allocatePort(serviceSpec, takenByRuntime);
        const service = await this.startService(rt, serviceSpec, port);
        rt.services.set(serviceSpec.serviceId, service);
      }

      this.setStatus(rt, 'ready', `${rt.services.size} 个服务已就绪`);
      return this.snapshotOf(rt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.stopServicesOf(rt).catch(() => undefined);
      this.setStatus(rt, 'failed', detail);
      this.logs.error(`运行实例启动失败（${runtimeId}）：${detail}`);
      throw error instanceof Error ? error : new Error(detail);
    }
  }

  /** 精准停止：只停 runtimeId 对应实例自己 spawn 的服务。 */
  async stop(runtimeId: string): Promise<void> {
    const rt = this.runtimes.get(runtimeId);
    if (rt === undefined || rt.settled) return;
    this.setStatus(rt, 'stopping');
    await this.stopServicesOf(rt);
    this.setStatus(rt, 'stopped');
  }

  /** 重启单个服务：重新分配端口（前端命令随之重建），失败则实例降级。 */
  async restartService(runtimeId: string, serviceId: string): Promise<RuntimeSnapshot> {
    const rt = this.runtimes.get(runtimeId);
    if (rt === undefined) throw new Error(`运行实例不存在：${runtimeId}`);
    const existing = rt.services.get(serviceId);
    if (existing === undefined) throw new Error(`服务不在该运行实例中：${serviceId}`);

    await existing.runner.stop().catch(() => undefined);
    rt.services.delete(serviceId);

    const takenByRuntime = new Set<number>();
    // 实例内其它服务已占用的端口不参与分配
    for (const svc of rt.services.values()) takenByRuntime.add(svc.port);
    try {
      const port = await this.allocatePort(existing.spec, takenByRuntime);
      const service = await this.startService(rt, existing.spec, port);
      rt.services.set(serviceId, service);
      rt.revision += 1;
      rt.updatedAt = this.clock();
      if (rt.status === 'degraded') this.setStatus(rt, 'ready', `${serviceId} 已恢复`);
      return this.snapshotOf(rt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.setStatus(rt, 'degraded', `${serviceId} 重启失败：${detail}`);
      throw error instanceof Error ? error : new Error(detail);
    }
  }

  /** 精准停止全部实例（域 dispose 用）。 */
  async dispose(): Promise<void> {
    for (const [runtimeId] of this.runtimes) {
      await this.stop(runtimeId).catch(() => undefined);
    }
    this.runtimes.clear();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async allocatePort(
    spec: RuntimeServiceSpec,
    takenByRuntime: Set<number>,
  ): Promise<number> {
    const start = this.startPort;
    for (let attempt = 0; attempt < 50; attempt++) {
      const port = start + attempt;
      if (takenByRuntime.has(port)) continue;
      if (await this.probe(port)) {
        takenByRuntime.add(port);
        return port;
      }
    }
    throw new Error(`无法为服务 ${spec.serviceId} 分配可用端口`);
  }

  private async startService(
    rt: Runtime,
    spec: RuntimeServiceSpec,
    port: number,
  ): Promise<ServiceRuntime> {
    // 前端在命令行追加 --port：配合计划里的 --strictPort，被抢占时可见失败而非静默漂移
    const args =
      spec.kind === 'frontend'
        ? [...spec.args, '--port', String(port), '--host', '127.0.0.1']
        : [...spec.args];
    const command = joinCommand(spec.command, args);
    const runner = new BackendRunner({
      process: this.process,
      logs: this.logs,
      startPort: port,
      probe: (candidate) => candidate === port,
      clock: this.clock,
      label: spec.serviceId,
      ready: (readyPort, exited) => this.waitReady(spec, readyPort, exited),
    });
    const off = runner.onEvent((event) => {
      if (event.type === 'exited') {
        const service = rt.services.get(spec.serviceId);
        if (service !== undefined && !rt.settled && rt.status === 'ready') {
          // ready 之后服务退出：降级并如实标注，而不是继续声称就绪
          this.setStatus(
            rt,
            'degraded',
            `${spec.serviceId} 已退出（${event.detail ?? '未知原因'}）`,
          );
        }
        this.emit({
          type: 'service-exited',
          runtimeId: rt.spec.runtimeId,
          serviceId: spec.serviceId,
          detail: event.detail ?? '',
        });
      }
    });
    rt.offEvents.push(off);

    const result = await runner.start(
      {
        kind: 'node',
        label: spec.serviceId,
        installCmd: null,
        startCmd: command,
        portHint: port,
        envHints: [],
        evidence: [],
        confidence: 1,
        requiresManualCommand: false,
      },
      spec.cwd,
      spec.env,
    );
    if (!result.ok || result.data === null) {
      throw new Error(`服务 ${spec.serviceId} 启动失败：${result.error?.message ?? '未知错误'}`);
    }
    const endpoint: RuntimeEndpointSnapshot = {
      serviceId: spec.serviceId,
      kind: spec.kind,
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      healthPath: spec.kind === 'frontend' ? '/' : null,
    };
    this.emit({
      type: 'service-ready',
      runtimeId: rt.spec.runtimeId,
      serviceId: spec.serviceId,
      port,
    });
    return { spec, port, command, runner, endpoint };
  }

  /** 就绪判定：后端 = 端口可连；前端 = 端口可连 + 页面可加载（V2-SRC-06）。 */
  private async waitReady(
    spec: RuntimeServiceSpec,
    port: number,
    exited: Promise<unknown>,
  ): Promise<void> {
    let ended = false;
    void exited.then(() => {
      ended = true;
    });
    const deadline = this.clock() + this.readyTimeoutMs;
    let listening = false;
    while (!ended && this.clock() < deadline) {
      listening = await this.tcpProbe(port);
      if (listening) break;
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    if (ended) throw new Error('进程在就绪前退出，请查看启动日志');
    if (!listening) throw new Error(`等待端口 ${port} 监听超时，请检查启动命令与端口配置`);

    if (spec.kind === 'backend') return;
    const pageDeadline = this.clock() + Math.min(this.readyTimeoutMs, 10_000);
    while (!ended && this.clock() < pageDeadline) {
      if (await this.pageReady(port)) return;
      await new Promise<void>((done) => setTimeout(done, 150));
    }
    if (ended) throw new Error('进程在页面就绪前退出，请查看启动日志');
    throw new Error(`端口 ${port} 已监听但页面未就绪（HTTP 探测失败），请检查开发服务器输出`);
  }

  private async stopServicesOf(rt: Runtime): Promise<void> {
    rt.settled = true;
    for (const off of rt.offEvents) off();
    rt.offEvents = [];
    const services = [...rt.services.values()];
    rt.services.clear();
    for (const service of services) {
      await service.runner.stop().catch(() => undefined);
    }
  }

  private setStatus(rt: Runtime, status: RuntimeStatus, detail?: string): void {
    rt.status = status;
    rt.updatedAt = this.clock();
    rt.revision += 1;
    this.emit({
      type: 'status',
      runtimeId: rt.spec.runtimeId,
      status,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  private snapshotOf(rt: Runtime): RuntimeSnapshot {
    return {
      runtimeId: rt.spec.runtimeId,
      projectId: rt.spec.projectId,
      cwd: rt.spec.cwd,
      status: rt.status,
      services: [...rt.services.values()].map((svc) => ({ ...svc.endpoint })),
      startedAt: rt.startedAt,
      updatedAt: rt.updatedAt,
    };
  }
}
