import { useCallback, useEffect, useState } from 'react';

import type { QueueState, S5RunResult, TechChoice } from '@ec/pipeline';
import { describeQueueStats } from '@ec/pipeline';
import { Button, EmptyState, Spinner } from '@ec/ui';

import { usePipelineApi } from './pipeline-api';
import { NodeStatusCard } from './NodeStatusCard';

/**
 * S5 生成队列区（真实装配）：需求/技术文档从主进程产物读取（生效版本），
 * 拆分结果读 S4/split.json；支持单节点重试 / 跳过 / 暂停（域方法），
 * 进度与节点状态经 pipeline:progress 域事件回流刷新。
 */
export interface S5QueueSectionProps {
  projectId: string;
  userId: string;
  projectName: string;
  choice: TechChoice;
}

export function S5QueueSection({
  projectId,
  userId,
  projectName,
  choice,
}: S5QueueSectionProps): JSX.Element {
  const api = usePipelineApi();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<S5RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requirementDoc, setRequirementDoc] = useState('');
  const [techDoc, setTechDoc] = useState('');

  // 文档从主进程真实读取（生效版本），不把 UI 本地文本当持久化实现
  useEffect(() => {
    const s1 = api.listArtifacts(projectId, 'S1');
    const s3 = api.listArtifacts(projectId, 'S3');
    const s1Active = s1[s1.length - 1]?.version ?? 0;
    const s3Active = s3[s3.length - 1]?.version ?? 0;
    if (s1Active > 0) {
      void api.readArtifact(projectId, 'S1', s1Active).then(setRequirementDoc).catch(() => {});
    }
    if (s3Active > 0) {
      void api.readArtifact(projectId, 'S3', s3Active).then(setTechDoc).catch(() => {});
    }
  }, [api, projectId]);

  const handleRun = useCallback(
    async (resumeProgress?: string | null): Promise<void> => {
      const split = api.getSplit(projectId);
      if (split === null) {
        setError('尚未生成拆分结果（S4），请先完成 S4');
        return;
      }
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
    },
    [api, projectId, userId, projectName, choice, requirementDoc, techDoc],
  );

  const handleRetry = useCallback(
    async (nodeId: string): Promise<void> => {
      try {
        const state = await api.retryNode(projectId, nodeId);
        setResult((previous) =>
          previous === null ? previous : { ...previous, state: state as never },
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, projectId],
  );

  const handleSkip = useCallback(
    (nodeId: string): void => {
      try {
        const state = api.skipNode(projectId, nodeId);
        setResult((previous) =>
          previous === null ? previous : { ...previous, state: state as never },
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, projectId],
  );

  const handlePause = useCallback((): void => {
    try {
      const state = api.pauseQueue(projectId);
      setResult((previous) =>
        previous === null ? previous : { ...previous, state: state as never },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, projectId]);

  const resume = api.getResumeProgress(projectId);
  const state = result !== null ? (result.state as QueueState) : null;
  const hasProgress =
    resume.s5Progress !== null && resume.s5Progress !== undefined && resume.s5Progress.length > 0;

  return (
    <div className="ec-pipe-queue" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={() => void handleRun(null)} disabled={running}>
          {running ? '生成中…' : result !== null ? '重新生成' : '开始生成'}
        </Button>
        {hasProgress && !running && (
          <Button variant="secondary" onClick={() => void handleRun(resume.s5Progress)}>
            从断点继续
          </Button>
        )}
        {running && (
          <Button variant="ghost" onClick={handlePause}>
            暂停队列
          </Button>
        )}
        {state !== null && (
          <span style={{ fontSize: 13, color: '#475569' }}>{describeQueueStats(state.stats)}</span>
        )}
      </div>

      {running && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6b7280' }}>
          <Spinner /> 正在按拓扑序逐节点生成…
        </div>
      )}

      {error !== null && (
        <div
          style={{ color: '#dc2626', background: '#fef2f2', borderRadius: 6, padding: '8px 10px' }}
        >
          {error}
        </div>
      )}

      {state === null && !running && (
        <EmptyState
          title="尚未开始生成"
          description="点击「开始生成」按拓扑序逐个生成功能与页面代码；上次中断的进度可从断点继续。"
        />
      )}

      {state !== null && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 12,
          }}
        >
          {state.nodes.map((node) => (
            <div key={node.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <NodeStatusCard
                node={node}
                result={result?.results[node.id] ?? null}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                {(node.status === 'failed' || node.status === 'success') && (
                  <Button size="sm" variant="secondary" onClick={() => void handleRetry(node.id)}>
                    重试
                  </Button>
                )}
                {(node.status === 'pending' || node.status === 'failed') && (
                  <Button size="sm" variant="ghost" onClick={() => handleSkip(node.id)}>
                    跳过
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
