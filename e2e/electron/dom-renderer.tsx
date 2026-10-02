import { createRoot } from 'react-dom/client';
import { createElectronShell } from '../../apps/desktop-electron/src/bridge';
import { createDomainCaller } from '../../apps/renderer/src/runtime/domain-ports';
import { createPreviewApi } from '../../apps/renderer/src/runtime/production-ports';
import { useProjectStore } from '../../apps/renderer/src/store/useProjectStore';
import { PreviewApiProvider } from '../../apps/renderer/src/features/preview/preview-api';
import { DomInspector } from '../../apps/renderer/src/features/preview/DomInspector';
import { PreviewFrame } from '../../apps/renderer/src/features/preview/PreviewFrame';
import type { DomSession } from '@ec/preview';
import { useNavLocation } from '../../apps/renderer/src/runtime/nav-location';

async function start(): Promise<void> {
  const shell = createElectronShell();
  const caller = createDomainCaller(shell.domain!);
  const projectId = new URLSearchParams(location.search).get('projectId')!;
  useProjectStore.getState().openProject({
    id: projectId,
    name: 'DOM 真实页',
    targetPlatforms: ['web'],
    updatedAt: Date.now(),
  });
  const api = createPreviewApi(caller, (listener) => shell.domain!.onEvent!(listener));
  const state = await api.state();
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <PreviewApiProvider api={api}>
      <DomInspector src={state.url!} runtimeId={state.runtimeId ?? null} />
    </PreviewApiProvider>,
  );
  Object.assign(window, {
    __testInspect: (id: string, src: string, runtimeId: string) => {
      useProjectStore.getState().openProject({
        id,
        name: 'Vite 生产选取',
        targetPlatforms: ['web'],
        updatedAt: Date.now(),
      });
      Object.assign(window, { __domEvents: [] });
      root.render(
        <PreviewApiProvider api={api}>
          <DomInspector key={id} src={src} runtimeId={runtimeId} />
        </PreviewApiProvider>,
      );
    },
    __testSwitch: (src: string, session: DomSession) => {
      const events: unknown[] = [];
      Object.assign(window, { __domEvents: events });
      root.render(
        <PreviewFrame
          key={src}
          src={src}
          session={session}
          selecting
          onEvent={(event) => {
            events.push(event);
            Object.assign(window, { __lastEvent: event });
          }}
        />,
      );
    },
    __lastEvent: null,
    __testNavTarget: () => useNavLocation.getState().target,
  });
  window.addEventListener('message', (event) => {
    // Test observation only; the production component independently validates all messages.
    if (event.data?.channel === 'ec-dom-v1') {
      Object.assign(window, { __lastEvent: event.data });
      const events = (window as unknown as { __domEvents?: unknown[] }).__domEvents;
      events?.push(event.data);
    }
  });
}
void start().catch((error: unknown) => {
  document.body.textContent = String(error);
});
