import { resolveEndpoint } from '../../domain/provider';
import type { Provider } from '../../domain/provider';
import type { Model, ModelDiscovery } from '../../domain/model';
import type { AdapterContext } from '../../core/adapter';
import { ProtocolError } from '../../core/error';
import { DEFAULT_CAPABILITY } from '../../domain/capability';

/**
 * /models 列举。
 *
 * 中转现实：
 * - 多数中转不开放 /models 或未做鉴权，失败是常态
 * - 失败时回退用户手填列表，并在 `source` 标注 `manual`，UI 需据实展示
 */

interface OpenAiModelEntry {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  context_window?: unknown;
  max_output?: unknown;
  owned_by?: unknown;
}

export async function fetchOpenAiModels(
  provider: Provider,
  context: AdapterContext,
): Promise<{ models: Model[]; note?: string }> {
  let payload: unknown;
  try {
    const response = await context.transport.request({
      url: resolveEndpoint(provider.baseUrl, 'openai', 'models'),
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...provider.headers,
        ...(context.apiKey ? { authorization: `Bearer ${context.apiKey}` } : {}),
      },
      timeoutMs: context.timeoutMs ?? provider.timeoutMs,
      ...(context.proxy ? { proxy: context.proxy } : {}),
    });

    if (response.status >= 400) {
      // 列模型失败由调用方决定如何降级
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

  const models: Model[] = list
    .map((entry) => toModel(provider.id, entry))
    .filter((model): model is Model => model !== null);
  return { models };
}

/** /models 不可用时的回退：手填模型列表 */
export function manualModelsDiscovery(provider: Provider): ModelDiscovery {
  const now = Date.now();
  const models: Model[] = provider.manualModels.map((name) => ({
    id: `manual:${provider.id}:${name}`,
    providerId: provider.id,
    name,
    displayName: null,
    capability: { ...DEFAULT_CAPABILITY },
    version: 1,
    createdAt: now,
    updatedAt: now,
  }));
  return {
    models,
    source: 'manual',
    note: '该服务未提供 /models，使用手动填写的模型列表',
  };
}

function extractList(payload: unknown): OpenAiModelEntry[] | null {
  if (Array.isArray(payload)) return payload as OpenAiModelEntry[];
  if (payload && typeof payload === 'object') {
    const data = (payload as Record<string, unknown>)['data'];
    if (Array.isArray(data)) return data as OpenAiModelEntry[];
    const models = (payload as Record<string, unknown>)['models'];
    if (Array.isArray(models)) return models as OpenAiModelEntry[];
  }
  return null;
}

function toModel(providerId: string, entry: OpenAiModelEntry): Model | null {
  const name =
    typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : null;
  if (!name) return null;
  const now = Date.now();
  return {
    id: `${providerId}:${name}`,
    providerId,
    name,
    displayName: typeof entry.display_name === 'string' ? entry.display_name : null,
    capability: {
      ...DEFAULT_CAPABILITY,
      contextWindow: toInt(entry.context_window),
      maxOutput: toInt(entry.max_output),
      // 远程清单普遍不带工具/视觉能力，默认按 Provider 声明兜底，由 UI 可人工修正
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
