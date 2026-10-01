import { createRoot } from 'react-dom/client';
import { createElectronShell } from '../../apps/desktop-electron/src/bridge';
import { createDomainCaller } from '../../apps/renderer/src/runtime/domain-ports';
import {
  createDomainSyncCaller,
  createPipelineApi,
} from '../../apps/renderer/src/runtime/production-ports';
import { useProjectStore } from '../../apps/renderer/src/store/useProjectStore';
import { PipelinePage } from '../../apps/renderer/src/pages/PipelinePage';
import '@ec/ui/tokens.css';
import '@ec/ui/styles.css';
import '../../apps/renderer/src/features/pipeline/pipeline.css';

async function start(): Promise<void> {
  const shell = createElectronShell();
  const call = createDomainCaller(shell.domain!);
  const projectId = new URLSearchParams(location.search).get('projectId')!;
  const project = await call.call<{ id: string; name: string }>('workspace', 'getProject', {
    id: projectId,
  });
  useProjectStore
    .getState()
    .openProject({ ...project, targetPlatforms: ['web'], updatedAt: Date.now() });
  const api = createPipelineApi(call, createDomainSyncCaller(shell.domain!), (fn) =>
    shell.domain!.onEvent!(fn),
  );
  Object.assign(globalThis, { __EC_PIPELINE__: api, __EC_USER_ID__: 'local-user' });
  createRoot(document.getElementById('root')!).render(
    <>
      <button
        id="design-page"
        onClick={() => {
          void call
            .call('designer', 'createPage', {
              projectId,
              input: { name: '任务列表', route: '/tasks', platform: 'web' },
            })
            .then(() => {
              document.getElementById('design-page')!.textContent = '设计页已保存';
            });
        }}
      >
        添加设计页
      </button>
      <PipelinePage />
    </>,
  );
}
void start().catch((error: unknown) => {
  document.body.textContent = String(error);
});
