import { useEffect, useMemo, useState } from 'react';

import { UsageDashboard } from '../features/usage/UsageDashboard';
import { UsageApiProvider, UsageUnavailable, readInjectedUsageApi } from '../features/usage/usage-api';
import { useAppStore } from '../store/useAppStore';

/**
 * 用量页（T10-01 / FR-AI-09）：全局与项目两级用量视图。
 *
 * 端口：`globalThis.__EC_USAGE__`（外壳注入）；
 * 项目下拉经 `globalThis.__EC_WORKSPACE__.listProjects()` 异步拉取，
 * 工作台端口未注入时仅全局视图可用（不阻塞页面）。
 */

interface ProjectOption {
  id: string;
  name: string;
}

export function UsagePage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  const [options, setOptions] = useState<ProjectOption[]>([]);

  const usageApi = useMemo(
    () => (void shellReady, readInjectedUsageApi()),
    [shellReady],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const workspace = (
        globalThis as unknown as {
          __EC_WORKSPACE__?: { listProjects?: () => Promise<Array<{ id: string; name: string }>> };
        }
      ).__EC_WORKSPACE__;
      if (typeof workspace?.listProjects !== 'function') return;
      try {
        const projects = await workspace.listProjects();
        if (!cancelled) setOptions(projects.map((project) => ({ id: project.id, name: project.name })));
      } catch {
        // 工作台端口异常不阻塞用量页（全局视图仍可用）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shellReady]);

  if (!usageApi) return <UsageUnavailable />;
  return (
    <UsageApiProvider api={usageApi}>
      <UsageDashboard projectOptions={options} />
    </UsageApiProvider>
  );
}
