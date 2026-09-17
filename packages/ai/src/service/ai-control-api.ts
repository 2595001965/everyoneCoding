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
import type { UsageTotals } from '../repo/usage-repo';
import { fetchRemoteConfig, parseRemoteConfig, type RemoteFetchResult } from '../remote-config/fetcher';
import { diffRemoteConfig, planApply, summarizeDiff, type ApplyPlan, type ConfigDiffItem } from '../remote-config/applier';
import { parseCreateProvider, type CreateProviderInput } from '../dto/create-provider';
import { parseUpdateProvider, type UpdateProviderInput } from '../dto/update-provider';
import { parseProxyUrl, testProxyConnectivity, type ProxyTestResult } from '../gateway/proxy';
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
}

export class AiControlService {
  constructor(private readonly deps: AiControlDeps) {}

  /* ---------------------------- Provider ---------------------------- */

  listProviders(): Provider[] {
    return this.deps.providers.list(this.deps.userId);
  }

  /** 新建 Provider；userId 由服务注入，UI 不需要知道 */
  async createProvider(input: Omit<CreateProviderInput, 'userId'>): Promise<Provider> {
    const created = await this.deps.providers.create(parseCreateProvider({ ...input, userId: this.deps.userId }));
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
      if (!this.deps.models.findByName(providerId, name)) this.deps.models.create(providerId, name);
    }
    const binding = this.deps.bindings.get(this.deps.userId);
    const bound = new Set(Object.values(binding.bindings).filter((id): id is string => typeof id === 'string'));
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
    return this.deps.gateway.testConnection(providerId);
  }

  /**
   * 用「连接测试」临时写入的草稿 Key 试连（尚未保存的 Provider）。
   *
   * @param keyRef 渲染层写入 secureStore 后拿到的引用名；为 null 时回落到已保存 Key（编辑场景）
   */
  async testDraftConnection(input: Omit<CreateProviderInput, 'userId'>, keyRef: string | null = null): Promise<ConnectionTestResult> {
    const provider = parseCreateProvider({ ...input, userId: this.deps.userId });
    const raw = input as unknown as { id?: unknown };
    const existingId = typeof raw.id === 'string' ? raw.id : undefined;
    const existing = existingId ? this.deps.providers.findById(existingId) : null;
    let resolvedRef: string | null = keyRef;
    if (!resolvedRef && existing) resolvedRef = existing.keyRef;
    const draft = {
... (existing ?? {}), id: existing?.id ?? `draft-${Date.now()}`, userId: this.deps.userId,
      name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl,
      headers: provider.headers, timeoutMs: provider.timeoutMs, supportsStream: provider.supportsStream,
      supportsTools: provider.supportsTools, supportsVision: provider.supportsVision,
      enabled: provider.enabled, order: provider.order, manualModels: provider.manualModels,
      keyRef: resolvedRef, version: existing?.version ?? 1, createdAt: 0, updatedAt: 0,
    } as Provider;
    const apiKey = await this.readKey(resolvedRef, existingId);
    const adapter = draft.protocol === 'openai'
      ? new (await import('../adapters/openai/client')).OpenAiAdapter()
      : new (await import('../adapters/anthropic/client')).AnthropicAdapter();
    return (await import('../core/connection-test')).runConnectionTest(
      adapter,
      draft,
      { transport: this.deps.transport, apiKey, timeoutMs: draft.timeoutMs },
    );
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
    const ref = input.keyRef && input.keyRef.trim().length > 0
      ? input.keyRef.trim()
      : tempKeyRefOf();
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
    return this.deps.models.create(providerId, name);
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

  createRemoteSource(input: { name: string; url: string; publicKey?: string | null; enabled?: boolean; updateIntervalMin?: number }): RemoteConfigSource {
    return this.deps.remoteConfig.create({ userId: this.deps.userId, ...input });
  }

  updateRemoteSource(
    id: string,
    patch: { name?: string; url?: string; publicKey?: string | null; enabled?: boolean; updateIntervalMin?: number },
  ): RemoteConfigSource | null {
    return this.deps.remoteConfig.update(id, patch);
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
      ...(result.ok && result.document ? { payloadJson: result.document.raw } : {}),
    });
    return result;
  }

  /** 差异预览：优先用本次拉取结果，拉取失败则用上次缓存 */
  async previewRemoteSource(id: string): Promise<{ items: ConfigDiffItem[]; summary: string; revision: string | null; plan?: ApplyPlan | null }> {
    const source = this.deps.remoteConfig.findById(id);
    if (!source) return { items: [], summary: '配置源不存在', revision: null, plan: null };
    const payload = await this.payloadOf(source);
    if (!payload) return { items: [], summary: '尚未成功拉取过配置', revision: null, plan: null };
    const items = diffRemoteConfig(this.localSnapshots(), payload);
    const plan = planApply(payload, this.localSnapshots(), {
      currentDefaultModel: this.deps.bindings.get(this.deps.userId).defaultModelId,
    });
    return { items, summary: summarizeDiff(items), revision: payload.revision, plan };
  }

  /** 应用：本地优先，只创建本地没有的服务；返回计划供 UI 复核 */
  async applyRemoteSource(id: string, options: { overwriteLocal?: boolean; ackDefaultModel?: boolean } = {}): Promise<ApplyPlan> {
    const source = this.deps.remoteConfig.findById(id);
    if (!source) throw new Error('配置源不存在');
    const payload = await this.payloadOf(source);
    if (!payload) throw new Error('尚未成功拉取过配置，无法应用');

    const plan = planApply(payload, this.localSnapshots(), {
      currentDefaultModel: this.deps.bindings.get(this.deps.userId).defaultModelId,
      ...(options.overwriteLocal ? { overwriteLocal: true } : {}),
    });

    for (const item of plan.items) {
      if (item.kind === 'create') {
        const created = await this.deps.providers.create({
          userId: this.deps.userId,
          name: item.config.name,
          protocol: item.config.protocol,
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
        for (const modelName of item.config.models) {
          this.deps.models.create(created.id, modelName);
        }
      }
    }

    // 默认模型变更：用户已确认（或无需询问）才写入
    if (plan.defaultModelChange && options.ackDefaultModel) {
      const binding = this.deps.bindings.get(this.deps.userId);
      const model = this.deps.models.listAll().find((item) => item.name === plan.defaultModelChange?.after);
      if (model) this.deps.bindings.save(this.deps.userId, { ...binding, defaultModelId: model.id });
    }

    this.deps.remoteConfig.recordFetch(id, { status: 'success', appliedRevision: payload.revision });
    return plan;
  }

  /** 拒绝本次默认模型更新：记录已读版本，后续不再弹窗 */
  ackRemoteRevision(id: string, revision: string): RemoteConfigSource | null {
    return this.deps.remoteConfig.ackRevision(id, revision);
  }

  /** 启动时的静默刷新：失败用缓存、绝不抛错、不阻塞启动 */
  async refreshRemoteSourcesOnBoot(): Promise<Array<{ id: string; result: RemoteFetchResult }>> {
    const sources = this.deps.remoteConfig.enabledSources(this.deps.userId);
    const out: Array<{ id: string; result: RemoteFetchResult }> = [];
    for (const source of sources) {
      try {
        out.push({ id: source.id, result: await this.fetchRemoteSource(source.id) });
      } catch (error) {
        out.push({
          id: source.id,
          result: {
            ok: false,
            status: 'unreachable',
            document: null,
            latencyMs: 0,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    return out;
  }

  /* ----------------------------- 内部 ----------------------------- */

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
