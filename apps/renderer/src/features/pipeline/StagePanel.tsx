import { useEffect, useState } from 'react';

import type { ArtifactVersion, PipelineStage, PipelineStageSnapshot } from '@ec/pipeline';
import { STAGE_DEFS, STAGE_STATUS_LABELS } from '@ec/pipeline';
import { Button } from '@ec/ui';

import { usePipelineApi } from './pipeline-api';
import { ArtifactViewer } from './ArtifactViewer';
import { DiffPanel } from './DiffPanel';
import { ModifyActions } from './ModifyActions';
import { VersionSwitcher } from './VersionSwitcher';

/**
 * 阶段产物面板（T5-02 要点 2 / FR-PIPE-02）。
 * 组合：版本切换 + 产物渲染 + diff 对比 + 四种修改操作。
 * 未生成过产物的阶段展示空态与"开始生成"按钮。
 */

export interface StagePanelProps {
  projectId: string;
  stage: PipelineStage;
  /** 阶段状态快照（父层持有，跨组件共享） */
  snapshot: PipelineStageSnapshot;
  /** 回看历史版本（≠ activeVersion 时 DiffPanel 展示对应 diff） */
  viewingVersion: number;
  /** 版本切换回调 */
  onSwitchVersion: (version: number) => void;
  /** 追加要求提交（父层处理后弹窗） */
  onSubmitSupplement: (instruction: string) => void;
  /** 重新生成请求 */
  onRegenerate: () => void;
}

export function StagePanel({
  projectId,
  stage,
  snapshot,
  viewingVersion,
  onSwitchVersion,
  onSubmitSupplement,
  onRegenerate,
}: StagePanelProps): JSX.Element {
  const api = usePipelineApi();
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [content, setContent] = useState<string>('');
  const [manualEdit, setManualEdit] = useState(false);
  const [draft, setDraft] = useState<string>('');

  const state = snapshot[stage];
  const hasArtifact = versions.length > 0;
  const isCodeStage = stage === 'S5' || stage === 'S6' || stage === 'S7';
  const allowManualEdit = !isCodeStage;

  // 装载版本台账与生效内容
  useEffect(() => {
    const list = api.listArtifacts(projectId, stage);
    setVersions(list);
    if (list.length === 0) {
      setContent('');
      return;
    }
    const target = viewingVersion > 0 ? viewingVersion : (state.activeVersion ?? list[list.length - 1]?.version ?? 0);
    void api.readArtifact(projectId, stage, target).then((text) => {
      setContent(text);
      setDraft(text);
    });
  }, [api, projectId, stage, viewingVersion, state.activeVersion]);

  return (
    <div className="ec-pipe-stage-panel" data-testid="stage-panel">
      <div className="ec-pipe-stage-panel__head">
        <div className="ec-pipe-stage-panel__title">
          <h3>{STAGE_DEFS[stage].name}</h3>
          <span className="ec-pipe-stage-panel__status">{STAGE_STATUS_LABELS[state.status]}</span>
        </div>
        <div className="ec-pipe-stage-panel__tools">
          {hasArtifact && (
            <VersionSwitcher
              projectId={projectId}
              stage={stage}
              versions={versions}
              activeVersion={state.activeVersion ?? 0}
              viewingVersion={viewingVersion > 0 ? viewingVersion : (state.activeVersion ?? 0)}
              onSwitch={onSwitchVersion}
            />
          )}
          <Button size="sm" variant="primary" data-testid="stage-generate" onClick={onRegenerate} disabled={state.status === 'running'}>
            {hasArtifact ? '重新生成' : `生成${STAGE_DEFS[stage].artifactLabel}`}
          </Button>
        </div>
      </div>

      {!hasArtifact ? (
        <div className="ec-pipe-stage-panel__empty" data-testid="stage-panel-empty">
          <p>该阶段尚未生成产物。点击「生成{STAGE_DEFS[stage].artifactLabel}」开始。</p>
          <p className="ec-pipe-stage-panel__hint">{STAGE_DEFS[stage].completionCondition}</p>
        </div>
      ) : manualEdit && allowManualEdit ? (
        <div className="ec-pipe-stage-panel__edit">
          <textarea
            className="ec-pipe-stage-panel__textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            data-testid="manual-edit-area"
            rows={16}
          />
          <div className="ec-pipe-stage-panel__edit-actions">
            <Button size="sm" variant="ghost" onClick={() => setManualEdit(false)}>
              取消编辑
            </Button>
            <Button
              size="sm"
              variant="primary"
              data-testid="manual-edit-save"
              onClick={() => {
                setContent(draft);
                setManualEdit(false);
              }}
            >
              保存草稿（本地）
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ArtifactViewer content={content} artifactType={STAGE_DEFS[stage].artifactType} />
          {viewingVersion > 0 && state.activeVersion !== null && viewingVersion !== state.activeVersion && (
            <div className="ec-pipe-stage-panel__diff">
              <DiffPanel projectId={projectId} stage={stage} version={viewingVersion} />
            </div>
          )}
        </>
      )}

      <div className="ec-pipe-stage-panel__modify">
        <ModifyActions
          stage={stage}
          allowManualEdit={allowManualEdit}
          onRegenerate={onRegenerate}
          onLocalEdit={() => {
            // 局部修改：父层打开选区模式（当前面板内提示）
          }}
          onManualEdit={() => setManualEdit(true)}
          onSupplement={() => {
            // 追加要求：父层打开 SupplementDialog
          }}
          onSubmitSupplement={onSubmitSupplement}
        />
      </div>
    </div>
  );
}
