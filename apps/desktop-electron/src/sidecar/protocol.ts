/**
 * Tauri 侧车（sidecar）协议：帧定义与纯编解码。
 *
 * ## 为什么是 NDJSON（一行一个 JSON 对象）
 *
 * 宿主（Rust）与侧车（Node）之间只有一对管道（stdin/stdout）。选 NDJSON 的原因：
 * - **可流式解析**：不需要预先知道长度，读到 `\n` 即一帧，Rust 侧一个 `BufReader::lines()`
 *   就够，不必引第三方 codec；
 * - **可观测**：出问题时把管道里的原始行打出来就是完整现场，不像二进制帧需要工具解码；
 * - **与域契约同构**：载荷本身就是 JSON（`DomainRpcResponse` 等可结构化克隆值），
 *   不额外引入第二套编码。
 *
 * ## 帧类型总览（`t` 是判别字段）
 *
 * ```
 * 侧车 → 宿主   hello    握手：我支持哪些协议版本
 * 宿主 → 侧车   welcome  协商结果 + 宿主能提供的能力（DPAPI 是否可用等）
 * 侧车 → 宿主   ready    运行时装配完毕：各域可用性 + AI 可用性
 * 宿主 → 侧车   req      一次调用（id 关联）
 * 侧车 → 宿主   res      调用应答（id 关联）
 * 侧车 → 宿主   evt      单向事件（域进度 / AI 流式分片 / 日志）
 * 侧车 → 宿主   host     侧车请求宿主能力（DPAPI 加解密 / 打开外链 / 剪贴板）
 * 宿主 → 侧车   hostres  宿主能力应答
 * 侧车 → 宿主   bye      正常终止（携带原因，便于宿主区分「计划内退出」与「崩溃」）
 * ```
 *
 * ## 升级兼容
 *
 * `PROTOCOL_VERSION` 是**宿主与侧车必须一致**的主版本。侧车在 `hello` 里报自己支持的
 * 版本区间，宿主在 `welcome` 里回一个它选定的版本；不一致时侧车回 `bye` 并
 * **拒绝服务**（而不是"尽力而为"地跑——半懂的协议比跑不起来更危险，
 * 会把「方法缺失」表现成随机的业务错误）。
 *
 * 新增能力一律**加字段**，不改已有字段语义，旧侧车/新宿主组合会自然降级。
 */

/** 当前协议主版本。宿主与侧车必须一致，否则拒绝启动。 */
export const PROTOCOL_VERSION = 1;

/** 侧车进程名标识（诊断用，便于在任务管理器里认出孤儿进程） */
export const SIDECAR_RUNTIME_ID = 'everyone-coding-sidecar';

/** 宿主能力名（侧车 → 宿主） */
export const HOST_CAPABILITIES = {
  /** 查询 DPAPI 是否可用（装配期一次，之后按常量使用） */
  secureAvailable: 'secure.available',
  /** 用宿主侧 DPAPI 加密（用户上下文） */
  secureEncrypt: 'secure.encrypt',
  /** 用宿主侧 DPAPI 解密 */
  secureDecrypt: 'secure.decrypt',
  /** 系统浏览器打开链接（auth 域 OAuth 主通道） */
  shellOpenExternal: 'shell.openExternal',
  /** 写系统剪贴板（auth 域展示授权码；同步签名，允许 fire-and-forget） */
  clipboardWriteText: 'clipboard.writeText',
} as const;

/** 侧车事件类型（侧车 → 宿主，单向） */
export const SIDECAR_EVENTS = {
  /** 域事件（载荷为 `DomainEvent`；宿主按 requestId/domain 忠实转发） */
  domainEvent: 'domain.event',
  /** AI 流式分片（载荷为 `{ requestId, event }`） */
  aiStream: 'ai.stream',
  /** 侧车自身日志（走 stderr 之外的正式通道，便于宿主归档诊断） */
  log: 'log',
} as const;

