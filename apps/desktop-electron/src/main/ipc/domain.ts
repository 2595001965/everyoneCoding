import type { DomainControlServiceHost, DomainRpcRequest, DomainRpcResponse } from '@ec/shell-api';
import { domainErrorFromUnknown, domainUnavailableError } from '@ec/shell-api';
import { CHANNELS } from '../channels';
import type { IpcMainLike, IpcSenderLike, IpcSyncEventLike } from '../types';

/**
 * 领域端口 IPC：与 AI 通道同一做法 —— 单通道 + 主进程白名单分流。
 *
 * `describe` 与 `invoke` 分开注册：前者只回答「这个域装配好了没」，
 * 渲染层据此决定是否注入 `globalThis.__EC_*__`，不参与方法白名单。
 *
 * `invoke` 期间额外把 `event.sender` 注册进 `host.events`（键为 requestId），
 * 让域路由能把这**一次**请求的进度事件推回**发起它的**渲染进程，并在
 * `finally` 中注销：请求一结束就没有投递目标，不会留下悬空回调。
 *
 * `invokeSync` 是同步签名的端口（`MemoryApi` / `PipelineApi`）的专用口：
 * 渲染层 `sendSync` 会阻塞自己，主进程必须**同步**把 `event.returnValue` 填好。
 * 事件注册/注销与异步路径同构，只是注销改在下一拍（同步路由已跑完，
 * 事件经 sink 直接 `sender.send` 出去，不占 requestId 生命周期）。
 */
export function registerDomainIpc(ipc: IpcMainLike, host: DomainControlServiceHost): void {
  /**
   * 常驻下发（无请求归属的事件）。
   *
   * 请求内事件按 requestId 精确回给发起者（`send`）；而预览后端日志、外部改动监视器
   * 这类事件发生在请求**结束之后**，没有任何 requestId 可附着，由域侧调 `broadcast`。
   * 这里登记所有见过的 sender 作为常驻投递目标——否则那类事件会静默进黑洞，
   * 用户看到的表现是"日志面板永远是空的"。
   *
   * sender 不做主动清理：窗口销毁后 `send` 会抛错，捕获时顺手移除该目标。
   */
  const liveSenders = new Set<IpcSenderLike>();
  const trackSender = (sender: IpcSenderLike | undefined): void => {
    if (sender) liveSenders.add(sender);
  };
  host.events.subscribe((domainEvent) => {
    for (const sender of [...liveSenders]) {
      try {
        sender.send(CHANNELS.domain.event, domainEvent);
      } catch {
        // 窗口已销毁：丢弃该目标，不影响其它窗口
        liveSenders.delete(sender);
      }
    }
  });

  ipc.handle(CHANNELS.domain.invoke, async (event, payload) => {
    const request = payload as DomainRpcRequest;
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    const sender = (event as { sender?: IpcSenderLike } | null)?.sender;
    trackSender(sender);

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

  const on = ipc.on?.bind(ipc);
  if (on) {
    on(CHANNELS.domain.invokeSync, (rawEvent, rawPayload) => {
      const event = (rawEvent ?? {}) as IpcSyncEventLike;
      const request = rawPayload as DomainRpcRequest;
      const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
      const sender = event.sender;
      trackSender(sender);

      // 同步路径不返回 Promise：`invokeSync` 自身已把错误规整为 DomainRpcResponse，
      // 这里再兜一层 try/catch，确保任何意外都不会让渲染层的 sendSync 永远挂住。
      if (requestId.length === 0 || !sender) {
        event.returnValue = safeInvokeSync(host, request, requestId);
        return;
      }
      host.events.register(requestId, (domainEvent) => {
        sender.send(CHANNELS.domain.event, domainEvent);
      });
      event.returnValue = safeInvokeSync(host, request, requestId);
      setTimeout(() => host.events.unregister(requestId), 0);
    });
  }
}

function safeInvokeSync(
  host: DomainControlServiceHost,
  request: DomainRpcRequest,
  requestId: string,
): DomainRpcResponse {
  try {
    return host.invokeSync(request);
  } catch (error) {
    return { requestId, ok: false, error: domainErrorFromUnknown(error) };
  }
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
  ipc.on?.(CHANNELS.domain.invokeSync, (rawEvent) => {
    const event = (rawEvent ?? {}) as IpcSyncEventLike;
    event.returnValue = {
      requestId: 'unsupported',
      ok: false,
      error: domainUnavailableError(
        'workspace',
        'Electron 域运行时尚未接入主进程（同步域通道同样不可用）',
      ),
    } satisfies DomainRpcResponse;
  });
}
