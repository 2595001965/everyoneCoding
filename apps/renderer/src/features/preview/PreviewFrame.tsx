import * as React from 'react';

import type { ApiRequestLog } from './preview-api';

/**
 * T6-05 预览帧：把选中的页面路由嵌进 iframe，并接收来自预览页的宿主消息。
 *
 * 两类消息：
 * - `{ type: 'preview-request', payload: ApiRequestLog }` → 触发 `onRequest`（供 API 调试器聚合）
 * - `{ type: 'element-click', payload: { elementId } }` → 触发 `onElementClick`（联动导航跳转）
 *
 * iframe 采用受限 sandbox（仅允许脚本执行，不授予同源等危险权限），
 * 预览页通过 postMessage 与宿主通信。
 */
export interface PreviewFrameProps {
  src: string;
  title?: string | undefined;
  onRequest?: ((log: ApiRequestLog) => void) | undefined;
  onElementClick?: ((payload: { elementId: string }) => void) | undefined;
}

type IncomingMessage =
  | { type: 'preview-request'; payload: ApiRequestLog }
  | { type: 'element-click'; payload: { elementId: string } };

function isIncoming(data: unknown): data is IncomingMessage {
  if (typeof data !== 'object' || data === null) return false;
  const t = (data as { type?: unknown }).type;
  return t === 'preview-request' || t === 'element-click';
}

export function PreviewFrame({ src, title, onRequest, onElementClick }: PreviewFrameProps): JSX.Element {
  // 用 ref 持有最新回调，避免每次渲染重建监听器
  const onRequestRef = React.useRef(onRequest);
  const onElementClickRef = React.useRef(onElementClick);
  React.useEffect(() => {
    onRequestRef.current = onRequest;
    onElementClickRef.current = onElementClick;
  }, [onRequest, onElementClick]);

  React.useEffect(() => {
    const handler = (event: MessageEvent): void => {
      const data = event.data;
      if (!isIncoming(data)) return;
      if (data.type === 'preview-request') {
        onRequestRef.current?.(data.payload);
      } else if (data.type === 'element-click') {
        onElementClickRef.current?.(data.payload);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <iframe
      className="ec-preview-frame"
      data-testid="preview-frame"
      title={title ?? '预览'}
      src={src}
      sandbox="allow-scripts"
    />
  );
}
