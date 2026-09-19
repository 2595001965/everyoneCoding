import type { ReactElement } from 'react';
import { useState } from 'react';
import type { QueueState, S5RunResult, SplitResult, TechChoice } from '@ec/pipeline';
import { describeQueueStats } from '@ec/pipeline';
import { usePipelineOptional } from './pipeline-api';
import { NodeStatusCard } from './NodeStatusCard';
import { Button, EmptyState, Spinner } from '@ec/ui';

export interface GenerationQueuePanelProps {
  projectId: string;
  userId: string;
  projectName: string;
  choice: TechChoice;
  requirementDoc: string;
  techDoc: string;
  split: SplitResult;
  /** 断点续生成进度快照（null = 全新执行） */
  resumeProgress?: string | null;
}

/** S5 生成队列面板：发起生成、实时进度与每节点结果卡 */
export function GenerationQueuePanel({
  projectId,
  userId,
  projectName,
  choice,
  requirementDoc,
  techDoc,
  split,
  resumeProgress,
}: GenerationQueuePanelProps): ReactElement {
  const api = usePipelineOptional();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<S5RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async (): Promise<void> => {
    if (api === null) return;
    setRunning(true);
    setError(null);
    try {
      const run = await api.runGeneration({
        projectId,
        userId,
        projectName,
        choice,
        requirementDoc,
        techDoc,
        split,
        ...(resumeProgress !== undefined && resumeProgress !== null ? { resumeProgress } : {}),
      });
      setResult(run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  if (api === null) {
    return <EmptyState title="流水线未初始化" description="请先注入 PipelineApi 后再执行生成。" />;
  }

  const state = result !== null ? (result.state as QueueState) : null;

  return (
    <div className="ec-pipe-queue" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button variant="primary" onClick={handleRun} disabled={running}>
          {running ? '生成中…' : result !== null ? '重新生成' : '开始生成'}
        </Button>
        {result !== null && state !== null && (
          <span style={{ fontSize: 13, color: '#475569' }}>{describeQueueStats(state.stats)}</span>
        )}
      </div>

      {running && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6b7280' }}>
          <Spinner /> 正在生成代码…
        </div>
      )}

      {error !== null && (
        <div
          style={{ color: '#dc2626', background: '#fef2f2', borderRadius: 6, padding: '8px 10px' }}
        >
          {error}
        </div>
      )}

      {!running && result === null && (
        <EmptyState
          title="尚未开始生成"
          description="点击「开始生成」按拓扑序逐个生成功能与页面代码。"
        />
      )}

      {result !== null && state !== null && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 12,
            }}
          >
            {state.nodes.map((node) => (
              <NodeStatusCard key={node.id} node={node} result={result.results[node.id] ?? null} />
            ))}
          </div>

          {result.commits.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>自动提交记录</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#374151' }}>
                {result.commits.map((commit) => (
                  <li key={`${commit.nodeId}-${commit.sha}`}>
                    <code>{commit.sha.slice(0, 8)}</code> · {commit.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
