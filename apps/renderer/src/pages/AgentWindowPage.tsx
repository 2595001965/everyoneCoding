import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Textarea } from '@ec/ui';

import { readInjectedCodeApi, type AgentTaskSnapshot } from '../features/code/code-api';
import { useAppStore } from '../store/useAppStore';

const POLL_MS = 850;

export function AgentWindowPage(): JSX.Element {
  const [params] = useSearchParams();
  const projectId = params.get('projectId') ?? '';
  const projectName = params.get('projectName') ?? '项目';
  const sessionId = params.get('sessionId') ?? '';
  const shellReady = useAppStore((state) => state.shellReady);
  const api = (void shellReady, readInjectedCodeApi()?.agent ?? null);
  const [objective, setObjective] = useState('');
  const [snapshot, setSnapshot] = useState<AgentTaskSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(0);
  const polling = useRef(false);

  const refresh = useCallback(async () => {
    if (api === null || projectId.length === 0 || sessionId.length === 0 || polling.current) return;
    polling.current = true;
    try {
      const next = await api.snapshot(projectId, sessionId, cursor.current);
      cursor.current = Math.max(cursor.current, next.cursor);
      setSnapshot(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      polling.current = false;
    }
  }, [api, projectId, sessionId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const submit = async (): Promise<void> => {
    if (api === null || objective.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.startTask({
        projectId,
        sessionId,
        idempotencyKey: globalThis.crypto.randomUUID(),
        objective: objective.trim(),
      });
      setObjective('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (projectId.length === 0 || sessionId.length === 0) {
    return (
      <section className="ec-page">
        <h1 className="ec-page__title">Agent 窗口参数缺失</h1>
        <p role="alert">请从项目代码页打开 Agent 原生窗口。</p>
      </section>
    );
  }

  return (
    <section className="ec-page" aria-label="Agent 会话窗口" data-testid="ec-agent-window">
      <h1 className="ec-page__title">Agent · {projectName}</h1>
      <p className="ec-page__desc">
        此原生窗口使用共享的 D06 协调器与 D07 隔离工作副本。任务持久化在本机会话中，关窗不会终止它。
      </p>
      <label style={{ display: 'block', marginBottom: 8 }} htmlFor="ec-agent-objective">
        任务目标
      </label>
      <Textarea
        id="ec-agent-objective"
        aria-label="任务目标"
        value={objective}
        onChange={setObjective}
        rows={4}
      />
      <div style={{ margin: '8px 0 18px' }}>
        <Button
          onClick={() => void submit()}
          disabled={busy || objective.trim().length === 0}
          loading={busy}
          data-testid="ec-agent-submit"
        >
          提交异步任务
        </Button>
        <Button variant="ghost" onClick={() => void refresh()} style={{ marginLeft: 8 }}>
          刷新共享状态
        </Button>
      </div>
      {error !== null && <p role="alert">{error}</p>}
      <h2 style={{ fontSize: 15 }}>持久化任务</h2>
      {snapshot === null ? (
        <p role="status">正在读取协调器状态…</p>
      ) : snapshot.tasks.length === 0 ? (
        <p>此会话还没有任务。协调器游标：{snapshot.cursor}</p>
      ) : (
        <ol style={{ paddingLeft: 22 }}>
          {snapshot.tasks.map((record) => (
            <li key={record.task.taskId} style={{ marginBottom: 12 }}>
              <strong>{record.task.objective}</strong>
              <div>
                状态：{record.task.status} · 执行：{record.executionState} · 任务：
                {record.task.taskId}
              </div>
              {record.error !== null && <div role="alert">{record.error}</div>}
              {(record.task.status === 'queued' || record.task.status === 'running') &&
                api !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void api
                        .cancel(projectId, record.task.taskId)
                        .then(refresh)
                        .catch((cause: unknown) =>
                          setError(cause instanceof Error ? cause.message : String(cause)),
                        )
                    }
                  >
                    取消任务
                  </Button>
                )}
            </li>
          ))}
        </ol>
      )}
      <h2 style={{ fontSize: 15 }}>最近协调器事件</h2>
      <ol data-testid="ec-agent-events" style={{ paddingLeft: 22 }}>
        {(snapshot?.events ?? []).slice(-20).map((event) => (
          <li key={event.eventId}>
            {new Date(event.occurredAt).toLocaleTimeString()} · {event.type} ·{' '}
            {event.taskId ?? 'session'}
          </li>
        ))}
      </ol>
    </section>
  );
}
