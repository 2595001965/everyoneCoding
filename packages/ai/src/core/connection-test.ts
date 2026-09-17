import { collect } from './stream';
import { ProtocolError, toAiError } from './error';
import type { AdapterContext, ConnectionTestResult, ProviderAdapter } from './adapter';
import type { ModelDiscovery } from '../domain/model';
import { DEFAULT_CAPABILITY } from '../domain/capability';
import type { Provider } from '../domain/provider';

/** 模型发现失败可用手填列表，但只有最小对话完整结束才算连通。 */
export async function runConnectionTest(
  adapter: ProviderAdapter,
  provider: Provider,
  context: AdapterContext,
): Promise<ConnectionTestResult> {
  const started = Date.now();
  let models: ModelDiscovery;
  try {
    models = await adapter.listModels(provider, context);
  } catch {
    models = {
      source: 'manual',
      note: '模型发现不可用，使用手填列表验证对话',
      models: provider.manualModels.map((name) => ({
        id: `manual:${provider.id}:${name}`, providerId: provider.id, name,
        displayName: null, capability: { ...DEFAULT_CAPABILITY },
        version: 1, createdAt: 0, updatedAt: 0,
      })),
    };
  }
  const target = models.models[0]?.name ?? provider.manualModels[0];
  if (!target) {
    return {
      ok: false, models, latencyMs: Date.now() - started,
      error: new ProtocolError('未能获取模型，请手动填写模型名'),
    };
  }
  try {
    const result = await collect(adapter.chat({
      provider, model: target, messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1, stream: false,
    }, context));
    const error = result.error ?? (result.partial
      ? new ProtocolError('连接测试未完整结束，请重新测试') : null);
    return {
      ok: error === null, models, latencyMs: Date.now() - started,
      ...(error ? { error } : {}),
    };
  } catch (error) {
    return {
      ok: false, models, latencyMs: Date.now() - started,
      error: toAiError(error, { providerId: provider.id }),
    };
  }
}
