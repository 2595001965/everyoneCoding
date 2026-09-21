import { useCallback, lazy, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  readInjectedWorkspaceApi,
  WorkspaceUnavailable,
} from '../features/workspace/workspace-api';
import '../features/workspace/workspace.css';
import { useAppStore } from '../store/useAppStore';
import { useProjectStore } from '../store/useProjectStore';

const WorkspaceFeaturePage = lazy(() =>
  import('../features/workspace').then((module) => ({ default: module.WorkspacePage })),
);

/**
 * 工作台页（Wave 9 / T9-01 + T9-02 + T12-01 项目上下文贯穿）。
 *
 * 端口由外壳注入（`globalThis.__EC_WORKSPACE__`）：需要 SQLite 连接与项目服务，
 * 只有外壳起来之后才可用；未注入时展示装配引导而不是崩溃或假数据。
 *
 * 打开项目：把项目摘要写进全局项目上下文（`useProjectStore`）——设计器 / 流水线 /
 * 记忆 / Git / 预览 / 重命名等页面的生产端口都从它取 `projectId`，然后跳转设计器。
 */
export function WorkspacePage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  const navigate = useNavigate();
  // shellReady 变化代表外壳可能刚注入 API，需重新读取
  const api = useMemo(() => (void shellReady, readInjectedWorkspaceApi()), [shellReady]);

  const openProject = useCallback(
    (projectId: string) => {
      if (!api) {
        navigate('/designer');
        return;
      }
      void api
        .getProject(projectId)
        .then((summary) => {
          if (!summary) {
            console.warn(`[workspace] 项目不存在，未建立项目上下文：${projectId}`);
            return;
          }
          useProjectStore.getState().openProject({
            id: summary.id,
            name: summary.name,
            targetPlatforms: [...summary.targetPlatforms],
            updatedAt: summary.updatedAt,
          });
        })
        .catch((cause: unknown) => {
          console.warn(
            `[workspace] 打开项目失败：${cause instanceof Error ? cause.message : String(cause)}`,
          );
        })
        .finally(() => {
          navigate('/designer');
        });
    },
    [api, navigate],
  );

  return api ? (
    <WorkspaceFeaturePage api={api} onOpenProject={openProject} />
  ) : (
    <WorkspaceUnavailable />
  );
}
