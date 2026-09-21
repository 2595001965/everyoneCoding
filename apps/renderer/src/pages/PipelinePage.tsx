import { useMemo } from 'react';

import { EmptyState } from '@ec/ui';

import { PipelineProvider, PipelineWorkspace, readInjectedPipelineApi } from '../features/pipeline';
import { useAppStore } from '../store/useAppStore';
import { useProjectStore } from '../store/useProjectStore';
import { currentUserId } from '../runtime/project-context';

/**
 * 开发流水线页面（Wave 5 / T5-02 + T12-01/T12-03 生产端口）。
 *
 * 项目上下文贯穿：projectId / userId / projectName 全部来自当前打开的项目，
 * **不再**使用固定 `P1` / `U-TEST` / 「商城」夹具。流水线状态机与阶段产物经
 * 同步域口（invokeSync）读写真实 SQLite 与工程目录，重启后可恢复。
 */
export function PipelinePage(): JSX.Element {
  const shellReady = useAppStore((state) => state.shellReady);
  const project = useProjectStore((state) => state.current);
  const api = useMemo(() => (void shellReady, readInjectedPipelineApi()), [shellReady]);

  return (
    <section className="ec-page" aria-label="开发流水线">
      <h1 className="ec-page__title">开发流水线</h1>
      {api === null ? (
        <EmptyState
          title="开发流水线未初始化"
          description="外壳尚未注入 PipelineApi（__EC_PIPELINE__），或当前外壳缺少同步域通道（同步签名的状态机端口需要 invokeSync）。"
        />
      ) : project === null ? (
        <EmptyState
          title="未打开项目"
          description="流水线状态按项目维护（阶段、产物、技术选型都归属项目），请先在工作台打开一个项目。"
        />
      ) : (
        <PipelineProvider api={api}>
          <PipelineWorkspace
            projectId={project.id}
            userId={currentUserId()}
            projectName={project.name}
          />
        </PipelineProvider>
      )}
    </section>
  );
}

