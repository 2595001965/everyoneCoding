import type { Protocol } from '../domain/provider';
import type { RemoteConfigPayload, RemoteProviderConfig } from './fetcher';

/**
 * 远程配置的应用与差异预览（FR-MDL-08 / 13）。
 *
 * 优先级：**本地 > 远程默认**。
 * - 本地已存在的同名 Provider 不会被远程覆盖（只提示差异，由用户决定是否应用）
 * - 远程更新"默认模型"时弹窗询问；默认配置按**完整路由**（模型名 + 声明渠道）比较——
 *   同名模型换 Provider（A/x → B/x）同样提示确认，不因名字相同漏报（V2-D00）
 * - 用户拒绝后记录 ackedRevision，同版本不再打扰
 * - API Key 永远不来自远程配置（安全红线）
 */

export interface LocalProviderSnapshot {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  models: string[];
  headers: Record<string, string>;
  timeoutMs: number;
}

export type DiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface ConfigDiffItem {
  kind: DiffKind;
  /** 差异路径，如 `providers[0].baseUrl` */
  path: string;
  label: string;
  before?: string;
  after?: string;
}

export function diffRemoteConfig(
  locals: readonly LocalProviderSnapshot[],
  payload: RemoteConfigPayload,
): ConfigDiffItem[] {
  const items: ConfigDiffItem[] = [];
  const localByName = new Map(locals.map((provider) => [provider.name, provider]));

  payload.providers.forEach((remote, index) => {
    const local = localByName.get(remote.name);
    if (!local) {
      items.push({
        kind: 'added',
        path: `providers[${index}]`,
        label: `新增服务 ${remote.name}`,
        after: `${remote.protocol} · ${remote.baseUrl}`,
      });
      return;
    }
    if (local.protocol !== remote.protocol) {
      items.push({
        kind: 'changed',
        path: `providers[${index}].protocol`,
        label: `${remote.name} 协议`,
        before: local.protocol,
        after: remote.protocol,
      });
    }
    if (normalizeUrl(local.baseUrl) !== normalizeUrl(remote.baseUrl)) {
      items.push({
        kind: 'changed',
        path: `providers[${index}].baseUrl`,
        label: `${remote.name} 地址`,
        before: local.baseUrl,
        after: remote.baseUrl,
      });
    }
    if (local.timeoutMs !== remote.timeoutMs) {
      items.push({
        kind: 'changed',
        path: `providers[${index}].timeoutMs`,
        label: `${remote.name} 超时`,
        before: `${local.timeoutMs}ms`,
        after: `${remote.timeoutMs}ms`,
      });
    }
    const missingModels = remote.models.filter((model) => !local.models.includes(model));
    if (missingModels.length > 0) {
      items.push({
        kind: 'changed',
        path: `providers[${index}].models`,
        label: `${remote.name} 新增模型`,
        after: missingModels.join('、'),
      });
    }
  });

  const remoteNames = new Set(payload.providers.map((provider) => provider.name));
  locals.forEach((local, index) => {
    if (!remoteNames.has(local.name)) {
      items.push({
        kind: 'removed',
        path: `providers[${index}]`,
        label: `远程配置中不再包含 ${local.name}`,
        before: local.baseUrl,
      });
    }
  });

  return items;
}

export type ApplyKind = 'create' | 'update' | 'skip';

export interface ApplyPlanItem {
  kind: ApplyKind;
  name: string;
  config: RemoteProviderConfig;
  /** skip 时说明原因（本地优先等） */
  reason?: string;
}

