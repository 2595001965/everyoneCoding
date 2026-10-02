import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { createElectronShell } from '../../apps/desktop-electron/src/bridge';
import { createDomainCaller } from '../../apps/renderer/src/runtime/domain-ports';
import {
  createApiIndexApi,
  createCodeApi,
  createNavApi,
} from '../../apps/renderer/src/runtime/production-ports';
import { useProjectStore } from '../../apps/renderer/src/store/useProjectStore';
import { useNavLocation } from '../../apps/renderer/src/runtime/nav-location';
import { ApiWorkbench } from '../../apps/renderer/src/features/api-index/ApiWorkbench';
import { CodeViewProvider } from '../../apps/renderer/src/features/code/code-api';
import { CodeView } from '../../apps/renderer/src/features/code/CodeView';
import '@ec/ui/tokens.css';
import '@ec/ui/styles.css';

const shell = createElectronShell(),
  caller = createDomainCaller(shell.domain!);
const projectId = new URLSearchParams(location.search).get('projectId')!;
useProjectStore.getState().openProject({
  id: projectId,
  name: 'D04 原生接口验证',
  targetPlatforms: ['web'],
  updatedAt: Date.now(),
});
const api = createApiIndexApi(caller),
  code = createCodeApi(caller, (listener) => shell.domain!.onEvent!(listener));
Object.assign(globalThis, { __EC_API_INDEX__: api, __EC_NAV__: createNavApi(caller) });
function TestApp(): JSX.Element {
  const [hash, setHash] = useState(location.hash),
    target = useNavLocation((s) => s.target);
  useEffect(() => {
    const update = (): void => setHash(location.hash);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return (
    <main className="ec-page">
      <h1>D04 源码接口工作台</h1>
      {hash === '#/code' ? (
        <>
          <button
            type="button"
            onClick={() => {
              location.hash = '#/apis';
            }}
          >
            返回接口
          </button>
          <p>
            源码定位 {target?.filePath}:{target?.line}
          </p>
          <CodeViewProvider api={code}>
            <CodeView />
          </CodeViewProvider>
        </>
      ) : (
        <ApiWorkbench api={api} projectId={projectId} />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<TestApp />);
