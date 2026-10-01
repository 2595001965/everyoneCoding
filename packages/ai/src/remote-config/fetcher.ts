import { z } from 'zod';
import { mask } from '@ec/core';

import { protocolSchema, httpUrlSchema, isSensitiveHeaderName } from '../domain/provider';
import type { HttpTransport, ProxyConfig } from '../core/http';
import { verifySignature } from './verifier';

/** 拉取超时兜底：远程配置是小文件，15s 足够，避免拖慢启动 */
export const REMOTE_CONFIG_TIMEOUT_MS = 15_000;

/**
 * 远程配置内容（FR-MDL-07）。
 *
 * 直连用户填写的 URL，不经过任何平台服务端（D-02 / D-06）。
 * 配置里**永远不包含 API Key** —— Key 只由用户在本机填写并存密钥环。
 */

export const remoteProviderSchema = z.object({
  name: z.string().trim().min(1).max(64),
  protocol: protocolSchema,
  baseUrl: httpUrlSchema,
  models: z.array(z.string().trim().min(1)).default([]),
  /**
   * 这里刻意不用 `headersSchema`（它遇到凭据头会让整份配置校验失败）：
   * 远程配置里混进一个 Authorization 就让整个团队配置不可用，代价过大。
   * 改为先宽松接收、随后由 {@link stripSensitiveHeaders} 剔除并提示——凭据同样不会落库或外发。
   */
  headers: z.record(z.string().trim().min(1), z.string()).default({}),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
  supportsStream: z.boolean().default(true),
  supportsTools: z.boolean().default(false),
  supportsVision: z.boolean().default(false),
  /** 该 Provider 的默认模型名（用于用途绑定的默认值） */
  defaultModel: z.string().trim().min(1).nullish(),
});

export const remoteConfigPayloadSchema = z.preprocess(
  normalizePayloadAliases,
  z.object({
    /** 版本号：用于"拒绝后不再弹窗"与差异比较（PRD 字段名 `version` 同义） */
    revision: z.string().trim().min(1),
    updatedAt: z.number().int().nullish(),
    note: z.string().max(500).nullish(),
    /** 全局默认模型名（PRD `defaultModelId`）；优先于各 Provider 的 defaultModel */
    defaultModel: z.string().trim().min(1).nullish(),
    /** 功能开关：只读展示，不影响本地行为 */
    featureFlags: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])).nullish(),
    providers: z.array(remoteProviderSchema).default([]),
  }),
);

/**
 * PRD FR-MDL-07 的字段名（`version` / `defaultModelId`）与实现口径（`revision` / `defaultModel`）
 * 两种写法都接受：配置文件是用户自己手写/自建服务产出的，没理由因为字段名差一个词就整份拒收。
 */
function normalizePayloadAliases(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = { ...(input as Record<string, unknown>) };
  if (record['revision'] === undefined && record['version'] !== undefined) {
    record['revision'] = String(record['version']);
  }
  if (record['defaultModel'] === undefined && typeof record['defaultModelId'] === 'string') {
    record['defaultModel'] = record['defaultModelId'];
  }
  return record;
}

/**
 * 远程配置里**不允许**出现凭据类请求头（FR-MDL-07：配置不含 API Key）。
 * 命中即剔除并给出提示——既不让它落进本地库，也不让它随请求发给中转。
 */
const SENSITIVE_HEADER = /(authorization|api[-_]?key|token|secret|cookie|password|credential)/i;

export function stripSensitiveHeaders(payload: RemoteConfigPayload): {
  payload: RemoteConfigPayload;
  warnings: string[];
} {
  const warnings: string[] = [];
  const providers = payload.providers.map((provider) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(provider.headers)) {
      if (SENSITIVE_HEADER.test(name) || isSensitiveHeaderName(name)) {
        warnings.push(`已忽略「${provider.name}」的敏感请求头 ${name}（远程配置不得携带凭据）`);
      } else {
        headers[name] = value;
      }
    }
    return { ...provider, headers };
  });
  return { payload: { ...payload, providers }, warnings };
}

export type RemoteProviderConfig = z.infer<typeof remoteProviderSchema>;
export type RemoteConfigPayload = z.infer<typeof remoteConfigPayloadSchema>;

/** 拉取到的原始文档：正文 + 可选签名 */
export interface RemoteConfigDocument {
  payload: RemoteConfigPayload;
  signature: string | null;
  raw: string;
  /** 可安全落库的缓存正文（已剔除敏感头）；断网回退与差异预览只读它 */
  cacheJson: string;
  /** 解析时的非致命提示（如被剔除的敏感头） */
  warnings: string[];
}

export type RemoteFetchStatus = 'success' | 'unreachable' | 'signature_failed' | 'invalid';

export interface RemoteFetchResult {
  ok: boolean;
  status: RemoteFetchStatus;
  document: RemoteConfigDocument | null;
  latencyMs: number;
  message: string;
}

export const SIGNATURE_HEADERS = ['x-signature', 'x-ec-signature', 'signature'] as const;

