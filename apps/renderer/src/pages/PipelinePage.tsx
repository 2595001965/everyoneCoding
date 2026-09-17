import { EmptyState } from '@ec/ui';

import { PipelineProvider, PipelineWorkspace, readInjectedPipelineApi } from '../features/pipeline';

/**
 * 开发流水线页面（Wave 5）。
 * 外壳未注入 `__EC_PIPELINE__` 时展示装配引导（与记忆中心 / 上下文面板一致）。
 */
export function PipelinePage(): JSX.Element {
  const api = readInjectedPipelineApi();
  if (api === null) {
    return (
      <EmptyState
        title="开发流水线未初始化"
        description="外壳尚未注入 PipelineApi（__EC_PIPELINE__）。真实装配属 Wave 9/10 的外壳接线工作，当前先展示领域能力入口。"
      />
    );
  }
  return (
    <PipelineProvider api={api}>
      <PipelineWorkspace projectId="P1" userId="U-TEST" projectName="商城" />
    </PipelineProvider>
  );
}
