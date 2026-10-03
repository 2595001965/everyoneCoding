import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  ImpactReport,
  PipelineStage,
  PipelineStageSnapshot,
  SplitModel,
  TechChoice,
} from '@ec/pipeline';
import { STAGE_DEFS, SplitModel as SplitModelClass } from '@ec/pipeline';
import { Button, EmptyState, Modal, Textarea } from '@ec/ui';

import { usePipelineApi } from './pipeline-api';
import { PipelineBar } from './PipelineBar';
import { StagePanel } from './StagePanel';
import { SupplementDialog } from './SupplementDialog';
import { TechChoiceWizard } from './TechChoiceWizard';
import { SplitEditor } from './SplitEditor';
import { S5QueueSection } from './S5QueueSection';

const STAGE_ORDER_LIST: readonly PipelineStage[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];

function emptySnapshot(): PipelineStageSnapshot {
  return Object.fromEntries(
    STAGE_ORDER_LIST.map((stage) => [
      stage,
      {
        stage,
        status: 'pending',
        activeVersion: null,
        latestVersion: 0,
        skippedAt: null,
        updatedAt: 0,
      },
    ]),
  ) as PipelineStageSnapshot;
}

/**
 * 流水线工作台（T5-02 集成视图 / E2E-03 载体）。
 *
 * 链路：200 字想法 → S1 需求文档 →（S2 设计由设计器承接）→ S3 技术选型问卷 + 技术文档 →
 * S4 拆分 → S5 逐个生成，每阶段可编辑可回退（E2E-03）。
 *
 * 关键路径：
 * - 未选择技术方案时进入 S3 被状态机 guard 阻断 → 弹问卷（E2E-19）；
 * - 追加要求 → 与原文档一起提交，要求 AI 输出完整新版；
 * - 补充需求 → 影响面评估 → 高亮需重新生成节点。
 */
export interface PipelineWorkspaceProps {
  projectId: string;
  userId: string;
  projectName: string;
}

