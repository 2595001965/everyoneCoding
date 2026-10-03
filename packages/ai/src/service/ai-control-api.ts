import type { Provider } from '../domain/provider';
import type { Model } from '../domain/model';
import type { CapabilityPatch } from '../domain/capability';
import type { PurposeBinding } from '../domain/purpose-binding';
import type { ConnectionTestResult } from '../core/adapter';
import type { HttpTransport, ProxyConfig } from '../core/http';
import type { ProviderRepo } from '../repo/provider-repo';
import type { ModelRepo } from '../repo/model-repo';
import type { PurposeBindingRepo } from '../repo/purpose-binding-repo';
import type { RemoteConfigRepo, RemoteConfigSource } from '../repo/remote-config-repo';
import type { UsageTracker } from '../gateway/usage-tracker';
import type { BudgetGuard } from '../gateway/budget';
import type { RequestQueue } from '../gateway/queue';
import type { AiGateway } from '../gateway/client';
import type { FailoverController, FailoverPolicy } from '../gateway/failover';
import type { AiEventLog, AiEventRecord } from '../gateway/event-log';
import type { ProviderLimits } from '../gateway/queue';
import { AI_PURPOSES, PURPOSE_LABELS, type AiPurpose } from '../domain/purpose-binding';
import type { UsageTotals } from '../repo/usage-repo';
import {
  fetchRemoteConfig,
  parseRemoteConfig,
  type RemoteConfigPayload,
  type RemoteFetchResult,
} from '../remote-config/fetcher';
import {
  diffRemoteConfig,
  planApply,
  summarizeDiff,
  type ApplyPlan,
  type ConfigDiffItem,
} from '../remote-config/applier';
import { parseCreateProvider, type CreateProviderInput } from '../dto/create-provider';
import { parseUpdateProvider, type UpdateProviderInput } from '../dto/update-provider';
import { parseProxyUrl, testProxyConnectivity, type ProxyTestResult } from '../gateway/proxy';
import { newUlid } from '@ec/data';
import { isHostedGatewayProvider } from '../adapters/platform-gateway';
import {
  platformCatalogSnapshotSchema,
  providerModelKeyOf,
  type PlatformCatalogSnapshot,
} from '@ec/core';
import { AttemptRuntime } from '../gateway/attempt-runtime';
import type { StreamChunk } from '../core/stream';
import { toAiError } from '../core/error';
import { isTempKeyRef, tempKeyRefOf } from '../domain/provider';

/**
 * AI 设置门面：渲染层唯一调用的同步/异步 API。
 *
 * 收敛点：
 * - 所有入参在门口做 zod 校验，非法输入不进仓库
 * - 明文 Key 不出现在返回值里（只回 keyRef 与掩码）
 * - 远程配置相关操作全部"失败可回退、不阻塞启动"
 */

export interface AiControlDeps {
  userId: string;
  providers: ProviderRepo;
  models: ModelRepo;
  bindings: PurposeBindingRepo;
  usage: UsageTracker;
  budget: BudgetGuard;
  queue: RequestQueue;
  gateway: AiGateway;
  remoteConfig: RemoteConfigRepo;
  transport: HttpTransport;
  failover?: FailoverController;
  events?: AiEventLog;
  platformGateway?: {
    accountBaseUrl: string;
    getAccessToken: () => Promise<string | null>;
  };
}

/** 启动刷新的单源结果（设置页「上次拉取」与默认模型询问都读它） */
export interface BootRefreshItem {
  id: string;
  name: string;
  result: RemoteFetchResult;
  /** 拉取失败但本地有上次成功的缓存：继续用缓存，不阻塞 */
  usingCache: boolean;
  /** 本次自动应用（只新增本地没有的服务，本地优先）；未应用为 null */
  applied: { revision: string; created: string[]; skipped: string[] } | null;
  /** 远程默认模型与本地不同且该版本未被拒绝过：UI 需弹窗询问 */
  pendingDefaultModel: {
    before: string | null;
    after: string;
    revision: string;
    /** 该默认模型声明自哪个远程 Provider（全局默认时为 null） */
    providerName?: string | null;
    /** 模型名未变、默认路由仅换渠道（A/x → B/x）：from=当前渠道，to=远程声明渠道 */
    providerSwitch?: { from: string; to: string } | null;
    /** 同名模型分布在多个 Provider：不能自动绑定，需用户手动选择路由（V2-MDL-02/03） */
    ambiguous?: boolean;
  } | null;
}

