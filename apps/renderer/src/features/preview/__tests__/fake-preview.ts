import {
  DEFAULT_MOCK_SETTINGS,
  ok,
  type DataSourceKind,
  type HttpMethodName,
  type LogStreamSource,
  type MockSettings,
  type PreviewLogLevel,
  type PreviewMode,
  type ProjectProfile,
  type ResolvedResponse,
  type StreamedLogLine,
} from '@ec/preview';

import type {
  ApiRequestLog,
  DeviceChannel,
  ManagedProcess,
  PreviewApi,
  PreviewState,
} from '../preview-api';

/**
 * 内存假预览端口：不碰网络 / 文件 / 进程，仅驱动渲染层测试。
 * 关键行为（便于断言）：
 * - 切到 linked 模式端口顺延并给出 notice（端口 4173 被占用，已顺延到 4174）
 * - refresh 返回固定耗时 120ms
 * - requests() 返回 mock 来源的请求（含一条失败项用于高亮断言）
 * - deviceQr 只给内网 http 地址，绝不出现 https 云链接
 */
export interface FakePreviewOptions {
  devices?: readonly DeviceChannel[] | undefined;
  /** 切到该模式时端口顺延；默认 linked */
  shiftMode?: PreviewMode | undefined;
}

export interface FakePreviewApi extends PreviewApi {
  /** 读取内部状态，便于测试直接断言 */
  readonly internal: {
    mode: PreviewMode;
    running: boolean;
    lanEnabled: boolean;
    shifted: boolean;
  };
}

const DEFAULT_DEVICES: readonly DeviceChannel[] = [
  {
    id: 'mobile-1',
    kind: 'mobile',
    label: 'Android 模拟器',
    available: true,
    toolchain: 'adb',
    guide: null,
    selected: true,
  },
  {
    id: 'harmony-1',
    kind: 'harmony',
    label: '鸿蒙设备',
    available: false,
    toolchain: null,
    guide: '未检测到 hdc 工具链，请安装 DevEco Studio 并将 hdc 加入 PATH 后重试。',
    selected: false,
  },
  {
    id: 'desktop-1',
    kind: 'desktop',
    label: '桌面端',
    available: true,
    toolchain: 'electron',
    guide: null,
    selected: false,
  },
];

