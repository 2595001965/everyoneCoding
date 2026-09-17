import type { DomainControlServiceHost, DomainRpcRequest, DomainRpcResponse } from '@ec/shell-api';
import { CHANNELS } from '../channels';
import type { IpcMainLike } from '../types';

/**
 * 领域端口 IPC：与 AI 通道同一做法 —— 单通道 + 主进程白名单分流。
 *
 * `describe` 与 `invoke` 分开注册：前者只回答「这个域装配好了没」，
 * 渲染层据此决定是否注入 `globalThis.__EC_*__`，不参与方法白名单。
 */
export function registerDomainIpc(ipc: IpcMainLike, host: DomainControlServiceHost): void {
  ipc.handle(CHANNELS.domain.invoke, (_event, payload) => host.invoke(payload as DomainRpcRequest));
  ipc.handle(CHANNELS.domain.describe, () => host.describe());
}

/** 未装配域运行时时的兜底：四域全部如实回答不可用，invoke 一律 NOT_SUPPORTED */
export function registerUnavailableDomainIpc(ipc: IpcMainLike): void {
  ipc.handle(CHANNELS.domain.invoke, async (_event, payload) => {
    const request = payload as Partial<DomainRpcRequest> | undefined;
    return {
      requestId: typeof request?.requestId === 'string' ? request.requestId : 'unsupported',
      ok: false,
      error: { code: 'NOT_SUPPORTED', message: 'Electron 域运行时尚未接入主进程' },
    } satisfies DomainRpcResponse;
  });
  ipc.handle(CHANNELS.domain.describe, async () => []);
}