/** 「是否已可用」的引导清单（没有配置时 UI 据此给出可执行的下一步） */
export interface AiReadiness {
  ready: boolean;
  providers: number;
  enabledProviders: number;
  providersWithKey: number;
  models: number;
  purposes: Array<{
    purpose: AiPurpose;
    label: string;
    modelName: string | null;
    providerName: string | null;
  }>;
  steps: Array<{ id: string; done: boolean; label: string; action: string }>;
}

export class AiControlService {
  constructor(private readonly deps: AiControlDeps) {}

  /* ---------------------------- Provider ---------------------------- */

  listProviders(): Provider[] {
    return this.deps.providers.list(this.deps.userId);
  }

  /** 新建 Provider；userId 由服务注入，UI 不需要知道 */
  async createProvider(input: Omit<CreateProviderInput, 'userId'>): Promise<Provider> {
    const created = await this.deps.providers.create(
      parseCreateProvider({ ...input, userId: this.deps.userId }),
    );
    // 手工填写的模型名必须落成 model 记录，否则 Gateway 选模型时看不到任何候选（FR-MDL-02）
    this.syncManualModels(created.id, created.manualModels ?? []);
    return created;
  }

  async updateProvider(id: string, input: unknown): Promise<Provider | null> {
    const patch = parseUpdateProvider(input);
    const updated = await this.deps.providers.update(id, patch, patch.version);
    if (updated && patch.manualModels !== undefined) {
      this.syncManualModels(updated.id, updated.manualModels ?? []);
    }
    return updated;
  }

  /**
   * 把 Provider 上手工声明的模型名同步为 model 记录。
   *
   * 只做「补齐」与「精确清理」，不是全量替换：
   * - 已存在同名模型（远程发现或手工添加）一律保留，避免覆盖用户改过的 capability
   * - 清理仅限两种情况且要求「未被任何用途绑定引用」：
   *     1) 上一次手工声明过、这次从表单里删掉的名字；
   *     2) 模型同时不在本次手工清单、也不在远程发现的名单里（避免误删远程模型）。
   */
  private syncManualModels(providerId: string, names: readonly string[]): void {
    const wanted = new Set(names.map((name) => name.trim()).filter((name) => name.length > 0));
    for (const name of wanted) {
      this.deps.models.createIfMissing(providerId, name);
    }
    const binding = this.deps.bindings.get(this.deps.userId);
    const bound = new Set(
      Object.values(binding.bindings).filter((id): id is string => typeof id === 'string'),
    );
    if (binding.defaultModelId) bound.add(binding.defaultModelId);
    const provider = this.deps.providers.findById(providerId);
    const declaredBefore = new Set((provider?.manualModels ?? []).map((name) => name.trim()));
    for (const model of this.deps.models.list(providerId)) {
      const wasManual = declaredBefore.has(model.name);
      const stillWanted = wanted.has(model.name);
      if (!stillWanted && wasManual && !bound.has(model.id)) this.deps.models.remove(model.id);
    }
  }

  removeProvider(id: string): Promise<boolean> {
    this.deps.models.removeByProvider(id);
    return this.deps.providers.remove(id);
  }

  setProviderEnabled(id: string, enabled: boolean): Provider | null {
    return this.deps.providers.setEnabled(id, enabled);
  }

  reorderProviders(orderedIds: readonly string[]): void {
    this.deps.providers.reorder(orderedIds);
  }

  async testConnection(providerId: string): Promise<ConnectionTestResult> {
    const provider = this.deps.providers.findById(providerId);
    if (provider && isHostedGatewayProvider(provider, this.deps.platformGateway?.accountBaseUrl)) {
      throw new Error('托管路由由平台账号鉴权；选择目录模型后可直接使用，无需发送测试生成请求');
    }
    return this.deps.gateway.testConnection(providerId);
  }

  /** Fetch the public platform catalog and materialize local routes without importing any keys. */
  async syncPlatformCatalog(): Promise<{ generatedAt: number; providers: number; models: number }> {
    const hosted = this.deps.platformGateway;
    if (!hosted) throw new Error('当前外壳未配置平台托管入口');
    const token = await hosted.getAccessToken();
    if (!token) throw new Error('平台托管需要先登录 EveryoneCoding 账号');
    const base = hosted.accountBaseUrl.replace(/\/+$/, '');
    const response = await this.deps.transport.request({
      url: `${base}/api/catalog/snapshot`,
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 15_000,
    });
    if (response.status >= 400) throw new Error(`平台目录读取失败（${response.status}）`);
    let raw: unknown;
    try {
      raw = JSON.parse(await response.text()) as unknown;
    } catch {
      throw new Error('平台目录响应格式无效');
    }
    const snapshot = platformCatalogSnapshotSchema.parse(raw);
    await this.materializeHostedRoutes(snapshot, `${base}/api/ai/requests`);
    return {
      generatedAt: snapshot.generatedAt,
      providers: snapshot.providers.filter((provider) => provider.status === 'active').length,
      models: snapshot.models.filter((model) =>
        snapshot.providers.some(
          (provider) => provider.providerId === model.providerId && provider.status === 'active',
        ),
      ).length,
    };
  }