export function createFakePreviewApi(options?: FakePreviewOptions): FakePreviewApi {
  const shiftMode = options?.shiftMode ?? 'linked';
  const devices = options?.devices ?? DEFAULT_DEVICES;

  const internal = {
    mode: 'static' as PreviewMode,
    running: false,
    lanEnabled: false,
    shifted: false,
  };
  let port = 4173;
  let notice: string | null = null;
  let dataSource: DataSourceKind | null = 'mock';
  let requests: ApiRequestLog[] = [
    {
      id: 'req-1',
      at: 1000,
      method: 'GET',
      url: '/health',
      status: 200,
      durationMs: 12,
      source: 'mock',
      requestBody: null,
      responseBody: '{"status":"ok"}',
      errorMessage: null,
    },
    {
      id: 'req-2',
      at: 1200,
      method: 'POST',
      url: '/login',
      status: 500,
      durationMs: 34,
      source: 'mock',
      requestBody: '{"username":"a","password":"b"}',
      responseBody: '{"error":"boom"}',
      errorMessage: 'Mock 返回错误状态 500',
    },
  ];
  const logs: StreamedLogLine[] = [
    {
      id: 'log-1',
      source: 'install',
      level: 'info',
      text: '依赖安装完成',
      at: 1,
      stream: 'stdout',
    },
    {
      id: 'log-2',
      source: 'run',
      level: 'warn',
      text: '端口占用，尝试顺延',
      at: 2,
      stream: 'stdout',
    },
    {
      id: 'log-3',
      source: 'run',
      level: 'error',
      text: '启动失败 fatal error',
      at: 3,
      stream: 'stderr',
    },
  ];
  let backendRunning = false;
  let process: ManagedProcess | null = null;

  const state = async (): Promise<PreviewState> => ({
    mode: internal.mode,
    running: internal.running,
    url: internal.running ? `http://localhost:${port}` : null,
    port: internal.running ? port : null,
    dataSource: internal.running ? dataSource : null,
    backendAvailable: backendRunning,
    notice,
  });

  const api: PreviewApi = {
    ready: true,
    state,
    setMode(mode) {
      internal.mode = mode;
    },
    async start(mode) {
      internal.mode = mode;
      internal.running = true;
      internal.shifted = false;
      notice = null;
      if (mode === shiftMode) {
        port = 4174;
        internal.shifted = true;
        notice = '端口 4173 被占用，已顺延到 4174';
      } else {
        port = 4173;
      }
      dataSource = 'mock';
      return ok({ port, url: `http://localhost:${port}`, mode, shifted: internal.shifted, notice });
    },
    async stop() {
      internal.running = false;
      notice = null;
      return ok(null);
    },
    async pages() {
      return [
        { route: '/login', name: '登录页' },
        { route: '/home', name: '首页' },
      ];
    },
    async refresh() {
      return ok({ elapsedMs: 120, reason: '手动刷新' });
    },
    async requests() {
      return requests;
    },
    async replayRequest() {
      const res: ResolvedResponse = {
        status: 200,
        data: { ok: true },
        source: 'mock',
        latencyMs: 8,
        url: '/health',
        method: 'GET',
        errorMessage: null,
      };
      return ok(res);
    },
    async toCurl(input) {
      const found = requests.find((r) => r.id === input.id) ?? null;
      const method: HttpMethodName = found?.method ?? 'GET';
      const url = found?.url ?? '/health';
      return `curl -X ${method} http://localhost:${port}${url} -H "Accept: application/json"`;
    },
    async clearRequests() {
      requests = [];
    },
    async projectProfile() {
      const profile: ProjectProfile = {
        kind: 'node',
        label: 'Node.js 项目',
        installCmd: 'npm install',
        startCmd: 'npm run dev',
        portHint: 3000,
        envHints: ['PORT', 'NODE_ENV'],
        evidence: ['package.json'],
        confidence: 1,
        requiresManualCommand: false,
      };
      return ok(profile);
    },
    async installDependencies() {
      return ok({ command: 'npm install', exitCode: 0 });
    },
    async startBackend() {
      process = {
        id: 'proc-1',
        pid: 1234,
        command: 'npm run dev',
        port: 3000,
        url: 'http://localhost:3000',
        startedAt: 100,
      };
      backendRunning = true;
      return ok(process);
    },
    async stopBackend() {
      backendRunning = false;
      process = null;
      return ok(null);
    },
    async restartBackend() {
      process = {
        id: 'proc-1',
        pid: 1234,
        command: 'npm run dev',
        port: 3000,
        url: 'http://localhost:3000',
        startedAt: 200,
      };
      backendRunning = true;
      return ok(process);
    },
    async backendStatus() {
      return { running: backendRunning, process };
    },
    async logs(filter) {
      let out = logs;
      if (filter?.level !== undefined) out = out.filter((l) => l.level === filter.level);
      if (filter?.source !== undefined) out = out.filter((l) => l.source === filter.source);
      if (filter?.keyword !== undefined && filter.keyword !== '') {
        const kw = filter.keyword.toLowerCase();
        out = out.filter((l) => l.text.toLowerCase().includes(kw));
      }
      return out;
    },
    subscribeLogs() {
      return () => {};
    },
    async devices() {
      return devices;
    },
    async deviceQr() {
      return ok({ url: 'http://192.168.1.20:4173', qrText: 'QR::192.168.1.20:4173' });
    },
    async lanSharingEnabled() {
      return internal.lanEnabled;
    },
    async setLanSharing(enabled) {
      internal.lanEnabled = enabled;
    },
    async mockSettings(): Promise<MockSettings> {
      return DEFAULT_MOCK_SETTINGS;
    },
    async setMockSettings(): Promise<void> {
      return;
    },
  };

  return Object.assign(api, { internal }) as FakePreviewApi;
}

// 便于测试构造日志/请求
export function makeLog(
  input: Partial<StreamedLogLine> & { id: string; source: LogStreamSource; text: string },
): StreamedLogLine {
  const level: PreviewLogLevel = input.level ?? 'info';
  const stream: 'stdout' | 'stderr' = input.stream ?? 'stdout';
  return {
    id: input.id,
    source: input.source,
    level,
    text: input.text,
    at: input.at ?? 0,
    stream,
  };
}
