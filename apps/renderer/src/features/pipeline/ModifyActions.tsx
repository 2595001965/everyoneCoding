import type { PipelineStage } from '@ec/pipeline';
import { STAGE_DEFS } from '@ec/pipeline';
import { Button, type ButtonVariant } from '@ec/ui';

/**
 * 「修改至满意」四操作（T5-02 要点 3 / FR-PIPE-03）。
 * 1. 重新生成：重跑本阶段（api.startStage）；
 * 2. 局部修改：选中章节让 AI 改（onLocalEdit 由父层打开选区）；
 * 3. 手动编辑：文档类产物允许编辑，代码类不允许（D-04，onManualEdit 缺省关闭）；
 * 4. 追加要求：把补充指令与原文档一起提交，要求 AI 输出**完整新版**（onSupplement 弹输入框）。
 */

export type ModifyAction = 'regenerate' | 'local-edit' | 'manual-edit' | 'supplement';

export interface ModifyActionsProps {
  stage: PipelineStage;
  /** 产物是否可手动编辑（仅文档类；代码类恒 false，D-04） */
  allowManualEdit?: boolean | undefined;
  onRegenerate: () => void;
  onLocalEdit: () => void;
  onManualEdit?: (() => void) | undefined;
  onSupplement: () => void;
  /** 追加要求提交（父层处理：api.generateRequirement / generateTechDoc with instruction） */
  onSubmitSupplement: (instruction: string) => void;
}

export const MODIFY_ACTION_LABELS: Record<ModifyAction, string> = {
  regenerate: '重新生成',
  'local-edit': '局部修改',
  'manual-edit': '手动编辑',
  supplement: '追加要求',
};

function actionVariant(action: ModifyAction): ButtonVariant {
  switch (action) {
    case 'regenerate':
      return 'primary';
    case 'supplement':
      return 'secondary';
    default:
      return 'ghost';
  }
}

export function ModifyActions({
  stage,
  allowManualEdit = false,
  onRegenerate,
  onLocalEdit,
  onManualEdit,
  onSupplement,
}: ModifyActionsProps): JSX.Element {
  const artifactLabel = STAGE_DEFS[stage].artifactLabel;
  return (
    <div className="ec-pipe-actions" data-testid="modify-actions">
      <Button size="sm" variant={actionVariant('regenerate')} data-testid="action-regenerate" onClick={onRegenerate}>
        重新生成{artifactLabel}
      </Button>
      <Button size="sm" variant={actionVariant('local-edit')} data-testid="action-local-edit" onClick={onLocalEdit}>
        局部修改
      </Button>
      <Button
        size="sm"
        variant={actionVariant('manual-edit')}
        data-testid="action-manual-edit"
        onClick={onManualEdit}
        disabled={!allowManualEdit}
        title={allowManualEdit ? '文档类产物允许手动编辑' : '代码类产物只读（D-04：代码仅由 AI 写入）'}
      >
        手动编辑
      </Button>
      <Button size="sm" variant={actionVariant('supplement')} data-testid="action-supplement" onClick={onSupplement}>
        追加要求
      </Button>
    </div>
  );
}