  private async materializeHostedRoutes(
    snapshot: PlatformCatalogSnapshot,
    endpoint: string,
  ): Promise<void> {
    const activeProviders = new Map(
      snapshot.providers
        .filter((provider) => provider.status === 'active')
        .map((provider) => [provider.providerId, provider]),
    );
    const models = snapshot.models.filter((model) => activeProviders.has(model.providerId));
    const existing = this.deps.providers.list(this.deps.userId);
    const hostedByProtocol = new Map<'openai' | 'anthropic', Provider>();
    for (const protocol of ['openai', 'anthropic'] as const) {
      const routes = models.filter(
        (model) => activeProviders.get(model.providerId)?.protocol === protocol,
      );
      if (routes.length === 0) continue;
      const routeNames = routes.map((model) =>
        providerModelKeyOf({ providerId: model.providerId, modelId: model.modelId }),
      );
      const found = existing.find(
        (candidate) =>
          candidate.source === 'platform' &&
          candidate.protocol === protocol &&
          candidate.baseUrl.replace(/\/+$/, '') === endpoint,
      );
      const provider = found
        ? await this.deps.providers.update(
            found.id,
            { manualModels: routeNames, version: found.version },
            found.version,
          )
        : await this.deps.providers.create({
            userId: this.deps.userId,
            name:
              protocol === 'openai'
                ? 'EveryoneCoding 托管网关（OpenAI）'
                : 'EveryoneCoding 托管网关（Anthropic）',
            protocol,
            source: 'platform',
            baseUrl: endpoint,
            manualModels: routeNames,
            supportsStream: true,
            supportsTools: true,
            supportsVision: true,
            enabled: true,
            headers: {},
          });
      if (!provider) throw new Error('托管模型 Provider 已被其他操作删除，请重新同步目录');
      hostedByProtocol.set(protocol, provider);
    }
    for (const model of models) {
      const provider = hostedByProtocol.get(activeProviders.get(model.providerId)!.protocol);
      if (!provider) continue;
      const routeName = providerModelKeyOf({
        providerId: model.providerId,
        modelId: model.modelId,
      });
      const capabilities = new Set(model.capabilities ?? []);
      const capability = {
        contextWindow: model.contextWindowTokens,
        maxOutput: null,
        supportsStream: true,
        supportsTools: capabilities.has('tools') || capabilities.has('tool_use'),
        supportsVision: capabilities.has('vision') || capabilities.has('images'),
        inputPricePerMTok: null,
        outputPricePerMTok: null,
      };
      const local = this.deps.models.createIfMissing(provider.id, routeName, capability).model;
      this.deps.models.setDisplayName(
        local.id,
        `${activeProviders.get(model.providerId)!.displayName} / ${model.displayName}`,
      );
      this.deps.models.setCanonicalIdentity(local.id, {
        canonicalVendor: model.canonicalVendor,
        canonicalModel: model.canonicalModel,
      });
      this.deps.models.updateCapability(local.id, capability, {
        overwrite: true,
        keepManualFlag: true,
      });
    }
  }

  /**
   * 连接测试入账（V2-MDL-07「纳入用量」）：测试对话与生成走同一条用量记录。
   * 只按上游实测 usage 记账，上游未报时不估算（T11 统一升级计量口径）。
   */

