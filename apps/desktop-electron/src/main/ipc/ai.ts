import type { IpcMainLike } from '../types';
import { CHANNELS } from '../channels';
import type {
  AiControlServiceHost,
  AiRpcRequest,
  AiStreamEvent,
  AiStreamRequest,
} from '@ec/shell-api';

/** AI IPC：RPC 白名单由 runtime 再校验；流式仅传 requestId + 可克隆事件。 */
export function registerAiIpc(ipc: IpcMainLike, host: AiControlServiceHost): void {
  ipc.handle(CHANNELS.ai.invoke, (_event, payload) => host.invoke(payload as AiRpcRequest));
  ipc.handle(CHANNELS.ai.abort, async (_event, payload) => {
    const requestId = (payload as { requestId?: unknown })?.requestId;
    if (typeof requestId === 'string' && requestId.length > 0) host.abort(requestId);
  });
  ipc.handle(CHANNELS.ai.start, async (event, payload) => {
    const request = payload as AiStreamRequest;
    if (!request || typeof request.requestId !== 'string') return;
    const sender = (event as { sender?: { send(channel: string, payload: unknown): void } }).sender;
    host.stream(request, (streamEvent: AiStreamEvent) => {
      sender?.send(CHANNELS.ai.stream, { requestId: request.requestId, event: streamEvent });
    });
  });
}
