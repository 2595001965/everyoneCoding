import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createElectronShell } from '../../apps/desktop-electron/src/bridge';
import { createDomainCaller } from '../../apps/renderer/src/runtime/domain-ports';
import { createApiIndexApi, createCodeApi } from '../../apps/renderer/src/runtime/production-ports';
import { useProjectStore } from '../../apps/renderer/src/store/useProjectStore';
import { ApiWorkbench } from '../../apps/renderer/src/features/api-index/ApiWorkbench';
import { CodeWorkspacePage } from '../../apps/renderer/src/pages/CodePage';
import '@ec/ui/tokens.css';
import '@ec/ui/styles.css';

const shell = createElectronShell();
if (!shell.domain) throw new Error('Electron test preload did not expose the domain bridge');
const caller = createDomainCaller(shell.domain);
const projectId = new URLSearchParams(location.search).get('projectId')!;
const api = createApiIndexApi(caller);
const code = createCodeApi(caller, (listener) => shell.domain!.onEvent!(listener));
const emptyContext = {
  blocks: [],
  system: 'Existing context/generation chain.',
  user: 'D09 fixture context.',
  messages: [],
  totalTokens: 0,
  budget: 128_000,
  tookMs: 0,
  truncation: {
    omittedCount: 0,
    omittedTokens: 0,
    items: [],
    beforeTokens: 0,
    afterTokens: 0,
    aggressive: false,
    summary: '',
    byReason: {
      'block-over-quota': 0,
      'block-over-budget': 0,
      'aggressive-trim': 0,
      'block-disabled': 0,
    },
  },
  noteIds: [],
  memoryIds: [],
  skipped: [],
  aggressive: false,
};
Object.assign(globalThis, {
  __EC_CODE__: code,
  __EC_API_INDEX__: api,
  __EC_AI_CONTEXT__: {
    ready: true,
    availableSources: ['code'],
    assemble: async () => emptyContext,
  },
  __EC_DESIGNER__: {
    listPages: async () => [],
    savePage: async () => ({ pageId: 'd09-no-page', savedAt: Date.now() }),
  },
});
useProjectStore.getState().openProject({
  id: projectId,
  name: 'D09 isolated Electron preview',
  targetPlatforms: ['web'],
  updatedAt: Date.now(),
});

function TestApp(): JSX.Element {
  return (
    <MemoryRouter initialEntries={['/apis']}>
      <Routes>
        <Route path="/apis" element={<ApiWorkbench api={api} projectId={projectId} />} />
        <Route path="/code" element={<CodeWorkspacePage />} />
      </Routes>
    </MemoryRouter>
  );
}

createRoot(document.getElementById('root')!).render(<TestApp />);
