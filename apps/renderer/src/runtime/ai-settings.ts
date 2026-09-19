import type { AiControlHost, AiRpcRequest, AiStreamHandle, AiStreamRequest } from '@ec/shell-api';
import { createRequestId } from '@ec/shell-api';
import type {
  ApplyPlan,
  ConfigDiffItem,
  ConnectionTestResult,
  CreateProviderInput,
  Model,
  Provider,
  PurposeBinding,
  RemoteConfigSource,
  RemoteFetchResult,
  UsageTotals,
} from '@ec/ai';
import type { AiSettingsApi } from '../features/settings/ai-settings-context';

/**
 * 渲染层 AI 客户端：RPC 经过 ShellHost.ai，浏览器/Mock 无栈时安全降级。
 *
 * 安全边界：明文 API Key 只出现在 `persistApiKey` 这一次调用的入参里，
 * 之后一律用密钥环引用名指代（NFR-S-01）。
 *
 * 缓存策略：islands 是命令式 API，没有订阅；写操作完成后统一 refresh()，
 * 保证列表 / 模型 / 用途绑定 / 用量四份快照始终取自同一次回读。
 */
export async function createRendererAiSettings(host: AiControlHost): Promise<AiSettingsApi> {
  let providers: Provider[] = [];
  let models: Model[] = [];
  let binding: PurposeBinding = { bindings: {}, useDefaultForAll: true, defaultModelId: null };
  let usage: UsageTotals = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
    complete: true,
  };
  let sources: RemoteConfigSource[] = [];

  const invoke = async <T>(method: AiRpcRequest['method'], params: unknown): Promise<T> => {
    const response = await host.invoke({ requestId: createRequestId(), method, params });
    if (!response.ok) throw new Error(response.error?.message ?? 'AI 操作失败');
    return response.result as T;
  };
  const refresh = async (): Promise<void> => {
    const [nextProviders, nextModels, nextBinding, nextUsage, nextSources] = await Promise.all([
      invoke<Provider[]>('listProviders', {}),
      invoke<Model[]>('listAllModels', {}),
      invoke<PurposeBinding>('getBinding', {}),
      invoke<UsageTotals>('monthlyUsage', {}),
      invoke<RemoteConfigSource[]>('listRemoteSources', {}),
    ]);
    providers = nextProviders;
    models = nextModels;
    binding = nextBinding;
    usage = nextUsage;
    sources = nextSources;
  };
  const read = (providerId: string): Model[] =>
    models.filter((model) => model.providerId === providerId);
  const after = <T>(promise: Promise<T>): Promise<T> =>
    promise.then(async (result) => {
      await refresh();
      return result;
    });

  await refresh();
  return {
    listProviders: () => providers,
    createProvider: (input: Omit<CreateProviderInput, 'userId'>) =>
      after(invoke<Provider>('createProvider', input)),
    updateProvider: (id: string, patch: unknown) =>
      after(invoke<Provider | null>('updateProvider', { id, patch })),
    removeProvider: (id: string) => after(invoke<boolean>('removeProvider', { id })),
    setProviderEnabled: (id: string, enabled: boolean) => {
      void after(invoke<Provider | null>('setProviderEnabled', { id, enabled }));
      return providers.find((provider) => provider.id === id) ?? null;
    },
    reorderProviders: (orderedIds: readonly string[]) => {
      void after(invoke<void>('reorderProviders', { orderedIds }));
    },
    testConnection: (providerId: string) =>
      invoke<ConnectionTestResult>('testConnection', { providerId }),
    testDraftConnection: (input: unknown, keyRef: string | null) =>
      invoke<ConnectionTestResult>('testDraftConnection', { input, keyRef }),
    persistApiKey: (input: { keyRef?: string | null; apiKey: string }) =>
      invoke<string>('persistApiKey', input),
    discardTempKey: async (keyRef: string | null) => {
      if (keyRef) await invoke<void>('discardTempKey', { keyRef });
    },
    streamChat: (request) =>
      createRendererAiStream(host, {
        purpose: request.purpose,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
        ...(request.providerId !== undefined ? { providerId: request.providerId } : {}),
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      }),
    listModels: read,
    listAllModels: () => models,
    refreshModels: (providerId: string) => after(invoke<Model[]>('refreshModels', { providerId })),
    addManualModel: (providerId: string, name: string) => {
      void after(invoke<Model>('addManualModel', { providerId, name }));
      const cached = models.find((model) => model.name === name) ?? models[0];
      if (!cached) throw new Error('模型列表尚未就绪，请稍后重试');
      return cached;
    },
    updateCapability: (modelId: string, patch: unknown) => {
      void after(invoke<Model | null>('updateCapability', { modelId, patch }));
      return models.find((model) => model.id === modelId) ?? null;
    },
    getBinding: () => binding,
    saveBinding: (next: PurposeBinding) => {
      void after(invoke<PurposeBinding>('saveBinding', { binding: next }));
      binding = next;
      return next;
    },
    monthlyUsage: () => usage,
    listRemoteSources: () => sources,
    createRemoteSource: (input) => {
      void after(invoke<RemoteConfigSource>('createRemoteSource', input));
      const cached = sources.at(-1);
      if (!cached) throw new Error('远程配置列表尚未就绪，请稍后重试');
      return cached;
    },
    updateRemoteSource: (id: string, patch: unknown) => {
      void after(invoke<RemoteConfigSource | null>('updateRemoteSource', { id, patch }));
      return sources.find((source) => source.id === id) ?? null;
    },
    removeRemoteSource: (id: string) => {
      void after(invoke<boolean>('removeRemoteSource', { id }));
      sources = sources.filter((source) => source.id !== id);
      return true;
    },
    fetchRemoteSource: (id: string) =>
      after(invoke<RemoteFetchResult>('fetchRemoteSource', { id })),
    previewRemoteSource: (id: string) =>
      invoke<{
        items: ConfigDiffItem[];
        summary: string;
        revision: string | null;
        plan?: ApplyPlan | null;
      }>('previewRemoteSource', { id }),
    applyRemoteSource: (id: string, options: unknown) =>
      after(invoke<ApplyPlan>('applyRemoteSource', { id, options })),
    ackRemoteRevision: (id: string, revision: string) => {
      void after(invoke<RemoteConfigSource | null>('ackRemoteRevision', { id, revision }));
      return sources.find((source) => source.id === id) ?? null;
    },
  };
}

export function createRendererAiStream(
  host: AiControlHost,
  request: Omit<AiStreamRequest, 'requestId'>,
): AiStreamHandle {
  const full = { ...request, requestId: createRequestId('stream') };
  return host.stream(full);
}