  /**
   * 用「连接测试」临时写入的草稿 Key 试连（尚未保存的 Provider）。
   *
   * @param keyRef 渲染层写入 secureStore 后拿到的引用名；为 null 时回落到已保存 Key（编辑场景）
   */
  async testDraftConnection(
    input: Omit<CreateProviderInput, 'userId'>,
    keyRef: string | null = null,
  ): Promise<ConnectionTestResult> {
    const provider = parseCreateProvider({ ...input, userId: this.deps.userId });
    const raw = input as unknown as { id?: unknown };
    const existingId = typeof raw.id === 'string' ? raw.id : undefined;
    const existing = existingId ? this.deps.providers.findById(existingId) : null;
    let resolvedRef: string | null = keyRef;
    if (!resolvedRef && existing) resolvedRef = existing.keyRef;
    const draft = {
      ...(existing ?? {}),
      id: existing?.id ?? `draft-${Date.now()}`,
      userId: this.deps.userId,
      name: provider.name,
      protocol: provider.protocol,
      // 来源不可经草稿引入：已有 Provider 保持原值，新草稿一律 custom（V2-MDL-01）
      source: existing?.source ?? provider.source,
      baseUrl: provider.baseUrl,
      headers: provider.headers,
      timeoutMs: provider.timeoutMs,
      supportsStream: provider.supportsStream,
      supportsTools: provider.supportsTools,
      supportsVision: provider.supportsVision,
      enabled: provider.enabled,
      order: provider.order,
      manualModels: provider.manualModels,
      keyRef: resolvedRef,
      version: existing?.version ?? 1,
      createdAt: 0,
      updatedAt: 0,
    } as Provider;
    const apiKey = await this.readKey(resolvedRef, existingId);
    const adapter =
      draft.protocol === 'openai'
        ? new (await import('../adapters/openai/client')).OpenAiAdapter()
        : new (await import('../adapters/anthropic/client')).AnthropicAdapter();
    const tracker = this.deps.usage;
    const userId = this.deps.userId;
    const transport = this.deps.transport;
    const result = await this.deps.gateway.withExecutionOwner(async () =>
      (await import('../core/connection-test')).runConnectionTest(
        adapter,
        draft,
        {
          transport: this.deps.transport,
          apiKey,
          timeoutMs: draft.timeoutMs,
        },
        async function* (chat): AsyncIterable<StreamChunk> {
          const count = adapter.countTokens(chat.messages);
          const attempt = new AttemptRuntime(tracker, {
            userId,
            logicalRequestId: newUlid(),
            providerId: null,
            model: null,
            upstreamModelName: chat.model,
            protocol: draft.protocol,
            purpose: 'connection-test',
            context: {
              kind: 'sent_estimate',
              computedAt: Date.now(),
              estimatedNextInputTokens: count.tokens,
              routeWindowTokens: null,
              reservedOutputTokens: 1,
              safetyMarginTokens: count.margin,
              measuredSentInputTokens: null,
            },
          });
          let finished = false;
          try {
            for await (const chunk of adapter.chat(chat, {
              transport,
              apiKey,
              timeoutMs: draft.timeoutMs,
            })) {
              if (chunk.type === 'delta') attempt.output(chunk.text);
              if (chunk.type === 'usage') attempt.usage(chunk.metering, chunk.usage);
              if (chunk.type === 'error') throw chunk.error;
              if (chunk.type === 'done') {
                attempt.finish(chunk.finishReason, chunk.partial);
                finished = true;
              }
              yield chunk;
            }
          } catch (error) {
            attempt.finish('error', true, toAiError(error));
            finished = true;
            throw error;
          } finally {
            if (!finished) attempt.finish('stop', true);
          }
        },
      ),
    );
    return result;
  }

  /** 读取 Key：草稿引用优先从草稿命名空间取，已保存引用走正式命名空间 */
  private async readKey(keyRef: string | null, existingId?: string): Promise<string | null> {
    const keys = this.deps.providers.keyStore();
    if (keys && keyRef) {
      return keys.getByRef(keyRef);
    }
    return existingId ? this.deps.providers.getApiKey(existingId) : null;
  }

  /**
   * 把草稿 Key 写入本机密钥环（DPAPI），返回可跨 IPC 传递的引用名。
   *
   * 硬约束：明文 Key 只在这一次调用的入参里出现，之后一律用引用名指代；
   * RPC 参数、日志、SQLite 中都不保留明文（NFR-S-01）。
   */
  async persistApiKey(input: { keyRef?: string | null; apiKey: string }): Promise<string> {
    const keys = this.deps.providers.keyStore();
    if (!keys) throw new Error('密钥环不可用，无法保存 API Key');
    const ref =
      input.keyRef && input.keyRef.trim().length > 0 ? input.keyRef.trim() : tempKeyRefOf();
    if (!isTempKeyRef(ref)) {
      throw new Error('非法的 Key 引用名（只允许连接测试生成的临时引用）');
    }
    return keys.saveRef(ref, input.apiKey);
  }

  /** 丢弃「连接测试」写入的临时 Key（保存成功或用户取消时调用） */
  async discardTempKey(keyRef: string | null): Promise<void> {
    if (!keyRef) return;
    const keys = this.deps.providers.keyStore();
    if (!keys) return;
    await keys.discardTemp(keyRef);
  }

  /** 读取草稿 Key（仅连接测试使用） */
  async readDraftKey(keyRef: string): Promise<string | null> {
    const keys = this.deps.providers.keyStore();
    return keys ? keys.getByRef(keyRef) : null;
  }

  /* ----------------------------- 模型 ----------------------------- */

  listModels(providerId: string): Model[] {
    return this.deps.models.list(providerId);
  }

