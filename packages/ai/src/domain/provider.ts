import { z } from 'zod';
import type { ProviderRow } from '@ec/data';

/**
 * Provider（FR-MDL-01）。
 *
 * 安全约定（NFR-S-01）：
 * - `keyRef` 只是密钥环里的引用名，DB 永不明文落 Key
 * - 明文 Key 只在内存中存在（编辑界面 → 密钥环），不进日志、不进错误信息
 */

export type Protocol = 'openai' | 'anthropic';

export const PROTOCOLS: readonly Protocol[] = ['openai', 'anthropic'];

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
};

export interface Provider {
  id: string;
  userId: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  /** 密钥环引用（命名空间 ai-key）；null 表示未配置 Key */
  keyRef: string | null;
  /** 自定义请求头（透传给中转） */
  headers: Record<string, string>;
  timeoutMs: number;
  supportsStream: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  enabled: boolean;
  /** 排序与容灾选择顺序（升序） */
  order: number;
  /** /models 不可用时的手填模型列表 */
  manualModels: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
}

export const KEY_NAMESPACE = 'ai-key';

/** 尚未保存的 Provider 在「连接测试」时使用的临时命名空间 */
export const DRAFT_KEY_NAMESPACE = 'ai-key-draft';

/** 临时引用名前缀：连接测试用完即删，避免密钥环里堆积孤儿条目 */
export const TEMP_KEY_PREFIX = 'temp-';

export function tempKeyRefOf(): string {
  return `${TEMP_KEY_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isTempKeyRef(ref: string | null): boolean {
  return typeof ref === 'string' && ref.startsWith(TEMP_KEY_PREFIX);
}

export const protocolSchema = z.enum(['openai', 'anthropic']);

export const httpUrlSchema = z
  .string()
  .trim()
  .min(1, 'baseUrl 不能为空')
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'baseUrl 必须是合法 URL' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'baseUrl 必须是 http/https 地址' });
    }
  });

export const headersSchema = z
  .record(z.string().trim().min(1), z.string())
  .superRefine((headers, ctx) => {
    for (const name of Object.keys(headers)) {
      if (isSensitiveHeaderName(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: '敏感认证头不得写入 Provider 配置，请使用 API Key 密钥环字段',
        });
      }
    }
  });

/**
 * 自定义请求头不允许承载认证凭据。
 *
 * Provider.headers 会持久化到 SQLite，并会回显到设置页；Authorization、x-api-key
 * 等头一旦允许进入这里，就会绕过 secure-store，违反「Key 只存密钥环」约束。
 */
export function isSensitiveHeaderName(name: string): boolean {
  return /(?:authorization|proxy-authorization|x-api-key|api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|cookie|credential)/i.test(
    name.trim(),
  );
}

/** 读取旧数据时也过滤认证头，避免历史脏数据回显或覆盖安全 Key。 */
export function filterSafeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveHeaderName(name)),
  );
}

export const providerBaseSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 个字符'),
  protocol: protocolSchema,
  baseUrl: httpUrlSchema,
  headers: headersSchema.default({}),
  /** 1~600 秒 */
  timeoutMs: z
    .number()
    .int()
    .min(1_000, '超时至少 1 秒')
    .max(600_000, '超时最多 600 秒')
    .default(30_000),
  supportsStream: z.boolean().default(true),
  supportsTools: z.boolean().default(false),
  supportsVision: z.boolean().default(false),
  enabled: z.boolean().default(true),
  order: z.number().int().min(0).default(0),
  manualModels: z.array(z.string().trim().min(1)).default([]),
});

/* --------------------------- 端点解析 --------------------------- */

export type EndpointKind = 'chat' | 'models' | 'embeddings';

/**
 * 端点拼接容错：baseUrl 带不带 `/v1`、带不带尾斜杠都能正确请求。
 *
 * OpenAI：
 * - `https://api.openai.com`        → `/v1/chat/completions`
 * - `https://api.openai.com/v1`     → `/v1/chat/completions`
 * - `https://oneapi.example.com/v1` → `/v1/chat/completions`
 * - `https://relay.com/api/v3`      → `/api/v3/chat/completions`
 * - 已含 `/chat/completions`        → 原样
 */
export function resolveEndpoint(baseUrl: string, protocol: Protocol, kind: EndpointKind): string {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/, '');

  if (protocol === 'anthropic') {
    if (!path.endsWith('/messages')) {
      path = path === '' || path === '/' ? '/v1/messages' : `${path}/messages`;
    }
    url.pathname = path;
    return url.toString();
  }

  const LEAF: Record<EndpointKind, string> = {
    chat: 'chat/completions',
    models: 'models',
    embeddings: 'embeddings',
  };
  const leaf = LEAF[kind];
  if (!path.endsWith(`/${leaf}`)) {
    if (path === '' || path === '/') path = `/v1/${leaf}`;
    else path = `${path}/${leaf}`;
  }
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/* --------------------------- 行转换 ---------------------------- */

export function providerFromRow(row: ProviderRow): Provider {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    keyRef: row.api_key_ref,
    headers: filterSafeHeaders(parseHeaders(row.headers_json)),
    timeoutMs: row.default_timeout,
    supportsStream: row.supports_stream === 1,
    supportsTools: row.supports_tools === 1,
    supportsVision: row.supports_vision === 1,
    enabled: row.enabled === 1,
    order: row.sort_order,
    manualModels: parseStringArray(row.manual_models_json),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseHeaders(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    }
  } catch {
    // 非法 JSON 视为无自定义头
  }
  return {};
}

export function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/** 密钥环引用名（与 providerId 一一对应） */
export function keyRefOf(providerId: string): string {
  // Electron/Tauri 外壳的密钥环键名只允许字母、数字、点、下划线、短横线。
  return `provider-${providerId}`;
}

/** UI 掩码：前 4 后 4，短 Key 全掩码（FR-MDL-09） */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(6)}${key.slice(-4)}`;
}
