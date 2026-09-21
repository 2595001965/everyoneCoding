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
  const [snapshot, setSnapshot] = useState<PipelineStageSnapshot>(() => api.snapshot(projectId));
  const [viewingStage, setViewingStage] = useState<PipelineStage | null>(null);
  const [viewingVersion, setViewingVersion] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [supplementOpen, setSupplementOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<PipelineStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [splitModel, setSplitModel] = useState<SplitModel | null>(() => {
    const split = api.getSplit(projectId);
    return split === null ? null : SplitModelClass.fromResult(split);
  });

  // 订阅流水线事件刷新快照
  useEffect(() => {
    const unsubscribe = api.subscribe('pipeline:*', () => setSnapshot(api.snapshot(projectId)));
    return unsubscribe;
  }, [api, projectId]);

  const currentStage = useMemo<PipelineStage>(() => {
    for (let index = STAGE_ORDER_LIST.length - 1; index >= 0; index -= 1) {
      const stage = STAGE_ORDER_LIST[index] as PipelineStage;
      if (snapshot[stage].status !== 'pending') return stage;
    }
    return 'S1';
  }, [snapshot]);

  const activeView = viewingStage ?? currentStage;

  /* ------------------------------ 操作 ------------------------------ */

  /** S1 起点：输入想法 → 生成需求文档 */
  const handleGenerateS1 = useCallback(
    async (instruction?: string | undefined) => {
      const text = (
        instruction !== undefined && instruction.trim().length > 0 ? instruction : description
      ).trim();
      if (text.length === 0) {
        setError('请先输入想法（约 200 字）');
        return;
      }
      try {
        api.startStage(projectId, 'S1');
        const result = await api.generateRequirement({
          projectId,
          userId,
          projectName,
          description: text,
          ...(instruction !== undefined && instruction.trim().length > 0 ? { instruction } : {}),
        });
        await api.saveArtifact({
          projectId,
          stage: 'S1',
          artifactType: 'requirement_doc',
          content: result.content,
          note:
            instruction !== undefined && instruction.trim().length > 0
              ? `追加要求：${instruction}`
              : '初始生成',
        });
        api.submitForReview(projectId, 'S1');
        setSnapshot(api.snapshot(projectId));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, projectId, userId, projectName, description],
  );

  /** S3：生成技术文档（未选方案先弹问卷） */
  const handleGenerateS3 = useCallback(
    async (instruction?: string | undefined) => {
      const choice = api.getTechChoice(projectId);
      if (choice === null) {
        setWizardOpen(true);
        return;
      }
      try {
        api.startStage(projectId, 'S3');
        // 需求文档读 S1 真实产物（生效版本），读不到给占位文案
        const s1Versions = api.listArtifacts(projectId, 'S1');
        const activeVersion =
          snapshot.S1.activeVersion ?? s1Versions[s1Versions.length - 1]?.version ?? 0;
        const requirement =
          activeVersion > 0
            ? await api.readArtifact(projectId, 'S1', activeVersion).catch(() => '')
            : '';
        const result = await api.generateTechDoc({
          projectId,
          userId,
          projectName,
          description,
          choice,
          requirementDoc: requirement.length > 0 ? requirement : '# 需求文档（未生成）',
          ...(instruction !== undefined && instruction.trim().length > 0 ? { instruction } : {}),
        });
        await api.saveArtifact({
          projectId,
          stage: 'S3',
          artifactType: 'tech_doc',
          content: result.content,
          note:
            instruction !== undefined && instruction.trim().length > 0
              ? `追加要求：${instruction}`
              : '初始生成',
        });
        api.submitForReview(projectId, 'S3');
        setSnapshot(api.snapshot(projectId));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, projectId, userId, projectName, description, snapshot],
  );

  /** S4：自动拆分（规则解析技术文档 → 落 S4/split.json）并装载编辑模型 */
  const handleGenerateS4 = useCallback(async () => {
    try {
      api.startStage(projectId, 'S4');
      // 传当前生效版本号：S3/S1 产物从主进程真实读取，而不是让 UI 传全文
      const s1Versions = api.listArtifacts(projectId, 'S1');
      const s3Versions = api.listArtifacts(projectId, 'S3');
      const split = await api.generateSplit(projectId, {
        techDocVersion: s3Versions[s3Versions.length - 1]?.version ?? 0,
        requirementDocVersion: s1Versions[s1Versions.length - 1]?.version ?? 0,
      });
      await api.saveSplit(projectId, split);
      setSplitModel(SplitModelClass.fromResult(split));
      api.submitForReview(projectId, 'S4');
      setSnapshot(api.snapshot(projectId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, projectId]);

  const handleRegenerate = useCallback(
    (stage: PipelineStage) => {
      if (stage === 'S1') void handleGenerateS1();
      else if (stage === 'S3') void handleGenerateS3();
      else if (stage === 'S4') void handleGenerateS4();
      else api.startStage(projectId, stage);
    },
    [api, projectId, handleGenerateS1, handleGenerateS3, handleGenerateS4],
  );

  const handleConfirm = useCallback(
    (stage: PipelineStage) => {
      api.confirm(projectId, stage);
      setSnapshot(api.snapshot(projectId));
      if (stage === 'S3') {
        const choice = api.getTechChoice(projectId);
        if (choice !== null) {
          const split = api.getSplit(projectId);
          setSplitModel(split === null ? null : SplitModelClass.fromResult(split));
        }
      }
    },
    [api, projectId],
  );

  const handleAdvance = useCallback(() => {
    const to = nextStageOf(currentStage);
    if (to === null) return;
    try {
      api.advance(projectId, currentStage, to);
      setSnapshot(api.snapshot(projectId));
      if (to === 'S3' && api.getTechChoice(projectId) === null) setWizardOpen(true);
      if (to === 'S4') {
        const split = api.getSplit(projectId);
        setSplitModel(split === null ? null : SplitModelClass.fromResult(split));
      }
    } catch (cause) {
      if (to === 'S3') setWizardOpen(true);
      else setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, projectId, currentStage]);

  const handleRollbackConfirm = useCallback(() => {
    if (rollbackTarget === null) return;
    api.back(projectId, currentStage, rollbackTarget);
    setSnapshot(api.snapshot(projectId));
    setViewingStage(null);
    setRollbackTarget(null);
  }, [api, projectId, currentStage, rollbackTarget]);

  const handleSubmitSupplement = useCallback(
    (instruction: string) => {
      if (activeView === 'S1') void handleGenerateS1(instruction);
      else if (activeView === 'S3') void handleGenerateS3(instruction);
      else void handleGenerateS4();
    },
    [activeView, handleGenerateS1, handleGenerateS3, handleGenerateS4],
  );

  const handleEvaluateImpact = useCallback(
    (_instruction: string): ImpactReport | null => {
      const split = api.getSplit(projectId);
      if (split === null) return null;
      const model = SplitModelClass.fromResult(split);
      const targets = model.nodeIds().filter((id) => id.startsWith('f-'));
      return targets.length > 0 ? model.evaluateImpact({ type: 'supplement', targets }) : null;
    },
    [api, projectId],
  );

  /* ------------------------------ 渲染 ------------------------------ */

  const choice = api.getTechChoice(projectId);

  return (
    <div className="ec-pipe-workspace" data-testid="pipeline-workspace">
      <PipelineBar
        projectId={projectId}
        snapshot={snapshot}
        onReview={(stage) => setViewingStage(stage)}
        onRollback={(_from, to) => setRollbackTarget(to)}
        viewingStage={viewingStage}
      />

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
                onClick={handleRollbackConfirm}
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

      {activeView === 'S1' && snapshot.S1.status === 'pending' && (
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
            onClick={() => void handleGenerateS1()}
          >
            生成需求文档
          </Button>
        </div>
      )}

      <div className="ec-pipe-workspace__body">
        <section className="ec-pipe-workspace__stage">
          <StagePanel
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
              onClick={handleAdvance}
              disabled={snapshot[activeView].status !== 'confirmed'}
            >
              进入下一阶段
            </Button>
            {snapshot[activeView].status === 'awaiting_confirm' && (
              <Button
                size="sm"
                variant="primary"
                data-testid="stage-confirm"
                onClick={() => handleConfirm(activeView)}
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
              onChange={(model) => setSplitModel(model)}
            />
          )}
          {activeView === 'S5' && splitModel !== null && (
            <S5QueueSection
              projectId={projectId}
              userId={userId}
              projectName={projectName}
              choice={choice ?? defaultChoice()}
            />
          )}
        </aside>
      </div>

      <TechChoiceWizard
        projectId={projectId}
        open={wizardOpen}
        initial={choice}
        onComplete={(completed: TechChoice) => {
          void api.saveTechChoice(projectId, completed);
          setWizardOpen(false);
          setSnapshot(api.snapshot(projectId));
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

function defaultChoice(): TechChoice {
  return {
    targets: ['web'],
    web: 'react',
    mobile: 'flutter',
    harmony: 'arkts',
    desktop: 'tauri2',
    frontend: 'react',
    backend: 'node-nest',
    database: 'sqlite',
    orm: 'prisma',
    deploy: 'desktop',
  };
}

function formatStack(choice: TechChoice): string {
  return [
    `目标端：${choice.targets.join(' / ')}`,
    `移动：${choice.mobile}`,
    `桌面：${choice.desktop}`,
    `前端：${choice.frontend}`,
    `后端：${choice.backend}`,
    `数据库：${choice.database}`,
  ].join('\n');
}