  listAllModels(): Model[] {
    return this.deps.models.listAll();
  }

  async refreshModels(providerId: string): Promise<Model[]> {
    await this.deps.gateway.refreshModels(providerId);
    return this.deps.models.list(providerId);
  }

  addManualModel(providerId: string, name: string): Model {
    // V2-MDL-02：同一条路由（Provider+模型名）幂等返回既有记录，不产生重复行；
    // 跨 Provider 的同名模型是不同路由，各自独立。
    return this.deps.models.createIfMissing(providerId, name.trim()).model;
  }

  updateCapability(modelId: string, patch: CapabilityPatch): Model | null {
    return this.deps.models.updateCapability(modelId, patch);
  }

  /* --------------------------- 用途绑定 --------------------------- */

  getBinding(): PurposeBinding {
    return this.deps.bindings.get(this.deps.userId);
  }

  saveBinding(binding: PurposeBinding): PurposeBinding {
    return this.deps.bindings.save(this.deps.userId, binding);
  }

  /* ----------------------------- 用量 ----------------------------- */

  monthlyUsage(): UsageTotals {
    return this.deps.usage.monthly(this.deps.userId);
  }

  usageByModel(): Array<{ modelId: string; totals: UsageTotals }> {
    return this.deps.usage.byModel(this.deps.userId);
  }

  budgetConfig(): ReturnType<BudgetGuard['getConfig']> {
    return this.deps.budget.getConfig();
  }

  setBudget(patch: Parameters<BudgetGuard['configure']>[0]): void {
    this.deps.budget.configure(patch);
  }

  /* ----------------------------- 限流 ----------------------------- */

  setLimits(providerId: string, limits: { qps?: number; concurrency?: number }): void {
    this.deps.queue.configure(providerId, limits);
  }

  /* ----------------------------- 代理 ----------------------------- */

  setProxy(proxy: ProxyConfig | string | null): void {
    this.deps.gateway.setProxy(typeof proxy === 'string' ? parseProxyUrl(proxy) : proxy);
  }

  testProxy(target?: { host: string; port?: number }): Promise<ProxyTestResult> {
    const proxy = this.deps.gateway.currentProxy();
    if (!proxy) return Promise.resolve({ ok: false, latencyMs: 0, message: '未配置代理' });
    return testProxyConnectivity(proxy, target);
  }

  /* --------------------------- 远程配置 --------------------------- */

  listRemoteSources(): RemoteConfigSource[] {
    return this.deps.remoteConfig.list(this.deps.userId);
  }

  createRemoteSource(input: {
    name: string;
    url: string;
    publicKey?: string | null;
    enabled?: boolean;
    updateIntervalMin?: number;
  }): RemoteConfigSource {
    return this.deps.remoteConfig.create({ userId: this.deps.userId, ...input });
  }

  updateRemoteSource(
    id: string,
    patch: {
      name?: string;
      url?: string;
      publicKey?: string | null;
      enabled?: boolean;
      updateIntervalMin?: number;
    },
  ): RemoteConfigSource | null {
    const before = this.deps.remoteConfig.findById(id);
    const updated = this.deps.remoteConfig.update(id, patch);
    // 换了地址或公钥：旧缓存不再可信（可能来自别的源、或当初未经这把公钥校验），必须作废，
    // 否则「签名错误不应用」可以被「先无公钥拉一次、再填公钥」绕过。
    if (
      updated &&
      before &&
      (before.url !== updated.url || (before.publicKey ?? null) !== (updated.publicKey ?? null))
    ) {
      return this.deps.remoteConfig.clearCache(id);
    }
    return updated;
  }

  removeRemoteSource(id: string): boolean {
    return this.deps.remoteConfig.remove(id);
  }

  /** 拉取；成功与失败都记录到 source，UI 直接读 lastStatus */
  async fetchRemoteSource(id: string): Promise<RemoteFetchResult> {
    const source = this.deps.remoteConfig.findById(id);
    if (!source) {
      const result: RemoteFetchResult = {
        ok: false,
        status: 'unreachable',
        document: null,
        latencyMs: 0,
        message: '配置源不存在',
      };
      return result;
    }
    const result = await fetchRemoteConfig(
      { url: source.url, ...(source.publicKey ? { publicKey: source.publicKey } : {}) },
      this.deps.transport,
    );
    this.deps.remoteConfig.recordFetch(id, {
      status: result.status,
      error: result.ok ? null : result.message,
      // 只缓存「校验通过 + 已剔除敏感头」的正文；失败时不动旧缓存（断网回退）
      ...(result.ok && result.document ? { payloadJson: result.document.cacheJson } : {}),
    });
    return result;
  }

