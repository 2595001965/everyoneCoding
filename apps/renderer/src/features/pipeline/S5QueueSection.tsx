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
  const [state, setState] = useState<QueueState | null>(() => api.getQueueState(projectId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  useEffect(
    () =>
      api.subscribe('pipeline:*', (raw) => {
        const event = raw as { projectId?: string; type?: string; message?: string };
        if (event.projectId !== projectId) return;
        setState(api.getQueueState(projectId));
        if (event.message) setMessage(event.message);
      }),
    [api, projectId],
  );

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
  const run = (resume: boolean): void => {
    void execute(async () => {
      const split = api.getSplit(projectId);
      if (!split) throw new Error('请先完成 S4 拆分');
      const result = await api.runGeneration({
        projectId,
        userId,
        projectName,
        choice,
        split,
        requirementDoc: '',
        techDoc: '',
        ...(resume ? { resumeProgress: api.getResumeProgress(projectId).s5Progress } : {}),
      });
      return result.state as QueueState;
    });
  };
  const running = busy || state?.currentId != null;
  const resume = api.getResumeProgress(projectId).s5Progress;
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
          onClick={() => {
            try {
              setState(api.pauseQueue(projectId));
            } catch (cause) {
              setError(String(cause));
            }
          }}
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
