import type { DomainControlServiceHost, DomainRpcRequest, DomainRpcResponse } from '@ec/shell-api';
import { CHANNELS } from '../channels';
import type { IpcMainLike, IpcSenderLike } from '../types';

/**
 * 领域端口 IPC：与 AI 通道同一做法 —— 单通道 + 主进程白名单分流。
 *
 * `describe` 与 `invoke` 分开注册：前者只回答「这个域装配好了没」，
 * 渲染层据此决定是否注入 `globalThis.__EC_*__`，不参与方法白名单。
 *
 * `invoke` 期间额外把 `event.sender` 注册进 `host.events`（键为 requestId），
 * 让域路由能把这**一次**请求的进度事件推回**发起它的**渲染进程，并在
 * `finally` 中注销：请求一结束就没有投递目标，不会留下悬空回调。
 */
export function registerDomainIpc(ipc: IpcMainLike, host: DomainControlServiceHost): void {
  ipc.handle(CHANNELS.domain.invoke, async (event, payload) => {
    const request = payload as DomainRpcRequest;
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    const sender = (event as { sender?: IpcSenderLike } | null)?.sender;

    if (requestId.length === 0 || !sender) return await host.invoke(request);

    host.events.register(requestId, (domainEvent) => {
      sender.send(CHANNELS.domain.event, domainEvent);
    });
    try {
      return await host.invoke(request);
    } finally {
      host.events.unregister(requestId);
    }
  });
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
