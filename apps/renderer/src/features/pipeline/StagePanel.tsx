import { useCallback, useEffect, useState } from 'react';

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
  busy?: boolean;
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
  busy = false,
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
  const [saving, setSaving] = useState(false);

  const state = snapshot[stage];
  const hasArtifact = versions.length > 0;
  const allowManualEdit = stage === 'S1' || stage === 'S3' || stage === 'S6' || stage === 'S7';
  const [error, setError] = useState<string | null>(null);

  /** 手动编辑保存：走 saveArtifact 版本化落库（写主进程产物文件 + stage_artifact 表），
   * 绝不把 UI 本地 textarea 状态当持久化实现 */
  const handleSaveManualEdit = useCallback(async () => {
    setSaving(true);
    try {
      await api.saveArtifact({
        projectId,
        stage,
        artifactType: STAGE_DEFS[stage].artifactType,
        content: draft,
        note: '手动编辑',
      });
      const savedVersions = await api.listArtifacts(projectId, stage);
      setVersions(savedVersions);
      const latest = savedVersions[savedVersions.length - 1];
      if (latest) setContent(await api.readArtifact(projectId, stage, latest.version));
      setManualEdit(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [api, projectId, stage, draft]);

  // 装载版本台账与生效内容
  useEffect(() => {
    let cancelled = false;
    setVersions([]);
    setContent('');
    void api
      .listArtifacts(projectId, stage)
      .then(async (list) => {
        if (cancelled) return;
        setVersions(list);
        if (list.length === 0) return;
        const target =
          viewingVersion > 0
            ? viewingVersion
            : (state.activeVersion ?? list[list.length - 1]?.version ?? 0);
        const text = await api.readArtifact(projectId, stage, target);
        if (!cancelled) {
          setContent(text);
          setDraft(text);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, projectId, stage, viewingVersion, state.activeVersion, state.latestVersion]);

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
          {stage !== 'S5' && (
            <Button
              size="sm"
              variant="primary"
              data-testid="stage-generate"
              onClick={
                stage === 'S6' || stage === 'S7'
                  ? () => {
                      setDraft(content);
                      setManualEdit(true);
                    }
                  : onRegenerate
              }
              disabled={busy || saving}
            >
              {stage === 'S2'
                ? '保存设计稿快照'
                : stage === 'S6' || stage === 'S7'
                  ? `记录${STAGE_DEFS[stage].artifactLabel}`
                  : hasArtifact
                    ? '重新生成'
                    : `生成${STAGE_DEFS[stage].artifactLabel}`}
            </Button>
          )}
        </div>
      </div>

      {error && <p role="alert">{error}</p>}
      {!hasArtifact && !manualEdit ? (
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
              disabled={saving}
              onClick={() => void handleSaveManualEdit()}
            >
              {saving ? '保存中…' : '保存为新版本'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ArtifactViewer content={content} artifactType={STAGE_DEFS[stage].artifactType} />
          {(viewingVersion || state.activeVersion || 0) > 1 && (
            <div className="ec-pipe-stage-panel__diff">
              <DiffPanel
                projectId={projectId}
                stage={stage}
                version={viewingVersion || state.activeVersion || 0}
              />
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
