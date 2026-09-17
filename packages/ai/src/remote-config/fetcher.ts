import { z } from 'zod';

import { protocolSchema, headersSchema, httpUrlSchema } from '../domain/provider';
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
  headers: headersSchema.default({}),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
  supportsStream: z.boolean().default(true),
  supportsTools: z.boolean().default(false),
  supportsVision: z.boolean().default(false),
  /** 该 Provider 的默认模型名（用于用途绑定的默认值） */
  defaultModel: z.string().trim().min(1).nullish(),
});

export const remoteConfigPayloadSchema = z.object({
  /** 版本号：用于"拒绝后不再弹窗"与差异比较 */
  revision: z.string().trim().min(1),
  updatedAt: z.number().int().nullish(),
  note: z.string().max(500).nullish(),
  providers: z.array(remoteProviderSchema).default([]),
});

export type RemoteProviderConfig = z.infer<typeof remoteProviderSchema>;
export type RemoteConfigPayload = z.infer<typeof remoteConfigPayloadSchema>;

/** 拉取到的原始文档：正文 + 可选签名 */
export interface RemoteConfigDocument {
  payload: RemoteConfigPayload;
  signature: string | null;
  raw: string;
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
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of SIGNATURE_HEADERS) {
    const value = normalized.get(key.toLowerCase());
    if (value && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** 解析远程配置正文；签名可能在响应头，也可能在 body 的 signature 字段 */
export function parseRemoteConfig(raw: string, headers: Record<string, string> = {}): RemoteConfigDocument {
  const parsed: unknown = JSON.parse(raw);
  const record = (parsed ?? {}) as Record<string, unknown>;
  const signature =
    pickSignature(headers) ?? (typeof record['signature'] === 'string' ? (record['signature'] as string) : null);

  const payload = remoteConfigPayloadSchema.parse(
    'payload' in record && record['payload'] && typeof record['payload'] === 'object' ? record['payload'] : record,
  );
  return { payload, signature, raw };
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
        message: `远程配置返回 ${response.status}`,
      };
    }
    raw = await response.text();
  } catch (error) {
    return {
      ok: false,
      status: 'unreachable',
      document: null,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const verification = verifySignature(raw, pickSignature(headers), source.publicKey);
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
      message: verification.outcome === 'skipped' ? '拉取成功（未校验签名）' : '拉取成功，签名校验通过',
    };
  } catch (error) {
    return {
      ok: false,
      status: 'invalid',
      document: null,
      latencyMs: Date.now() - started,
      message: `配置格式不合法：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