/** 侧车可处理的请求 op（宿主 → 侧车） */
export const SIDECAR_OPS = {
  ping: 'ping',
  domainDescribe: 'domain.describe',
  domainInvoke: 'domain.invoke',
  aiInvoke: 'ai.invoke',
  aiStreamStart: 'ai.stream.start',
  aiAbort: 'ai.abort',
  shutdown: 'shutdown',
} as const;

export interface WireError {
  code: string;
  message: string;
}

/** 单个域的可用性（`ready` 帧携带，与 `DomainDescriptor` 同形） */
export interface WireDomainDescriptor {
  kind: string;
  available: boolean;
  reason?: string;
}

export interface SidecarConfig {
  dataDir: string;
  cacheDir: string;
  secureDir: string;
  workspaceRoot: string;
  accountBaseUrl?: string;
  userId: string;
}

/* ------------------------------- 帧定义 ------------------------------- */

export interface HelloFrame {
  t: 'hello';
  protocol: number;
  /** 侧车支持的最小协议版本（当前等于 protocol，为将来的向下兼容留位） */
  minProtocol: number;
  runtime: string;
  pid: number;
  node: string;
  /** 侧车侧已就绪的能力声明（宿主据此决定是否相信其 AI 装配结果） */
  features: string[];
}

export interface WelcomeFrame {
  t: 'welcome';
  /** 宿主选定的协议版本；与侧车 `protocol` 不一致时侧车必须拒绝服务 */
  protocol: number;
  /** 宿主侧 DPAPI 是否可用（决定 auth 域是否装配、AI Key 能否安全落盘） */
  secureStore: boolean;
  config: SidecarConfig;
}

export interface ReadyFrame {
  t: 'ready';
  protocol: number;
  domains: WireDomainDescriptor[];
  /** memory / pipeline 之外还存在同步口的域（宿主据此决定是否暴露同步通道） */
  syncDomains: string[];
  ai: { available: boolean; reason?: string };
}

export interface RequestFrame {
  t: 'req';
  id: string;
  op: string;
  payload: unknown;
}

export interface ResponseFrame {
  t: 'res';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: WireError;
}

export interface EventFrame {
  t: 'evt';
  op: string;
  payload: unknown;
}

export interface HostCallFrame {
  t: 'host';
  id: string;
  capability: string;
  payload: unknown;
}

export interface HostResultFrame {
  t: 'hostres';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: WireError;
}

export interface ByeFrame {
  t: 'bye';
  reason: string;
  /** 进程退出码建议（0 = 计划内，非 0 = 异常/拒绝服务） */
  code: number;
}

export type SidecarToHostFrame =
  HelloFrame | ReadyFrame | ResponseFrame | EventFrame | HostCallFrame | ByeFrame;

export type HostToSidecarFrame = WelcomeFrame | RequestFrame | HostResultFrame;

/* ------------------------------- 编解码 ------------------------------- */

/** 序列化一帧（不含换行；调用方负责追加 `\n`）。 */
export function encodeFrame(frame: SidecarToHostFrame | HostToSidecarFrame): string {
  return JSON.stringify(frame);
}

/**
 * 解析一行文本为帧。
 *
 * **返回 `null` 而不是抛错**：管道里出现半截 JSON（宿主在写到一半时被杀）是
 * 可预期的情形，此时应当跳过这一行继续服务，而不是让整个侧车崩掉。
 * 空行同理忽略。
 */
export function decodeFrame(line: string): SidecarToHostFrame | HostToSidecarFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return typeof record['t'] === 'string'
      ? (record as unknown as SidecarToHostFrame | HostToSidecarFrame)
      : null;
  } catch {
    return null;
  }
}

/** 判定协议是否兼容：主版本必须相等，且对端版本落在本端支持区间内。 */
export function isProtocolCompatible(hostVersion: number, sidecarVersion: number): boolean {
  return Number.isInteger(hostVersion) && hostVersion === sidecarVersion;
}
