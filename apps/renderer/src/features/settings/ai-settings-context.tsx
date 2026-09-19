import { createContext, useContext, type ReactNode } from 'react';

import type {
  AiPurpose,
  CapabilityPatch,
  ConnectionTestResult,
  CreateProviderInput,
  Model,
  Provider,
  PurposeBinding,
  RemoteConfigSource,
  RemoteFetchResult,
  UpdateProviderInput,
  UsageTotals,
} from '@ec/ai';
import type { ApplyPlan, ConfigDiffItem } from '@ec/ai';
import type { AiStreamHandle } from '@ec/shell-api';

/**
 * 设置页对 AI 层的依赖（端口）。
 *
 * 渲染层只认这个接口，不直接 import 仓库与适配器：
 * - 生产环境由 `AiControlService` 提供实现
 * - 单元测试用内存假实现，避免牵扯 SQLite 与网络
 */

/** 表单侧入参：userId 由服务注入，UI 不感知 */
export type ProviderFormInput = Omit<CreateProviderInput, 'userId'>;

export interface AiSettingsApi {
  /* Provider */
  listProviders(): Provider[];
  createProvider(input: ProviderFormInput): Promise<Provider>;
  updateProvider(id: string, patch: UpdateProviderInput): Promise<Provider | null>;
  removeProvider(id: string): Promise<boolean>;
  setProviderEnabled(id: string, enabled: boolean): Provider | null;
  reorderProviders(orderedIds: readonly string[]): void;
  testConnection(providerId: string): Promise<ConnectionTestResult>;
  /** @param keyRef 渲染层写入密钥环后拿到的引用名；为 null 表示沿用已保存的 Key */
  testDraftConnection(
    input: ProviderFormInput,
    keyRef: string | null,
  ): Promise<ConnectionTestResult>;

  /** 把明文 Key 写入本机密钥环，只回传引用名（Key 永不跨 IPC 明文传递） */
  persistApiKey(input: { keyRef?: string | null; apiKey: string }): Promise<string>;
  /** 丢弃连接测试留下的临时 Key */
  discardTempKey(keyRef: string | null): Promise<void>;
  /** 发一次真实生成（E2E-10 的「完成一次生成」），返回可中断的流句柄 */
  streamChat(request: {
    purpose: AiPurpose;
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown }>;
    modelId?: string | null;
    providerId?: string | null;
    maxTokens?: number;
  }): AiStreamHandle;

  /* 模型 */
  listModels(providerId: string): Model[];
  listAllModels(): Model[];
  refreshModels(providerId: string): Promise<Model[]>;
  addManualModel(providerId: string, name: string): Model;
  updateCapability(modelId: string, patch: CapabilityPatch): Model | null;

  /* 用途绑定 */
  getBinding(): PurposeBinding;
  saveBinding(binding: PurposeBinding): PurposeBinding;

  /* 用量 */
  monthlyUsage(): UsageTotals;

  /* 远程配置（用户自配 URL） */
  listRemoteSources(): RemoteConfigSource[];
  createRemoteSource(input: {
    name: string;
    url: string;
    publicKey?: string | null;
    enabled?: boolean;
    updateIntervalMin?: number;
  }): RemoteConfigSource;
  updateRemoteSource(
    id: string,
    patch: {
      name?: string;
      url?: string;
      publicKey?: string | null;
      enabled?: boolean;
      updateIntervalMin?: number;
    },
  ): RemoteConfigSource | null;
  removeRemoteSource(id: string): boolean;
  fetchRemoteSource(id: string): Promise<RemoteFetchResult>;
  previewRemoteSource(id: string): Promise<{
    items: ConfigDiffItem[];
    summary: string;
    revision: string | null;
    plan?: ApplyPlan | null;
  }>;
  applyRemoteSource(
    id: string,
    options?: { overwriteLocal?: boolean; ackDefaultModel?: boolean },
  ): Promise<ApplyPlan>;
  ackRemoteRevision(id: string, revision: string): RemoteConfigSource | null;
}

const AiSettingsContext = createContext<AiSettingsApi | null>(null);

export interface AiSettingsProviderProps {
  api: AiSettingsApi | null;
  children: ReactNode;
}

export function AiSettingsProvider({ api, children }: AiSettingsProviderProps): JSX.Element {
  return <AiSettingsContext.Provider value={api}>{children}</AiSettingsContext.Provider>;
}

/** 取实现；未注入时返回 null（页面据此展示初始化引导，而不是崩溃） */
export function useAiSettingsOptional(): AiSettingsApi | null {
  return useContext(AiSettingsContext);
}

export function useAiSettings(): AiSettingsApi {
  const api = useAiSettingsOptional();
  if (!api) throw new Error('AI 设置未初始化：请先注入 AiSettingsApi');
  return api;
}
