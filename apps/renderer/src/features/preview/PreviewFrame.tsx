import * as React from 'react';
import { readDomEvent, type DomEvent, type DomSession } from '@ec/preview';
import type { ApiRequestLog } from './preview-api';

export interface PreviewFrameProps {
  src: string;
  title?: string | undefined;
  session?: DomSession | null | undefined;
  selecting?: boolean | undefined;
  pickNodeId?: string | null | undefined;
  onEvent?: ((event: DomEvent) => void) | undefined;
  onRequest?: ((log: ApiRequestLog) => void) | undefined;
  onElementClick?: ((payload: { elementId: string }) => void) | undefined;
}

/** Preview content has an opaque origin and no host privileges. Legacy unvalidated events are rejected. */
export function PreviewFrame({
  src,
  title,
  session,
  selecting = false,
  pickNodeId,
  onEvent,
  onElementClick,
}: PreviewFrameProps): JSX.Element {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const callbacks = React.useRef({ onEvent, onElementClick });
  callbacks.current = { onEvent, onElementClick };
  const [documentId, setDocumentId] = React.useState<string | null>(null);
  const active = React.useRef<{ documentId: string | null; seq: number; retired: Set<string> }>({
    documentId: null,
    seq: 0,
    retired: new Set(),
  });
  const hello = React.useCallback((): void => {
    if (session) frame.current?.contentWindow?.postMessage({ ...session, channel: 'ec-dom-v1', type: 'hello', payload: null }, '*');
  }, [session]);
  React.useEffect(() => {
    active.current = { documentId: null, seq: 0, retired: new Set() };
    setDocumentId(null);
    if (!session) return;
    const handler = (event: MessageEvent): void => {
      const message = readDomEvent(event, frame.current?.contentWindow ?? null, session);
      if (!message) return;
      const state = active.current;
      if (message.type === 'ready') {
        if (
          message.seq !== 1 ||
          state.retired.has(message.documentId) ||
          state.documentId === message.documentId
        )
          return;
        if (state.documentId) state.retired.add(state.documentId);
        state.documentId = message.documentId;
        state.seq = 0;
        setDocumentId(message.documentId);
      }
      if (message.documentId !== state.documentId || message.seq <= state.seq) return;
      state.seq = message.seq;
      callbacks.current.onEvent?.(message);
      if (message.type === 'selection')
        callbacks.current.onElementClick?.({ elementId: message.payload.node.nodeId });
    };
    window.addEventListener('message', handler);
    hello();
    return () => window.removeEventListener('message', handler);
  }, [src, session, hello]);
  React.useEffect(() => {
    if (!session || !documentId) return;
    frame.current?.contentWindow?.postMessage(
      { ...session, channel: 'ec-dom-v1', documentId, type: 'mode', payload: selecting },
      '*',
    );
  }, [session, documentId, selecting]);
  React.useEffect(() => {
    if (!session || !documentId || !pickNodeId) return;
    frame.current?.contentWindow?.postMessage(
      { ...session, channel: 'ec-dom-v1', documentId, type: 'pick', payload: pickNodeId },
      '*',
    );
  }, [session, documentId, pickNodeId]);
  return (
    <iframe
      ref={frame}
      className="ec-preview-frame"
      data-testid="preview-frame"
      title={title ?? '预览'}
      src={src}
      onLoad={hello}
      sandbox="allow-scripts allow-forms"
    />
  );
}
