import { DEFAULT_CAPABILITY } from '../../domain/capability';
import type { Model, ModelDiscovery } from '../../domain/model';
import type { Provider } from '../../domain/provider';
import type { AdapterContext } from '../../core/adapter';
import { ProtocolError } from '../../core/error';

/**
 * Anthropic 模型列举。
 *
 * 官方提供 `GET /v1/models?limit=...`（beta 头），多数中转不实现；
 * 因此策略与 OpenAI 一致：先尝试远程，失败回退用户手填列表并标注来源。
 */

interface AnthropicModelEntry {
  id?: unknown;
  display_name?: unknown;
  created_at?: unknown;
}

export async function fetchAnthropicModels(
  provider: Provider,
  context: AdapterContext,
  anthropicVersion = '2023-06-01',
): Promise<{ models: Model[] }> {
  const base = new URL(provider.baseUrl);
  const path = base.pathname.replace(/\/+$/, '');
  base.pathname = path.endsWith('/models') ? path : `${path === '' ? '/v1' : path}/models`;
  base.search = '?limit=100';

  let payload: unknown;
  try {
    const response = await context.transport.request({
      url: base.toString(),
      method: 'GET',
      headers: {
        accept: 'application/json',
        'anthropic-version': anthropicVersion,
        ...provider.headers,
        ...(context.apiKey ? { 'x-api-key': context.apiKey } : {}),
      },
      timeoutMs: context.timeoutMs ?? provider.timeoutMs,
      ...(context.proxy ? { proxy: context.proxy } : {}),
    });
    if (response.status >= 400) {
      throw new ProtocolError(`/models 返回 ${response.status}`, {
        status: response.status,
        providerId: provider.id,
        snippet: await response.text(),
      });
    }
    payload = JSON.parse(await response.text()) as unknown;
  } catch (error) {
    throw error instanceof ProtocolError
      ? error
      : new ProtocolError(
          `/models 请求失败：${error instanceof Error ? error.message : String(error)}`,
          {
            providerId: provider.id,
          },
        );
  }

  const list = extractList(payload);
  if (list === null) {
    throw new ProtocolError('/models 响应缺少 data 数组', {
      providerId: provider.id,
      snippet: JSON.stringify(payload ?? null).slice(0, 300),
    });
  }

  const now = Date.now();
  const models = list
    .map((entry) => (typeof entry.id === 'string' ? entry.id : null))
    .filter((name): name is string => name !== null)
    .map<Model>((name) => ({
      id: `${provider.id}:${name}`,
      providerId: provider.id,
      name,
      displayName: null,
      capability: { ...DEFAULT_CAPABILITY },
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));

  return { models };
}

/** 手填模型回退 */
export function manualModelsDiscovery(provider: Provider): ModelDiscovery {
  const now = Date.now();
  return {
    source: 'manual',
    note: '该服务未提供 /models，使用手动填写的模型列表',
    models: provider.manualModels.map<Model>((name) => ({
      id: `manual:${provider.id}:${name}`,
      providerId: provider.id,
      name,
      displayName: null,
      capability: { ...DEFAULT_CAPABILITY },
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
  };
}

function extractList(payload: unknown): AnthropicModelEntry[] | null {
  if (Array.isArray(payload)) return payload as AnthropicModelEntry[];
  if (payload && typeof payload === 'object') {
    const data = (payload as Record<string, unknown>)['data'];
    if (Array.isArray(data)) return data as AnthropicModelEntry[];
  }
  return null;
}
