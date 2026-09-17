import { useState } from 'react';

import type { ImpactReport, PipelineStage } from '@ec/pipeline';
import { Button, Modal, Textarea } from '@ec/ui';

/**
 * 补充需求对话框（T5-02 要点 4 / FR-PIPE-12）。
 * - 任意阶段可"插入补充需求"；
 * - 提交前调用影响面评估（onEvaluate），高亮列出需重新生成的节点；
 * - 用户确认后提交（onSubmit）——要求 AI 输出**完整新版**而非补丁。
 */

export interface SupplementDialogProps {
  open: boolean;
  stage: PipelineStage;
  /** 影响面评估回调（父层用 SplitModel.evaluateImpact；未拆分时返回空） */
  onEvaluate: (instruction: string) => ImpactReport | null;
  /** 提交补充指令（父层调 api.generateRequirement / generateTechDoc with instruction） */
  onSubmit: (instruction: string) => void;
  onClose: () => void;
}

export function SupplementDialog({ open, stage, onEvaluate, onSubmit, onClose }: SupplementDialogProps): JSX.Element {
  const [instruction, setInstruction] = useState('');
  const [report, setReport] = useState<ImpactReport | null>(null);

  const evaluate = (): void => {
    const result = onEvaluate(instruction);
    setReport(result);
  };

  const submit = (): void => {
    const trimmed = instruction.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
    setInstruction('');
    setReport(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setReport(null);
          onClose();
        }
      }}
      title={`补充需求（阶段 ${stage}）`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="secondary" data-testid="supplement-evaluate" onClick={evaluate} disabled={instruction.trim().length === 0}>
            评估影响范围
          </Button>
          <Button variant="primary" data-testid="supplement-submit" onClick={submit} disabled={instruction.trim().length === 0}>
            提交并重新生成
          </Button>
        </>
      }
    >
      <div className="ec-pipe-supplement">
        <p className="ec-pipe-supplement__hint">
          补充指令将与当前 {stage} 阶段的原文档一起提交，要求 AI 输出<strong>完整新版</strong>（不做碎片化补丁拼接）。
        </p>
        <Textarea
          value={instruction}
          onChange={(value) => setInstruction(value)}
          placeholder="例如：增加游客模式，未登录也可浏览商品详情…"
          data-testid="supplement-input"
          rows={4}
        />
        {report !== null && (
          <div className="ec-pipe-supplement__impact" data-testid="supplement-impact">
            <div className="ec-pipe-supplement__impact-title">影响范围（需重新生成的节点）</div>
            {report.affected.length === 0 ? (
              <div className="ec-pipe-supplement__impact-empty">未匹配到拆分结果中的节点（可提交后手动跟踪）</div>
            ) : (
              <ul>
                {report.affected.map((id) => (
                  <li key={id} className="ec-pipe-supplement__impact-node" data-testid="supplement-impact-node">
                    {id}
                    {report.paths[id] !== undefined && report.paths[id].length > 1 ? (
                      <span className="ec-pipe-supplement__impact-path">（路径：{report.paths[id].join(' → ')}）</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
