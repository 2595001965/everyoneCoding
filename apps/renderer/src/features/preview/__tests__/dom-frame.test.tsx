import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewFrame } from '../PreviewFrame';
const session = {
  projectId: 'p-1',
  runtimeId: 'run-1',
  nonce: 'nonce-1',
  parentOrigin: 'http://localhost:5173',
};
describe('D03 iframe identity and document lifecycle', () => {
  it('accepts only current iframe, session, strict payload and increasing document sequence', () => {
    const receive = vi.fn();
    const { rerender } = render(
      <PreviewFrame src="http://localhost:4173" session={session} onEvent={receive} />,
    );
    const source = (screen.getByTestId('preview-frame') as HTMLIFrameElement).contentWindow!;
    const base = {
      channel: 'ec-dom-v1',
      projectId: 'p-1',
      runtimeId: 'run-1',
      nonce: 'nonce-1',
      documentId: 'doc-1',
      seq: 1,
      type: 'ready',
      payload: null,
    };
    const send = (data: unknown, origin = 'null', sender: Window = source) =>
      window.dispatchEvent(new MessageEvent('message', { data, origin, source: sender }));
    send(base, 'null', window);
    send(base, 'http://localhost:4173');
    send({ ...base, nonce: 'forged' });
    expect(receive).not.toHaveBeenCalled();
    send(base);
    expect(receive).toHaveBeenCalledTimes(1);
    send(base);
    send({ ...base, seq: 2, type: 'mode', payload: { currentValue: 'secret' } });
    expect(receive).toHaveBeenCalledTimes(1);
    send({ ...base, seq: 2, type: 'mode', payload: true });
    expect(receive).toHaveBeenCalledTimes(2);
    send({ ...base, documentId: 'doc-2' });
    expect(receive).toHaveBeenCalledTimes(3);
    send({ ...base, seq: 3, type: 'mode', payload: true });
    expect(receive).toHaveBeenCalledTimes(3);
    rerender(
      <PreviewFrame
        src="http://localhost:4174"
        session={{ ...session, runtimeId: 'run-2', nonce: 'nonce-2' }}
        onEvent={receive}
      />,
    );
    send({ ...base, documentId: 'doc-3' });
    expect(receive).toHaveBeenCalledTimes(3);
  });
});