export function PipelineWorkspace({
  projectId,
  userId,
  projectName,
}: PipelineWorkspaceProps): JSX.Element {
  const api = usePipelineApi();
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [downstreamStage, setDownstreamStage] = useState<PipelineStage | null>(null);
  const [snapshot, setSnapshot] = useState<PipelineStageSnapshot>(() => emptySnapshot());
  const [choice, setChoice] = useState<TechChoice | null>(null);
  const [viewingStage, setViewingStage] = useState<PipelineStage | null>(null);
  const [viewingVersion, setViewingVersion] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [supplementOpen, setSupplementOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<PipelineStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [splitModel, setSplitModel] = useState<SplitModel | null>(null);

  const refreshAuthoritative = useCallback(async () => {
    const [nextSnapshot, nextChoice, split] = await Promise.all([
      api.snapshot(projectId),
      api.getTechChoice(projectId),
      api.getSplit(projectId),
    ]);
    setSnapshot(nextSnapshot);
    setChoice(nextChoice);
    setSplitModel(split === null ? null : SplitModelClass.fromResult(split));
  }, [api, projectId]);

  // 订阅流水线事件刷新快照
  useEffect(() => {
    const unsubscribe = api.subscribe('pipeline:*', (raw) => {
      const event = raw as { projectId?: string; event?: string; data?: { stage?: PipelineStage } };
      if (event.projectId && event.projectId !== projectId) return;
      void refreshAuthoritative().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
      if (event.event === 'downstream-stale' && event.data?.stage)
        setDownstreamStage(event.data.stage);
    });
    return unsubscribe;
  }, [api, projectId, refreshAuthoritative]);

  const currentStage = useMemo<PipelineStage>(() => {
    for (const stage of STAGE_ORDER_LIST) if (snapshot[stage].status === 'running') return stage;
    for (const stage of STAGE_ORDER_LIST)
      if (snapshot[stage].status === 'awaiting_confirm' || snapshot[stage].status === 'stale')
        return stage;
    return (
      [...STAGE_ORDER_LIST].reverse().find((stage) => snapshot[stage].status === 'confirmed') ??
      'S1'
    );
  }, [snapshot]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getResumeProgress(projectId), api.recoverProject(projectId)])
      .then(async ([progress, result]) => {
        if (cancelled) return;
        setDescription(progress.inputs?.description ?? '');
        await refreshAuthoritative();
        if (result.integrityProblems.length > 0)
          setError(
            '部分阶段产物缺失，请回到对应阶段重新生成：' +
              result.integrityProblems.map((p) => `${p.stage} v${p.version}`).join('、'),
          );
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, projectId, refreshAuthoritative]);

  const activeView = viewingStage ?? currentStage;

  /* ------------------------------ 操作 ------------------------------ */

  const execute = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        await refreshAuthoritative();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [refreshAuthoritative],
  );

  const handleGenerateS1 = useCallback(
    async (instruction?: string) =>
      execute(() =>
        api.generateRequirement({
          projectId,
          userId,
          projectName,
          description,
          ...(instruction ? { instruction } : {}),
        }),
      ),
    [api, projectId, userId, projectName, description, execute],
  );

  const handleGenerateS3 = useCallback(
    async (instruction?: string) => {
      const selectedChoice = await api.getTechChoice(projectId);
      if (selectedChoice === null) {
        setWizardOpen(true);
        return;
      }
      await execute(() =>
        api.generateTechDoc({
          projectId,
          userId,
          projectName,
          description,
          choice: selectedChoice,
          requirementDoc: '',
          ...(instruction ? { instruction } : {}),
        }),
      );
    },
    [api, projectId, userId, projectName, description, execute],
  );

  const handleGenerateS4 = useCallback(
    async () =>
      execute(async () => {
        const split = await api.generateSplit(projectId);
        setSplitModel(SplitModelClass.fromResult(split));
      }),
    [api, projectId, execute],
  );

  const handleRegenerate = useCallback(
    (stage: PipelineStage) => {
      if (stage === 'S1') void handleGenerateS1();
      else if (stage === 'S2') void execute(() => api.captureDesign(projectId));
      else if (stage === 'S3') void handleGenerateS3();
      else if (stage === 'S4') void handleGenerateS4();
    },
    [api, projectId, execute, handleGenerateS1, handleGenerateS3, handleGenerateS4],
  );

  const handleConfirm = useCallback(
    async (stage: PipelineStage) => {
      await api.confirm(projectId, stage);
      await refreshAuthoritative();
    },
    [api, projectId, refreshAuthoritative],
  );

  const handleAdvance = useCallback(async () => {
    const to = nextStageOf(activeView);
    if (to === null) return;
    try {
      await api.advance(projectId, activeView, to);
      setViewingStage(null);
      setViewingVersion(0);
      await refreshAuthoritative();
      if (to === 'S3' && (await api.getTechChoice(projectId)) === null) setWizardOpen(true);
    } catch (cause) {
      if (to === 'S3') setWizardOpen(true);
      else setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, projectId, activeView, refreshAuthoritative]);

  const handleRollbackConfirm = useCallback(async () => {
    if (rollbackTarget === null) return;
    await api.back(projectId, currentStage, rollbackTarget);
    await refreshAuthoritative();
    setViewingStage(null);
    setRollbackTarget(null);
  }, [api, projectId, currentStage, rollbackTarget, refreshAuthoritative]);

  const handleSubmitSupplement = useCallback(
    (instruction: string) => {
      if (activeView === 'S1') void handleGenerateS1(instruction);
      else if (activeView === 'S3') void handleGenerateS3(instruction);
      else void handleGenerateS4();
    },
    [activeView, handleGenerateS1, handleGenerateS3, handleGenerateS4],
  );

  const handleEvaluateImpact = useCallback(
    async (_instruction: string): Promise<ImpactReport | null> => {
      if (splitModel === null) return null;
      const model = splitModel;
      const targets = model.nodeIds().filter((id) => id.startsWith('f-'));
      return targets.length > 0 ? model.evaluateImpact({ type: 'supplement', targets }) : null;
    },
    [splitModel],
  );

  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <div className="ec-pipe-workspace" data-testid="pipeline-workspace">
      <PipelineBar
        snapshot={snapshot}
        onReview={(stage) => {
          setViewingStage(stage);
          setViewingVersion(0);
        }}
        onRollback={(_from, to) => setRollbackTarget(to)}
        viewingStage={viewingStage}
      />

      {downstreamStage !== null && (
        <Modal
          open
          title="文档已更新，是否重新生成下游"
          onOpenChange={(open) => {
            if (!open) setDownstreamStage(null);
          }}
          footer={
            <>
              <Button onClick={() => setDownstreamStage(null)}>保留现有产物</Button>
              <Button
                onClick={() => {
                  void execute(async () => {
                    await api.applyDownstreamStale(projectId, downstreamStage);
                    setDownstreamStage(null);
                  });
                }}
              >
                标记下游待重新生成
              </Button>
            </>
          }
        >
          <p>历史产物仍可回看，继续生成将使用当前生效版本。</p>
        </Modal>
      )}
      {rollbackTarget !== null && (
        <Modal
          open
          onOpenChange={(next) => {
            if (!next) setRollbackTarget(null);
          }}
          title="确认回退"
          footer={
            <>
              <Button variant="ghost" onClick={() => setRollbackTarget(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                data-testid="rollback-confirm"
                onClick={() => void execute(handleRollbackConfirm)}
              >
                确认回退到 {STAGE_DEFS[rollbackTarget].name}
              </Button>
            </>
          }
        >
          <p>
            回退到 {STAGE_DEFS[rollbackTarget].name}{' '}
            将把该阶段之后的全部产物置为「已过期」，下游需要重新生成。此操作不可撤销，请确认。
          </p>
        </Modal>
      )}

      {error !== null && (
        <EmptyState
          title="操作失败"
          description={error}
          action={
            <Button
              variant="primary"
              onClick={() => {
                setError(null);
              }}
            >
              知道了
            </Button>
          }
        />
      )}

      {activeView === 'S1' && (
        <div className="ec-pipe-workspace__idea" data-testid="idea-input-area">
          <h3>输入你的想法</h3>
          <Textarea
            value={description}
            onChange={(value) => setDescription(value)}
            placeholder="用自然语言描述你要做的产品（约 200 字）：功能、目标用户、约束…"
            data-testid="idea-input"
            rows={5}
          />
          <Button
            variant="primary"
            data-testid="idea-generate"
            disabled={busy}
            onClick={() => void handleGenerateS1()}
          >
            生成需求文档
          </Button>
        </div>
      )}

      <div className="ec-pipe-workspace__body">
        <section className="ec-pipe-workspace__stage">
          <StagePanel
            key={activeView}
            busy={busy}
            projectId={projectId}
            stage={activeView}
            snapshot={snapshot}
            viewingVersion={viewingVersion}
            onSwitchVersion={(version) => setViewingVersion(version)}
            onSubmitSupplement={handleSubmitSupplement}
            onRegenerate={() => handleRegenerate(activeView)}
          />
          <div className="ec-pipe-workspace__stage-actions">
            <Button
              size="sm"
              variant="secondary"
              data-testid="stage-advance"
              onClick={() => void handleAdvance()}
              disabled={busy || activeView === 'S7' || snapshot[activeView].status !== 'confirmed'}
            >
              进入下一阶段
            </Button>
            {snapshot[activeView].status === 'awaiting_confirm' && (
              <Button
                size="sm"
                variant="primary"
                data-testid="stage-confirm"
                onClick={() => void execute(() => handleConfirm(activeView))}
              >
                确认{STAGE_DEFS[activeView].artifactLabel}
              </Button>
            )}
          </div>
        </section>

        <aside className="ec-pipe-workspace__side">
          {activeView === 'S3' && (
            <div className="ec-pipe-side" data-testid="tech-choice-side">
              <h4>技术选型</h4>
              {choice === null ? (
                <div className="ec-pipe-side__empty">
                  <p>尚未完成技术选型问卷，无法进入 S3。</p>
                  <Button
                    size="sm"
                    variant="primary"
                    data-testid="open-tech-wizard"
                    onClick={() => setWizardOpen(true)}
                  >
                    立即填写问卷
                  </Button>
                </div>
              ) : (
                <pre className="ec-pipe-side__stack">{formatStack(choice)}</pre>
              )}
            </div>
          )}
          {activeView === 'S4' && splitModel !== null && (
            <SplitEditor
              projectId={projectId}
              model={splitModel}
              onChange={(model) => {
                void execute(async () => {
                  await api.saveSplit(projectId, model.result());
                  const saved = await api.getSplit(projectId);
                  setSplitModel(saved === null ? null : SplitModelClass.fromResult(saved));
                });
              }}
            />
          )}
          {activeView === 'S5' && choice !== null && (
            <S5QueueSection
              projectId={projectId}
              userId={userId}
              projectName={projectName}
              choice={choice}
            />
          )}
        </aside>
      </div>

      <TechChoiceWizard
        projectId={projectId}
        open={wizardOpen}
        initial={choice}
        onComplete={(completed: TechChoice) => {
          void execute(async () => {
            await api.saveTechChoice(projectId, completed);
            setWizardOpen(false);
          });
        }}
        onClose={() => setWizardOpen(false)}
      />

      <SupplementDialog
        open={supplementOpen}
        stage={activeView}
        onEvaluate={handleEvaluateImpact}
        onSubmit={handleSubmitSupplement}
        onClose={() => setSupplementOpen(false)}
      />
    </div>
  );
}

function nextStageOf(stage: PipelineStage): PipelineStage | null {
  const index = STAGE_ORDER_LIST.indexOf(stage);
  return index >= 0 && index < STAGE_ORDER_LIST.length - 1
    ? (STAGE_ORDER_LIST[index + 1] as PipelineStage)
    : null;
}

function formatStack(choice: TechChoice): string {
  return `目标端：${choice.targets.join(' / ')}\n前端：${choice.frontend}\n后端：${choice.backend}\n数据库：${choice.database}`;
}