  /** 差异预览：优先用本次拉取结果，拉取失败则用上次缓存 */
  async previewRemoteSource(id: string): Promise<{
    items: ConfigDiffItem[];
    summary: string;
    revision: string | null;
    plan?: ApplyPlan | null;
  }> {
    const source = this.deps.remoteConfig.findById(id);
    if (!source) return { items: [], summary: '配置源不存在', revision: null, plan: null };
    const payload = await this.payloadOf(source);
    if (!payload) return { items: [], summary: '尚未成功拉取过配置', revision: null, plan: null };
    const items = diffRemoteConfig(this.localSnapshots(), payload);
    const plan = planApply(payload, this.localSnapshots(), this.defaultRouteCompareOptions());
    return { items, summary: summarizeDiff(items), revision: payload.revision, plan };
  }

  /** 应用：本地优先，只创建本地没有的服务；返回计划供 UI 复核 */
  async applyRemoteSource(
    id: string,
    options: { overwriteLocal?: boolean; ackDefaultModel?: boolean } = {},
  ): Promise<ApplyPlan> {
    const source = this.deps.remoteConfig.findById(id);
    if (!source) throw new Error('配置源不存在');
    const payload = await this.payloadOf(source);
    if (!payload) throw new Error('尚未成功拉取过配置（或签名校验未通过），无法应用');
    return this.applyPayload(id, payload, options);
  }

  private async applyPayload(
    id: string,
    payload: RemoteConfigPayload,
    options: { overwriteLocal?: boolean; ackDefaultModel?: boolean },
  ): Promise<ApplyPlan> {
    const plan = planApply(payload, this.localSnapshots(), {
      ...this.defaultRouteCompareOptions(),
      ...(options.overwriteLocal ? { overwriteLocal: true } : {}),
    });

    for (const item of plan.items) {
      if (item.kind === 'create') {
        const created = await this.deps.providers.create({
          userId: this.deps.userId,
          name: item.config.name,
          protocol: item.config.protocol,
          // 远程目录/配置源创建的服务标记来源（V2-MDL-01）；同名 Provider 不与本地合并
          source: 'platform',
          baseUrl: item.config.baseUrl,
          headers: item.config.headers,
          timeoutMs: item.config.timeoutMs,
          supportsStream: item.config.supportsStream,
          supportsTools: item.config.supportsTools,
          supportsVision: item.config.supportsVision,
          enabled: true,
          order: this.deps.providers.list(this.deps.userId).length,
          manualModels: item.config.models,
        });
        this.ensureModels(created.id, item.config.models);
      } else if (item.kind === 'update') {
        // 用户显式选择「以远程覆盖本地」才会走到这里；Key、启用状态与目录来源始终保留本地值
        const local = this.deps.providers
          .list(this.deps.userId)
          .find((provider) => provider.name === item.name);
        if (!local) continue;
        await this.deps.providers.update(local.id, {
          protocol: item.config.protocol,
          baseUrl: item.config.baseUrl,
          headers: item.config.headers,
          timeoutMs: item.config.timeoutMs,
          supportsStream: item.config.supportsStream,
          supportsTools: item.config.supportsTools,
          supportsVision: item.config.supportsVision,
        });
        this.ensureModels(local.id, item.config.models);
      }
    }

    // 默认模型变更：用户已确认（或无需询问）才写入；且只在能**唯一定位路由**时绑定——
    // 同名模型分布在多个 Provider 时绝不按名字猜（V2-MDL-02/03），保持本地默认不变。
    if (plan.defaultModelChange) {
      const change = plan.defaultModelChange;
      if (options.ackDefaultModel) {
        const resolved = this.resolveDefaultModelRoute(change.after, change.providerName ?? null);
        if (resolved.status === 'applied' && resolved.model) {
          const binding = this.deps.bindings.get(this.deps.userId);
          this.deps.bindings.save(this.deps.userId, {
            ...binding,
            defaultModelId: resolved.model.id,
          });
          plan.defaultModelChange = {
            ...change,
            resolution: 'applied',
            providerModelId: resolved.model.providerModelId,
          };
        } else {
          plan.defaultModelChange = { ...change, resolution: resolved.status };
        }
      } else {
        plan.defaultModelChange = { ...change, resolution: 'pending' };
      }
    }

    this.deps.remoteConfig.recordFetch(id, {
      status: 'success',
      appliedRevision: payload.revision,
    });
    return plan;
  }

