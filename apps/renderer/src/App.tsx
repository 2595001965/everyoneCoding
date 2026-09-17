import { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useTheme } from '@ec/ui';
import { useUiStore } from './store/useUiStore';
import { AppShell } from './layout/AppShell';
import { WorkspacePage } from './pages/WorkspacePage';
const DesignerPage = lazy(() =>
  import('./pages/DesignerPage').then((module) => ({ default: module.DesignerPage })),
);
const MemoryPage = lazy(() =>
  import('./pages/MemoryPage').then((module) => ({ default: module.MemoryPage })),
);
const PipelinePage = lazy(() =>
  import('./pages/PipelinePage').then((module) => ({ default: module.PipelinePage })),
);
const GitPage = lazy(() =>
  import('./pages/GitPage').then((module) => ({ default: module.GitPage })),
);
const RenamePage = lazy(() =>
  import('./pages/RenamePage').then((module) => ({ default: module.RenamePage })),
);
const PreviewPage = lazy(() =>
  import('./pages/PreviewPage').then((module) => ({ default: module.PreviewPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const UsagePage = lazy(() =>
  import('./pages/UsagePage').then((module) => ({ default: module.UsagePage })),
);
const DocsCenterPage = lazy(() =>
  import('./pages/DocsCenterPage').then((module) => ({ default: module.DocsCenterPage })),
);
const AccountPage = lazy(() =>
  import('./pages/AccountPage').then((module) => ({ default: module.AccountPage })),
);

/**
 * 根组件：主题应用 + 主路由（工作台 / 设计器 / 记忆 / 流水线 / Git / 预览 / 统一重命名 / 文档 / 账号 / 用量 / 设置）。
 * 使用 HashRouter：双形态外壳（file:// 与 http://）下都能工作。
 */
export function App(): JSX.Element {
  const theme = useUiStore((state) => state.theme);

  useTheme(theme);

  return (
    <HashRouter>
      <AppShell>
        <Suspense
          fallback={
            <p role="status" className="ec-page__desc">
              正在加载工作空间…
            </p>
          }
        >
          <Routes>
            <Route path="/" element={<WorkspacePage />} />
            <Route path="/designer" element={<DesignerPage />} />
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="/pipeline" element={<PipelinePage />} />
            <Route path="/git" element={<GitPage />} />
            <Route path="/preview" element={<PreviewPage />} />
            <Route path="/rename" element={<RenamePage />} />
            <Route path="/docs" element={<DocsCenterPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AppShell>
    </HashRouter>
  );
}
