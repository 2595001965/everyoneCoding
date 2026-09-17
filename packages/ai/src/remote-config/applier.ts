import type { Protocol } from '../domain/provider';
import type { RemoteConfigPayload, RemoteProviderConfig } from './fetcher';

/**
 * 远程配置的应用与差异预览（FR-MDL-08 / 13）。
 *
 * 优先级：**本地 > 远程默认**。
 * - 本地已存在的同名 Provider 不会被远程覆盖（只提示差异，由用户决定是否应用）
 * - 远程更新"默认模型"时弹窗询问；用户拒绝后记录 ackedRevision，同版本不再打扰
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
  /** 与本地不同的默认模型：为 null 表示无需询问 */
  defaultModelChange: { before: string | null; after: string } | null;
}

export function planApply(
  payload: RemoteConfigPayload,
  locals: readonly LocalProviderSnapshot[],
  options: { currentDefaultModel?: string | null; overwriteLocal?: boolean } = {},
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

  const incomingDefault = payload.providers.find((provider) => provider.defaultModel)?.defaultModel ?? null;
  const currentDefault = options.currentDefaultModel ?? null;
  const defaultModelChange =
    incomingDefault && incomingDefault !== currentDefault ? { before: currentDefault, after: incomingDefault } : null;

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
