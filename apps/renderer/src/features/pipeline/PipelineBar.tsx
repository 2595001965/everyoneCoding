import type { PipelineStage, PipelineStageSnapshot, StageStatus } from '@ec/pipeline';
import { STAGE_DEFS, STAGE_ORDER, STAGE_STATUS_LABELS } from '@ec/pipeline';
import { Button } from '@ec/ui';

import { usePipelineApi } from './pipeline-api';

/**
 * 横向 7 阶段步骤条（T5-02 要点 1 / FR-PIPE-01）。
 * - 状态四色：未开始（灰）/ 进行中（蓝）/ 已确认（绿）/ 已跳过（黄）/ 已过期（红描边）；
 * - 当前阶段高亮；已完成阶段可点击回看（onReview）；
 * - 回退按钮带二次确认（onRollback 由父层弹确认框）。
 */

export interface PipelineBarProps {
  projectId: string;
  snapshot?: PipelineStageSnapshot | null | undefined;
  /** 点击已完成阶段（回看其产物） */
  onReview: (stage: PipelineStage) => void;
  /** 回退请求（父层负责二次确认后调 api.back） */
  onRollback: (from: PipelineStage, to: PipelineStage) => void;
  /** 当前回看的阶段（高亮区分于"当前推进位置"） */
  viewingStage?: PipelineStage | null | undefined;
}

function statusClass(status: StageStatus): string {
  switch (status) {
    case 'running':
      return 'ec-pipe-stage--running';
    case 'awaiting_confirm':
      return 'ec-pipe-stage--awaiting';
    case 'confirmed':
      return 'ec-pipe-stage--confirmed';
    case 'stale':
      return 'ec-pipe-stage--stale';
    default:
      return 'ec-pipe-stage--pending';
  }
}

export function PipelineBar({ projectId, snapshot, onReview, onRollback, viewingStage }: PipelineBarProps): JSX.Element {
  const api = usePipelineApi();
  const states = snapshot ?? api.snapshot(projectId);
  const current = [...STAGE_ORDER].reverse().find((stage) => states[stage].status !== 'pending') ?? 'S1';

  return (
    <div className="ec-pipe-bar" data-testid="pipeline-bar">
      <div className="ec-pipe-bar__steps">
        {STAGE_ORDER.map((stage, index) => {
          const state = states[stage];
          const clickable = state.status === 'confirmed' || state.status === 'stale' || state.status === 'running';
          const isViewing = viewingStage === stage;
          const classes = ['ec-pipe-stage', statusClass(state.status), clickable ? 'ec-pipe-stage--clickable' : '', isViewing ? 'ec-pipe-stage--viewing' : '', stage === current ? 'ec-pipe-stage--current' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={stage}
              type="button"
              className={classes}
              data-stage={stage}
              data-testid={`pipeline-stage-${stage}`}
              title={`${STAGE_DEFS[stage].name}（${STAGE_STATUS_LABELS[state.status]}）`}
              disabled={!clickable}
              onClick={() => {
                if (clickable) onReview(stage);
              }}
            >
              <span className="ec-pipe-stage__index">{index + 1}</span>
              <span className="ec-pipe-stage__name">{STAGE_DEFS[stage].name}</span>
              {state.skippedAt !== null && <span className="ec-pipe-stage__skipped">已跳过</span>}
            </button>
          );
        })}
      </div>
      <div className="ec-pipe-bar__actions">
        <Button
          size="sm"
          variant="ghost"
          data-testid="pipeline-rollback-btn"
          onClick={() => {
            if (current !== 'S1') onRollback(current, 'S1');
          }}
          disabled={current === 'S1'}
        >
          回退
        </Button>
      </div>
    </div>
  );
}
