import { useCallback, useEffect, useState } from 'react';
import { describeQueueStats, type QueueState, type TechChoice } from '@ec/pipeline';
import { Button } from '@ec/ui';
import { usePipelineApi } from './pipeline-api';
import { NodeStatusCard } from './NodeStatusCard';

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
  const [state, setState] = useState<QueueState | null>(null);
  const [resume, setResume] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const [nextState, progress] = await Promise.all([
        api.getQueueState(projectId),
        api.getResumeProgress(projectId),
      ]);
      if (cancelled) return;
      setState(nextState);
      setResume(progress.s5Progress);
    };
    void refresh().catch((cause: unknown) => setError(String(cause)));
    const unsubscribe = api.subscribe('pipeline:*', (raw) => {
        const event = raw as { projectId?: string; type?: string; message?: string };
        if (event.projectId !== projectId) return;
        void refresh().catch((cause: unknown) => setError(String(cause)));
        if (event.message) setMessage(event.message);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, projectId]);

  const execute = useCallback(async (work: () => Promise<QueueState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await work());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);
  const run = (shouldResume: boolean): void => {
    void execute(async () => {
      const split = await api.getSplit(projectId);
      if (!split) throw new Error('请先完成 S4 拆分');
      const progress = resume ?? (await api.getResumeProgress(projectId)).s5Progress;
      const result = await api.runGeneration({
        projectId,
        userId,
        projectName,
        choice,
        split,
        requirementDoc: '',
        techDoc: '',
        ...(shouldResume ? { resumeProgress: progress } : {}),
      });
      const latest = await api.getQueueState(projectId);
      if (latest !== null) return latest;
      return result.state as QueueState;
    });
  };
  const running = busy || state?.currentId != null;
  return (
    <div className="ec-pipe-queue" data-testid="s5-queue">
      <Button variant="primary" disabled={running} onClick={() => run(false)}>
        开始生成
      </Button>
      {resume && (
        <Button disabled={running} onClick={() => run(true)}>
          从断点继续
        </Button>
      )}
      {running && (
        <Button
          onClick={() => void execute(() => api.pauseQueue(projectId))}
        >
          暂停队列
        </Button>
      )}
      <p role="status">{message}</p>
      {error && <p role="alert">{error}</p>}
      {state && (
        <>
          <p>
            {describeQueueStats(state.stats)}
            {state.paused ? '（已暂停）' : ''}
          </p>
          {state.nodes.map((node) => (
            <div key={node.id}>
              <NodeStatusCard node={node} result={null} />
              {(node.status === 'failed' || node.status === 'success') && (
                <Button
                  disabled={running}
                  onClick={() => void execute(() => api.retryNode(projectId, node.id))}
                >
                  重试
                </Button>
              )}
              {(node.status === 'pending' || node.status === 'failed') && (
                <Button
                  disabled={running}
                  onClick={() => void execute(() => api.skipNode(projectId, node.id))}
                >
                  跳过
                </Button>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
