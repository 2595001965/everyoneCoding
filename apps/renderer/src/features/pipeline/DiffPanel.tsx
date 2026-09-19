import { useEffect, useState } from 'react';

import type { PipelineStage } from '@ec/pipeline';
import { Button, Spinner } from '@ec/ui';

import { usePipelineApi } from './pipeline-api';

/**
 * diff 对比面板（T5-02 要点 3）。
 * - 展示版本 vN 相对 vN-1 的差异（文本 diff）；
 * - Markdown 用行级 diff（artifact-store.buildLineDiff 的产物），DSL 用结构化对比（外层处理）；
 * - 切换版本时自动加载目标版本的 diff。
 */

export interface DiffPanelProps {
  projectId: string;
  stage: PipelineStage;
  /** 目标版本（读取其相对上一版的 diff） */
  version: number;
}

interface DiffViewState {
  loading: boolean;
  diff: string | null;
  error: string | null;
}

export function DiffPanel({ projectId, stage, version }: DiffPanelProps): JSX.Element {
  const api = usePipelineApi();
  const [state, setState] = useState<DiffViewState>({ loading: true, diff: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, diff: null, error: null });
    void (async () => {
      try {
        const diff = await api.readDiff(projectId, stage, version);
        if (!cancelled) setState({ loading: false, diff, error: null });
      } catch (cause) {
        if (!cancelled)
          setState({
            loading: false,
            diff: null,
            error: cause instanceof Error ? cause.message : String(cause),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, projectId, stage, version]);

  if (state.loading) return <Spinner label="加载差异中…" />;

  if (state.error !== null) {
    return <div className="ec-pipe-diff ec-pipe-diff--error">{state.error}</div>;
  }

  if (state.diff === null) {
    return (
      <div className="ec-pipe-diff ec-pipe-diff--empty">v{version} 是首个版本，无历史差异</div>
    );
  }

  const rows = state.diff.split('\n');
  return (
    <div className="ec-pipe-diff" data-testid="diff-panel">
      <div className="ec-pipe-diff__head">
        <span>v{version} 相对上一版本</span>
        <Button
          size="sm"
          variant="ghost"
          data-testid="diff-refresh"
          onClick={() => {
            setState({ loading: true, diff: null, error: null });
          }}
        >
          刷新
        </Button>
      </div>
      <pre className="ec-pipe-diff__body">
        {rows.map((row, index) => {
          const className = row.startsWith('- ')
            ? 'ec-pipe-diff--del'
            : row.startsWith('+ ')
              ? 'ec-pipe-diff--add'
              : '';
          return (
            <div key={index} className={className}>
              {row}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
