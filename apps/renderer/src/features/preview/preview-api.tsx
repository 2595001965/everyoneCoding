import { createContext, useContext, type ReactNode } from 'react';

import type {
  DataSourceKind,
  HttpMethodName,
  LogStreamSource,
  MockSettings,
  PreviewLogLevel,
  PreviewMode,
  PreviewResult,
  ProjectProfile,
  ResolvedResponse,
  StreamedLogLine,
  DomSession,
  DomSelection,
  DomMapping,
  DomAttachment,
} from '@ec/preview';

/**
 * 预览特性的端口（与记忆中心 `MemoryApi`、流水线 `PipelineApi` 同一套做法）。
 *
 * 渲染层只认这些接口：真实实现由外壳（Electron 主进程 / Tauri 命令层）注入，
 * 未注入时页面展示初始化引导而不是崩溃。领域层（packages/preview）是纯逻辑 +
 * 端口注入，经 `@ec/preview` 的 browser 入口安全进入渲染层。
 */

/** 当前预览的整体状态（工具栏 / 设备预览据此渲染） */
export interface PreviewState {
  mode: PreviewMode;
  running: boolean;
  url: string | null;
  port: number | null;
  dataSource: DataSourceKind | null;
  backendAvailable: boolean;
  notice: string | null; // 端口顺延等提示
  revision?: number | null;
  runtimeId?: string | null;
  /** V2-D02 显式数据模式：real = 后端不可用如实报错；mock = 用户显式选择的模拟数据 */
  dataMode?: 'real' | 'mock';
  /** V2-D02 运行实例快照（runtimeId 区分；null = 尚无运行实例） */
  runtime?: RuntimeStateSnapshot | null;
}

/** 运行实例快照（与主进程 RuntimeSnapshot 同形状；渲染层不依赖 Node 侧类型） */
export interface RuntimeStateSnapshot {
  runtimeId: string;
  projectId: string;
  cwd: string;
  status: 'preparing' | 'starting' | 'ready' | 'degraded' | 'stopping' | 'stopped' | 'failed';
  services: readonly {
    serviceId: string;
    kind: 'frontend' | 'backend';
    port: number | null;
    baseUrl: string | null;
    healthPath: string | null;
  }[];
  startedAt: number | null;
  updatedAt: number;
}

/** 运行计划建议（识别结果 + 可确认的 RunPlan，V2-D02） */
export interface RunPlanSuggestion {
  plannerVersion: string;
  subProjects: readonly {
    subProjectId: string;
    role: string;
    language: string | null;
    framework: string | null;
    packageManager: string | null;
    entryHints: readonly string[];
    supportLevel: 'supported' | 'partial' | 'unsupported' | 'unknown';
    confidence: number | null;
    evidence: readonly { kind: string; path: string; detail: string | null }[];
    suggestedRunPlan: unknown;
  }[];
  plan: {
    cwd: string;
    services: readonly {
      serviceId: string;
      role: 'install' | 'frontend' | 'backend';
      command: string;
      args: readonly string[];
      portHint: number | null;
    }[];
    startupOrder: readonly string[];
    envVarNames: readonly string[];
  } | null;
  requiresConfirmation: boolean;
  notes: readonly string[];
}

/** 单条被预览 iframe 捕获到的接口请求（供 API 调试器展示） */
export interface ApiRequestLog {
  id: string;
  at: number;
  method: HttpMethodName;
  url: string;
  status: number;
  durationMs: number;
  source: DataSourceKind;
  requestBody: string | null;
  responseBody: string;
  errorMessage: string | null;
}

/** 一个目标端预览通道（手机 / 鸿蒙 / 桌面） */
export interface DeviceChannel {
  id: string;
  kind: 'mobile' | 'harmony' | 'desktop';
  label: string;
  available: boolean;
  toolchain: string | null; // 探测到的工具链命令
  guide: string | null; // 缺失时的中文安装引导
  selected: boolean;
}

/**
 * 托管后端子进程（领域层 `ManagedProcess` 经 browser 入口未直接导出，
 * 这里保持相同形状，渲染层只依赖此端口契约）。
 */
export interface ManagedProcess {
  id: string;
  pid: number | null;
  command: string;
  port: number;
  url: string;
  startedAt: number;
}

/** 预览特性端口 */
export interface PreviewApi {
  readonly ready: boolean;
  readonly reason?: string | undefined;
  inspection?: {
    session(parentOrigin: string): Promise<DomSession>;
    resolve(session: DomSession, selection: DomSelection): Promise<DomMapping>;
    save(input: DomNoteInput, attach: boolean): Promise<DomAttachment>;
    notes(): Promise<readonly DomAttachment[]>;
    locate(session: DomSession, selection: DomSelection): Promise<DomMapping>;
  };

  /* ------------------------------ 模式与运行 ------------------------------ */
  state(): Promise<PreviewState>;
  setMode(mode: PreviewMode): void;
  start(mode: PreviewMode): Promise<
    PreviewResult<{
      port: number;
      url: string;
      mode: PreviewMode;
      shifted: boolean;
      notice: string | null;
    }>
  >;
  stop(): Promise<PreviewResult<null>>;
  pages(): Promise<readonly { route: string; name: string }[]>;
  /** 热更新：变更后刷新，返回耗时（验收要求 ≤3s） */
  refresh(reason: string): Promise<PreviewResult<{ elapsedMs: number | null; reason: string }>>;

