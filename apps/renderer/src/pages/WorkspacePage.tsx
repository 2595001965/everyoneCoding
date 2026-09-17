import { lazy, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  readInjectedWorkspaceApi,
  WorkspaceUnavailable,
} from '../features/workspace/workspace-api';
import '../features/workspace/workspace.css';
import { useAppStore } from '../store/useAppStore';

const WorkspaceFeaturePage = lazy(() =>
  import('../features/workspace').then((module) => ({ default: module.WorkspacePage })),
);

/**
 * 工作台页（Wave 9 / T9-01 + T9-02）。
 *
 * 端口由外壳注入（`globalThis.__EC_WORKSPACE__`）：需要 SQLite 连接与项目服务，
 * 只有外壳起来之后才可用；未注入时展示装配引导而不是崩溃或假数据。
 * 打开项目时跳转到设计器（后续由外壳按项目状态决定进入设计器还是流水线）。
 */
export function WorkspacePage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  const navigate = useNavigate();
  // shellReady 变化代表外壳可能刚注入 API，需重新读取
  const api = useMemo(() => (void shellReady, readInjectedWorkspaceApi()), [shellReady]);

  return api ? (
    <WorkspaceFeaturePage api={api} onOpenProject={() => navigate('/designer')} />
  ) : (
    <WorkspaceUnavailable />
  );
}