export interface ApplyPlan {
  revision: string;
  items: ApplyPlanItem[];
  defaultModel: string | null;
  /**
   * 与本地不同的默认模型：为 null 表示无需询问。
   * `providerName` 标记该默认模型声明自哪个远程 Provider（全局默认时为 null）；
   * `providerSwitch` 非空表示**模型名未变、默认路由仅换了渠道**（A/x → B/x）——
   * 名字相同不等于路由相同，必须提示用户确认，不能漏报（V2-MDL-02/06，V2-D00）。
   * 是否真的绑定由服务层按「能否唯一定位路由」决定——同名模型分布在多个 Provider 时
   * 绝不按名字猜（V2-MDL-02/03）。
   */
  defaultModelChange: {
    before: string | null;
    after: string;
    providerName?: string | null;
    /** 仅渠道切换时非空：from=当前默认路由的渠道名，to=远程声明渠道名 */
    providerSwitch?: { from: string; to: string } | null;
    /** 服务层回填：applied=已绑定；pending=等用户确认；ambiguous/missing=同名多路由/无处解析，未绑定 */
    resolution?: 'applied' | 'pending' | 'ambiguous' | 'missing';
    providerModelId?: string | null;
  } | null;
}

export function planApply(
  payload: RemoteConfigPayload,
  locals: readonly LocalProviderSnapshot[],
  /**
   * currentDefaultModel 是**模型名**（与远程配置同一口径），不是本地 model.id；
   * currentDefaultProviderName 是当前默认模型行所属 Provider 的名字（服务层从
   * model 行反查）。缺省/未知时只按名字比较（无法判定路由变化时不猜）。
   */
  options: {
    currentDefaultModel?: string | null;
    currentDefaultProviderName?: string | null;
    overwriteLocal?: boolean;
  } = {},
): ApplyPlan {
  const localByName = new Map(locals.map((provider) => [provider.name, provider]));
  const items: ApplyPlanItem[] = payload.providers.map((remote) => {
    const local = localByName.get(remote.name);
    if (!local) return { kind: 'create' as const, name: remote.name, config: remote };
    if (!options.overwriteLocal) {
      return {
        kind: 'skip' as const,
        name: remote.name,
        config: remote,
        reason: '本地已存在同名服务，按"本地优先"规则保留本地配置',
      };
    }
    return { kind: 'update' as const, name: remote.name, config: remote };
  });

  // 全局 defaultModel 优先；否则取第一个声明了 defaultModel 的 Provider（并记录出处）
  const scopedDefault = payload.providers.find((provider) => provider.defaultModel);
  const incomingDefault = payload.defaultModel ?? scopedDefault?.defaultModel ?? null;
  const incomingProviderName = payload.defaultModel ? null : (scopedDefault?.name ?? null);
  const currentDefault = options.currentDefaultModel ?? null;
  const currentProviderName = options.currentDefaultProviderName ?? null;
  // 默认配置比较**完整路由**（模型名 + 声明渠道），不是只比名字：
  // - 名字不同 → 普通默认模型变更；
  // - 名字相同、渠道不同（A/x → B/x）→ 渠道切换，同样必须提示确认（V2-D00 反例）；
  // - 名字相同、任一侧缺渠道身份 → 无法判定路由变化，保持原配置不猜。
  const nameChanged = incomingDefault !== null && incomingDefault !== currentDefault;
  const providerSwitch =
    incomingDefault !== null &&
    !nameChanged &&
    incomingProviderName !== null &&
    currentProviderName !== null &&
    incomingProviderName !== currentProviderName
      ? { from: currentProviderName, to: incomingProviderName }
      : null;
  const defaultModelChange =
    incomingDefault !== null && (nameChanged || providerSwitch !== null)
      ? {
          before: currentDefault,
          after: incomingDefault,
          providerName: incomingProviderName,
          ...(providerSwitch ? { providerSwitch } : {}),
        }
      : null;

  return {
    revision: payload.revision,
    items,
    defaultModel: incomingDefault,
    defaultModelChange,
  };
}

/** 摘要文本：UI 在未展开差异时展示一行概览 */
export function summarizeDiff(items: readonly ConfigDiffItem[]): string {
  const added = items.filter((item) => item.kind === 'added').length;
  const changed = items.filter((item) => item.kind === 'changed').length;
  const removed = items.filter((item) => item.kind === 'removed').length;
  if (items.length === 0) return '与本地配置一致，无需变更';
  return `新增 ${added} 项 · 修改 ${changed} 项 · 移除 ${removed} 项`;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}
