import { useMemo, useState } from 'react';

import type { CapabilityPatch, ConnectionTestResult, Model, Provider, PurposeBinding } from '@ec/ai';

import { useAiSettings } from '../ai-settings-context';

/**
 * Provider 设置页状态。
 *
 * 只做「读 + 调 API + 回写」这三件事，不持有业务逻辑；
 * 所有校验与持久化都在 @ec/ai 里完成，UI 只负责展示与错误提示。
 */

export interface ProviderDraft {
  id?: string;
  name: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  headersText: string;
  timeoutMs: number;
  supportsStream: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  enabled: boolean;
  manualModelsText: string;
  version?: number;
}

export const EMPTY_DRAFT: ProviderDraft = {
  name: '',
  protocol: 'openai',
  baseUrl: '',
  apiKey: '',
  headersText: '',
  timeoutMs: 30_000,
  supportsStream: true,
  supportsTools: false,
  supportsVision: false,
  enabled: true,
  manualModelsText: '',
};

export function draftFromProvider(provider: Provider): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: '',
    headersText: JSON.stringify(provider.headers ?? {}, null, 2),
    timeoutMs: provider.timeoutMs,
    supportsStream: provider.supportsStream,
    supportsTools: provider.supportsTools,
    supportsVision: provider.supportsVision,
    enabled: provider.enabled,
    manualModelsText: provider.manualModels.join('\n'),
    version: provider.version,
  };
}

export interface UseProviderSettingsResult {
  providers: Provider[];
  models: Model[];
  allModels: Model[];
  binding: PurposeBinding;
  usage: { totalTokens: number; cost: number; requests: number; complete: boolean };
  draft: ProviderDraft;
  editingId: string | null;
  busy: boolean;
  error: string | null;
  refresh(): void;
  startCreate(): void;
  startEdit(provider: Provider): void;
  updateDraft(patch: Partial<ProviderDraft>): void;
  cancelEdit(): void;
  saveDraft(): Promise<Provider | null>;
  removeProvider(id: string): Promise<void>;
  toggleEnabled(id: string, enabled: boolean): void;
  move(id: string, direction: -1 | 1): void;
  refreshModelList(providerId: string): Promise<void>;
  addModel(providerId: string, name: string): void;
  patchCapability(modelId: string, patch: CapabilityPatch): void;
  testDraft(): Promise<ConnectionTestResult>;
  setBinding(binding: PurposeBinding): void;
}

export function useProviderSettings(): UseProviderSettingsResult {
  const api = useAiSettings();
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // revision 是「数据已变更」的信号：AI 侧是命令式 API，没有订阅机制，
  // 所有派生值都挂在 revision 上，写操作后自增即可让整屏刷新。
  const editingId = draft.id ?? null;
  const providers = useMemo(() => (void revision, api.listProviders()), [api, revision]);
  const models = useMemo(
    () => (void revision, editingId ? api.listModels(editingId) : []),
    [api, editingId, revision],
  );
  const allModels = useMemo(() => (void revision, api.listAllModels()), [api, revision]);
  const binding = useMemo(() => (void revision, api.getBinding()), [api, revision]);
  const usage = useMemo(() => {
    void revision;
    const totals = api.monthlyUsage();
    return {
      totalTokens: totals.totalTokens,
      cost: totals.cost,
      requests: totals.requests,
      complete: totals.complete,
    };
  }, [api, revision]);

  const refresh = (): void => setRevision((value) => value + 1);

  const run = async (task: () => void | Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await task();
      refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return {
    providers,
    models,
    allModels,
    binding,
    usage,
    draft,
    editingId,
    busy,
    error,
    refresh,
    startCreate: () => setDraft({ ...EMPTY_DRAFT }),
    startEdit: (provider) => setDraft(draftFromProvider(provider)),
    updateDraft: (patch) => setDraft((current) => ({ ...current, ...patch })),
    cancelEdit: () => setDraft({ ...EMPTY_DRAFT }),
    saveDraft: async () => {
      let saved: Provider | null = null;
      let pendingKeyRef: string | null = null;
      await run(async () => {
        const headers = draft.headersText.trim().length > 0 ? (JSON.parse(draft.headersText) as Record<string, string>) : {};
        const manualModels = draft.manualModelsText
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const payload = {
          name: draft.name,
          protocol: draft.protocol,
          baseUrl: draft.baseUrl,
          headers,
          timeoutMs: draft.timeoutMs,
          supportsStream: draft.supportsStream,
          supportsTools: draft.supportsTools,
          supportsVision: draft.supportsVision,
          enabled: draft.enabled,
          manualModels,
          ...(draft.id ? { id: draft.id } : {}),
        };
        // 明文 Key 先写密钥环（DPAPI），只把引用名交出去
        if (draft.apiKey.trim().length > 0) {
          pendingKeyRef = await api.persistApiKey({ apiKey: draft.apiKey.trim() });
        }
        saved = draft.id
          ? await api.updateProvider(draft.id, { ...payload, ...(pendingKeyRef ? { keyRef: pendingKeyRef } : {}), version: draft.version })
          : await api.createProvider({ ...payload, ...(pendingKeyRef ? { keyRef: pendingKeyRef } : {}) });
        setDraft({ ...EMPTY_DRAFT });
      });
      // 保存失败时清掉临时 Key，避免密钥环里留下孤儿条目
      if (!saved && pendingKeyRef) await api.discardTempKey(pendingKeyRef).catch(() => undefined);
      return saved;
    },
    removeProvider: async (id) => {
      await run(async () => {
        await api.removeProvider(id);
      });
    },
    toggleEnabled: (id, enabled) => {
      void run(() => {
        api.setProviderEnabled(id, enabled);
      });
    },
    move: (id, direction) => {
      void run(() => {
        const order = [...providers];
        const index = order.findIndex((item) => item.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= order.length) return;
        [order[index], order[target]] = [order[target] as Provider, order[index] as Provider];
        api.reorderProviders(order.map((item) => item.id));
      });
    },
    refreshModelList: async (providerId) => {
      await run(async () => {
        await api.refreshModels(providerId);
      });
    },
    addModel: (providerId, name) => {
      void run(() => {
        api.addManualModel(providerId, name);
      });
    },
    patchCapability: (modelId, patch) => {
      void run(() => {
        api.updateCapability(modelId, patch);
      });
    },
    testDraft: async () => {
      const headers = draft.headersText.trim().length > 0 ? (JSON.parse(draft.headersText) as Record<string, string>) : {};
      const manualModels = draft.manualModelsText.split('\n').map((line) => line.trim()).filter(Boolean);
      const input = {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name, protocol: draft.protocol, baseUrl: draft.baseUrl, headers,
        timeoutMs: draft.timeoutMs, supportsStream: draft.supportsStream, supportsTools: draft.supportsTools,
        supportsVision: draft.supportsVision, enabled: draft.enabled, order: 0, manualModels,
      };
      // 表单里的 Key 只用于这一次试连：写入临时引用，用完立即丢弃
      let keyRef: string | null = null;
      if (draft.apiKey.trim()) keyRef = await api.persistApiKey({ apiKey: draft.apiKey.trim() });
      try {
        return await api.testDraftConnection(input as never, keyRef);
      } finally {
        if (keyRef) await api.discardTempKey(keyRef).catch(() => undefined);
      }
    },
    setBinding: (next) => {
      void run(() => {
        api.saveBinding(next);
      });
    },
  };
}