  /* ------------------------------ API 调试 ------------------------------ */
  requests(): Promise<readonly ApiRequestLog[]>;
  replayRequest(input: {
    id: string;
    url?: string | undefined;
    method?: HttpMethodName | undefined;
    body?: unknown;
  }): Promise<PreviewResult<ResolvedResponse>>;
  toCurl(input: { id: string }): Promise<string>;
  clearRequests(): Promise<void>;

  /* ------------------------------ 后端托管 ------------------------------ */
  projectProfile(): Promise<PreviewResult<ProjectProfile>>;
  installDependencies(): Promise<PreviewResult<{ command: string; exitCode: number | null }>>;
  startBackend(): Promise<PreviewResult<ManagedProcess>>;
  stopBackend(): Promise<PreviewResult<null>>;
  restartBackend(): Promise<PreviewResult<ManagedProcess>>;
  backendStatus(): Promise<{ running: boolean; process: ManagedProcess | null }>;
  logs(filter?: {
    level?: PreviewLogLevel | undefined;
    keyword?: string | undefined;
    source?: LogStreamSource | undefined;
  }): Promise<readonly StreamedLogLine[]>;
  subscribeLogs(listener: (line: StreamedLogLine) => void): () => void;

  /* --------------------- V2-D02 运行计划 / 实例 / 数据模式 --------------------- */
  /** 识别运行计划建议（只读扫描，不执行任何脚本；执行前必须 confirmRunPlan） */
  runPlan(): Promise<RunPlanSuggestion>;
  /** 确认运行计划（V2-SRC-05 信任确认；确认内容持久化，之后 startRun 不再二次询问） */
  confirmRunPlan(plans: readonly unknown[], plannerVersion?: string): Promise<unknown>;
  /** 按已确认计划启动运行实例（安装 → 前端/后端；端口/代理由主进程编排） */
  startRun(): Promise<PreviewResult<RuntimeStateSnapshot>>;
  /** 运行实例状态（不传 runtimeId = 最近一次） */
  runStatus(runtimeId?: string | undefined): Promise<RuntimeStateSnapshot | null>;
  /** 精准停止：只停 runtimeId 对应实例自己 spawn 的服务 */
  stopRuntime(runtimeId?: string | undefined): Promise<PreviewResult<RuntimeStateSnapshot | null>>;
  /** 重启运行实例中的单个服务 */
  restartService(
    runtimeId: string,
    serviceId: string,
  ): Promise<PreviewResult<RuntimeStateSnapshot>>;
  /** 生成/刷新项目缩略图（真实预览页截图） */
  captureThumbnail(): Promise<PreviewResult<string>>;

  /* ------------------------------ 多端预览 ------------------------------ */
  devices(): Promise<readonly DeviceChannel[]>;
  deviceQr(channelId: string): Promise<PreviewResult<{ url: string; qrText: string }>>;
  lanSharingEnabled(): Promise<boolean>;
  setLanSharing(enabled: boolean): Promise<void>;

  /* ------------------------------ Mock 设置 ------------------------------ */
  mockSettings(): Promise<MockSettings>;
  setMockSettings(patch: Partial<MockSettings>): Promise<void>;
  /** 当前显式数据模式（real 为默认；mock 必须用户显式切换，V2 FR-PRV-02） */
  dataMode(): Promise<'real' | 'mock'>;
  setDataMode(mode: 'real' | 'mock'): Promise<void>;
}

export interface DomNoteInput {
  session: DomSession;
  selection: DomSelection;
  note: string;
  placement: DomAttachment['placement'];
  targetPage: string;
  sharedConfirmed: boolean;
}

const PreviewContext = createContext<PreviewApi | null>(null);

export interface PreviewApiProviderProps {
  api: PreviewApi | null;
  children: ReactNode;
}

/** 注入预览端口；api 为 null 时子组件展示初始化引导 */
export function PreviewApiProvider({ api, children }: PreviewApiProviderProps): JSX.Element {
  return <PreviewContext.Provider value={api}>{children}</PreviewContext.Provider>;
}

/** 取实现；未注入返回 null（页面据此展示初始化引导而不是崩溃） */
export function usePreviewApiOptional(): PreviewApi | null {
  return useContext(PreviewContext);
}

export function usePreviewApi(): PreviewApi {
  const api = usePreviewApiOptional();
  if (!api) throw new Error('预览未初始化：请先注入 PreviewApi');
  return api;
}

/** 从全局读取外壳注入的实现（外壳把真实端口挂到 window.__EC_PREVIEW__） */
export function readInjectedPreviewApi(): PreviewApi | null {
  const injected = (globalThis as unknown as { __EC_PREVIEW__?: unknown }).__EC_PREVIEW__;
  if (typeof injected !== 'object' || injected === null) return null;
  const candidate = injected as Partial<PreviewApi>;
  if (typeof candidate.state !== 'function' || typeof candidate.start !== 'function') return null;
  // 指纹校验通过后按契约收窄（ready / reason 等属性可能缺失，由调用方按 optional 处理）
  return candidate as unknown as PreviewApi;
}