  /**
   * 远程默认模型名 → 本地路由的解析（V2-MDL-03）。
   *
   * - 名字只命中一个 Provider 的模型：绑定该路由；
   * - 命中多个 Provider（同名模型）：`ambiguous`，不猜，交给用户手动选择；
   * - 一个都命中不了：`missing`；
   * - 远程指名了 Provider 时**只在该 Provider 内解析**：命中不了就如实 missing——
   *   回退全局按名字绑定会把「B/same-model」悄悄绑到「A/same-model」，默认路由
   *   被静默改渠（V2-MDL-06，V2-D00）。
   */
  private resolveDefaultModelRoute(
    modelName: string,
    providerName: string | null,
  ): { status: 'applied' | 'ambiguous' | 'missing'; model: Model | null } {
    const candidates = this.deps.models.listAll().filter((model) => model.name === modelName);
    if (providerName) {
      const scoped = candidates.filter(
        (model) => this.deps.providers.findById(model.providerId)?.name === providerName,
      );
      if (scoped.length === 1) return { status: 'applied', model: scoped[0] ?? null };
      return { status: scoped.length > 1 ? 'ambiguous' : 'missing', model: null };
    }
    const providerIds = new Set(candidates.map((model) => model.providerId));
    if (providerIds.size === 1 && candidates.length === 1) {
      return { status: 'applied', model: candidates[0] ?? null };
    }
    return candidates.length > 1
      ? { status: 'ambiguous', model: null }
      : { status: 'missing', model: null };
  }

  private ensureModels(providerId: string, names: readonly string[]): void {
    for (const name of names) {
      // 幂等补齐：同路由已存在即跳过（V2-MDL-02 唯一路由）
      this.deps.models.createIfMissing(providerId, name);
    }
  }

  /** 拒绝本次默认模型更新：记录已读版本，后续不再弹窗 */
  ackRemoteRevision(id: string, revision: string): RemoteConfigSource | null {
    return this.deps.remoteConfig.ackRevision(id, revision);
  }