/** 从响应头里取签名（base64 或 hex），大小写不敏感 */
export function pickSignature(headers: Record<string, string>): string | null {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const key of SIGNATURE_HEADERS) {
    const value = normalized.get(key.toLowerCase());
    if (value && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * 解析远程配置正文；签名可能在响应头，也可能在信封的 signature 字段。
 *
 * 支持三种形态：
 * 1. 裸正文（签名在响应头 `x-signature`，签的是整个响应体）；
 * 2. 信封 `{ "payload": "<JSON 文本>", "signature": "..." }`（签的是 payload 字符串本身，推荐）；
 * 3. 信封 `{ "payload": { ... }, "signature": "..." }`（签的是 `JSON.stringify(payload)` 紧凑形式）。
 */
export function parseRemoteConfig(
  raw: string,
  headers: Record<string, string> = {},
): RemoteConfigDocument {
  const parsed: unknown = JSON.parse(raw);
  const record = (parsed ?? {}) as Record<string, unknown>;
  const signature =
    pickSignature(headers) ??
    (typeof record['signature'] === 'string' ? (record['signature'] as string) : null);

  const inner = record['payload'];
  const body =
    typeof inner === 'string'
      ? (JSON.parse(inner) as unknown)
      : inner && typeof inner === 'object'
        ? inner
        : record;
  const stripped = stripSensitiveHeaders(remoteConfigPayloadSchema.parse(body));
  return {
    payload: stripped.payload,
    signature,
    raw,
    cacheJson: JSON.stringify(stripped.payload),
    warnings: stripped.warnings,
  };
}

/**
 * 找出「签名覆盖的原文」与签名本身。
 * 响应头签名优先（覆盖整个响应体）；否则看信封（覆盖 payload）。
 */
export function signedPartOf(
  raw: string,
  headers: Record<string, string>,
): { signed: string; signature: string | null } {
  const headerSignature = pickSignature(headers);
  if (headerSignature) return { signed: raw, signature: headerSignature };
  try {
    const record = JSON.parse(raw) as Record<string, unknown> | null;
    if (record && typeof record === 'object' && typeof record['signature'] === 'string') {
      const inner = record['payload'];
      if (typeof inner === 'string') return { signed: inner, signature: record['signature'] };
      if (inner && typeof inner === 'object') {
        return { signed: JSON.stringify(inner), signature: record['signature'] };
      }
    }
  } catch {
    // 非 JSON：交给后续解析报 invalid
  }
  return { signed: raw, signature: null };
}

/* ------------------------------ 拉取 ------------------------------ */

export interface FetchSource {
  url: string;
  /** Ed25519 公钥；为空则跳过签名校验 */
  publicKey?: string | null;
}

export interface FetchOptions {
  timeoutMs?: number;
  proxy?: ProxyConfig | undefined;
  signal?: AbortSignal;
}

/**
 * 拉取远程配置。
 *
 * 关键约束：
 * - 失败一律返回结果对象而不是抛错（拉取失败要用本地缓存，且**不阻塞启动**）
 * - 签名校验失败的优先级高于内容解析：配置不可信时绝不应用
 */
export async function fetchRemoteConfig(
  source: FetchSource,
  transport: HttpTransport,
  options: FetchOptions = {},
): Promise<RemoteFetchResult> {
  const started = Date.now();
  let raw: string;
  let headers: Record<string, string>;

  try {
    const response = await transport.request({
      url: source.url,
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: options.timeoutMs ?? REMOTE_CONFIG_TIMEOUT_MS,
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    headers = response.headers;
    if (response.status >= 400) {
      return {
        ok: false,
        status: 'unreachable',
        document: null,
        latencyMs: Date.now() - started,
        message: `远程配置返回 ${response.status}，已继续使用本地缓存`,
      };
    }
    raw = await response.text();
  } catch (error) {
    return {
      ok: false,
      status: 'unreachable',
      document: null,
      latencyMs: Date.now() - started,
      // 错误文本可能带 URL 查询串里的 token，落库/展示前先脱敏
      message: `远程配置源不可达：${mask(error instanceof Error ? error.message : String(error))}，已继续使用本地缓存`,
    };
  }

  const signed = signedPartOf(raw, headers);
  const verification = verifySignature(signed.signed, signed.signature, source.publicKey);
  if (verification.outcome === 'invalid' || verification.outcome === 'missing') {
    return {
      ok: false,
      status: 'signature_failed',
      document: null,
      latencyMs: Date.now() - started,
      message: verification.message,
    };
  }

  try {
    const document = parseRemoteConfig(raw, headers);
    return {
      ok: true,
      status: 'success',
      document,
      latencyMs: Date.now() - started,
      message: [
        verification.outcome === 'skipped' ? '拉取成功（未校验签名）' : '拉取成功，签名校验通过',
        ...document.warnings,
      ].join('；'),
    };
  } catch (error) {
    return {
      ok: false,
      status: 'invalid',
      document: null,
      latencyMs: Date.now() - started,
      message: `配置格式不合法：${mask(error instanceof Error ? error.message : String(error))}`,
    };
  }
}