  /**
   * 启动时的静默刷新（FR-MDL-06）：失败用缓存、绝不抛错、不阻塞启动。
   *
   * 每个启用的源：拉取 →（成功且是新版本）按「本地优先」自动应用——只新增本地没有的服务，
   * 同名服务一律保留本地配置，默认模型**不**自动改，而是返回 `pendingDefaultModel`
   * 交给 UI 询问（FR-MDL-08；用户拒绝过的版本不再询问）。
   * 签名失败 / 格式不合法 / 不可达都不会触碰本地配置与旧缓存。
   */
  async refreshRemoteSourcesOnBoot(): Promise<BootRefreshItem[]> {
    const sources = this.deps.remoteConfig.enabledSources(this.deps.userId);
    const out: BootRefreshItem[] = [];
    for (const source of sources) {
      let result: RemoteFetchResult;
      try {
        result = await this.fetchRemoteSource(source.id);
      } catch (error) {
        result = {
          ok: false,
          status: 'unreachable',
          document: null,
          latencyMs: 0,
          message: error instanceof Error ? error.message : String(error),
        };
        this.deps.remoteConfig.recordFetch(source.id, {
          status: 'unreachable',
          error: result.message,
        });
      }

      let applied: BootRefreshItem['applied'] = null;
      let pendingDefaultModel: BootRefreshItem['pendingDefaultModel'] = null;
      const payload = result.ok ? (result.document?.payload ?? null) : null;
      if (payload) {
        try {
          if (payload.revision !== source.appliedRevision) {
            const plan = await this.applyPayload(source.id, payload, {});
            applied = {
              revision: plan.revision,
              created: plan.items.filter((item) => item.kind === 'create').map((item) => item.name),
              skipped: plan.items.filter((item) => item.kind === 'skip').map((item) => item.name),
            };
          }
          const plan = planApply(payload, this.localSnapshots(), this.defaultRouteCompareOptions());
          if (plan.defaultModelChange && source.ackedRevision !== payload.revision) {
            // 启动刷新从不自动改默认模型；同时探明该名字能否唯一定位路由，
            // 歧义时明确告知 UI（由用户手动选择，不按名字猜，V2-MDL-02/03）。
            const resolved = this.resolveDefaultModelRoute(
              plan.defaultModelChange.after,
              plan.defaultModelChange.providerName ?? null,
            );
            pendingDefaultModel = {
              ...plan.defaultModelChange,
              revision: payload.revision,
              ambiguous: resolved.status === 'ambiguous',
            };
          }
        } catch (error) {
          // 应用失败不影响启动；原因记在源上，设置页可见
          this.deps.remoteConfig.recordFetch(source.id, {
            status: 'invalid',
            error: `自动应用失败：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // 不回传整份文档：启动结果只给 UI 摘要，正文已在库里
      out.push({
        id: source.id,
        name: source.name,
        result: { ...result, document: null },
        usingCache: !result.ok && source.lastPayloadJson !== null,
        applied,
        pendingDefaultModel,
      });
    }
    return out;
  }

  /* ----------------------------- 容灾 / 限流 / 事件 ----------------------------- */

  failoverPolicy(): FailoverPolicy | null {
    return this.deps.failover?.getPolicy() ?? null;
  }

  setFailoverPolicy(patch: Partial<FailoverPolicy>): FailoverPolicy | null {
    this.deps.failover?.configure(patch);
    return this.failoverPolicy();
  }

  /** 各 Provider 当前生效的限流（未配置即不限） */
  limitsConfig(): Record<string, ProviderLimits> {
    const out: Record<string, ProviderLimits> = {};
    for (const provider of this.deps.providers.list(this.deps.userId)) {
      out[provider.id] = this.deps.queue.limitsOf(provider.id);
    }
    return out;
  }

  /** 最近的运维事件（已脱敏）：容灾切换、重试、预算拒绝、失败 */
  recentEvents(limit = 50): AiEventRecord[] {
    return this.deps.events?.recent(limit) ?? [];
  }

  /**
   * 可用性自检：没有配置时 UI 据此给出「下一步做什么」，而不是等用户点生成后才报错。
   */
  readiness(): AiReadiness {
    const providers = this.deps.providers.list(this.deps.userId);
    const enabled = providers.filter((provider) => provider.enabled);
    const withKey = enabled.filter((provider) => provider.keyRef !== null);
    const models = enabled.reduce(
      (total, provider) => total + this.deps.models.list(provider.id).length,
      0,
    );
    const purposes = AI_PURPOSES.filter((purpose) => purpose !== 'embedding').map((purpose) => {
      const described = this.deps.gateway.describeModel(this.deps.userId, purpose);
      return {
        purpose,
        label: PURPOSE_LABELS[purpose],
        modelName: described?.modelName ?? null,
        providerName: described?.providerName ?? null,
      };
    });
    const steps: AiReadiness['steps'] = [
      {
        id: 'provider',
        done: enabled.length > 0,
        label: '添加并启用一个模型服务（OpenAI / Anthropic 兼容中转均可）',
        action: '打开「设置 → 模型服务」，点击「新增服务」，填写协议与 Base URL',
      },
      {
        id: 'key',
        done: withKey.length > 0,
        label: '为模型服务填写 API Key（只保存在本机系统加密存储）',
        action: '在服务编辑页填写 API Key 后点击「连接测试」',
      },
      {
        id: 'model',
        done: models > 0,
        label: '至少有一个可用模型',
        action: '连接测试会自动拉取模型列表；中转不支持列举时可手工添加模型名',
      },
    ];
    return {
      ready: steps.every((step) => step.done),
      providers: providers.length,
      enabledProviders: enabled.length,
      providersWithKey: withKey.length,
      models,
      purposes,
      steps,
    };
  }

  /* ----------------------------- 内部 ----------------------------- */

  /**
   * 当前默认路由的（模型名, Provider 名）。远程配置按名字描述路由，默认配置的
   * 完整路由比较必须同一口径；只回传名字会漏检「同名模型换 Provider」的变化
   * （V2-MDL-02/06，V2-D00）。providerName 为 null 表示默认路由不存在或其
   * Provider 已查不到——此时只按名字比较，不猜路由变化。
   */
  private currentDefaultRouteName(): { modelName: string | null; providerName: string | null } {
    const id = this.deps.bindings.get(this.deps.userId).defaultModelId;
    const model = id ? this.deps.models.findById(id) : null;
    return {
      modelName: model?.name ?? null,
      providerName: model ? (this.deps.providers.findById(model.providerId)?.name ?? null) : null,
    };
  }

  /** 完整路由口径的 planApply 默认配置比较入参 */
  private defaultRouteCompareOptions() {
    const current = this.currentDefaultRouteName();
    return {
      currentDefaultModel: current.modelName,
      currentDefaultProviderName: current.providerName,
    };
  }

  private async payloadOf(source: RemoteConfigSource) {
    if (source.lastPayloadJson) {
      try {
        return parseRemoteConfig(source.lastPayloadJson).payload;
      } catch {
        return null;
      }
    }
    const result = await this.fetchRemoteSource(source.id);
    return result.document?.payload ?? null;
  }

  private localSnapshots() {
    return this.deps.providers.list(this.deps.userId).map((provider) => ({
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      models: this.deps.models.list(provider.id).map((model) => model.name),
      headers: provider.headers,
      timeoutMs: provider.timeoutMs,
    }));
  }
}

export type { CreateProviderInput, UpdateProviderInput };
