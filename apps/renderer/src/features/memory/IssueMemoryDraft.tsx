import { useEffect, useState } from 'react';

import { Button, Input, Modal, Tag, Textarea } from '@ec/ui';

/**
 * 问题记忆草稿（FR-MEM-15）。
 *
 * 一键建立后自动汇总：现象 / 复现步骤 / 已尝试方案 / 关联页面与元素 / 最近 commit。
 * 草稿**可编辑后保存**，用户在落库前能补充结论与修正措辞。
 */

export interface IssueMemoryDraftValue {
  title: string;
  phenomenon: string;
  reproduce: string[];
  attempts: Array<{ action: string; result: string }>;
  conclusion: string;
  commitSha: string | null;
  relatedPageId: string | null;
  relatedElementId: string | null;
  relatedFeatureId: string | null;
  codeLocations: Array<{ filePath: string; symbol?: string | null }>;
}

export interface IssueMemoryDraftProps {
  open?: boolean;
  draft: IssueMemoryDraftValue;
  onSave: (draft: IssueMemoryDraftValue) => void;
  onCancel: () => void;
  busy?: boolean;
}

export function IssueMemoryDraft({
  open = true,
  draft,
  onSave,
  onCancel,
  busy = false,
}: IssueMemoryDraftProps): JSX.Element {
  const [value, setValue] = useState(draft);
  const [reproduceText, setReproduceText] = useState(draft.reproduce.join('\n'));

  useEffect(() => {
    setValue(draft);
    setReproduceText(draft.reproduce.join('\n'));
  }, [draft]);

  const related = [
    value.relatedFeatureId ? `功能 ${value.relatedFeatureId}` : null,
    value.relatedPageId ? `页面 ${value.relatedPageId}` : null,
    value.relatedElementId ? `元素 ${value.relatedElementId}` : null,
  ].filter((entry): entry is string => Boolean(entry));

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title="建立问题记忆草稿"
      size="lg"
      footer={
        <div className="ec-issue-draft__actions">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => onSave({ ...value, reproduce: splitLines(reproduceText) })}
          >
            保存为问题记忆
          </Button>
        </div>
      }
    >
      <div className="ec-issue-draft" data-testid="issue-memory-draft">
        <label className="ec-issue-draft__field">
          <span>标题</span>
          <Input
            value={value.title}
            onChange={(title) => setValue((prev) => ({ ...prev, title }))}
            aria-label="问题标题"
          />
        </label>

        <label className="ec-issue-draft__field">
          <span>现象</span>
          <Textarea
            value={value.phenomenon}
            onChange={(phenomenon) => setValue((prev) => ({ ...prev, phenomenon }))}
            rows={3}
            aria-label="现象"
          />
        </label>

        <label className="ec-issue-draft__field">
          <span>复现步骤（一行一步）</span>
          <Textarea value={reproduceText} onChange={setReproduceText} rows={4} aria-label="复现步骤" />
        </label>

        <label className="ec-issue-draft__field">
          <span>结论（可选）</span>
          <Textarea
            value={value.conclusion}
            onChange={(conclusion) => setValue((prev) => ({ ...prev, conclusion }))}
            rows={2}
            aria-label="结论"
          />
        </label>

        <section className="ec-issue-draft__summary" aria-label="自动汇总信息">
          <h3>自动汇总</h3>
          <p>
            <span className="ec-issue-draft__label">已尝试：</span>
            {value.attempts.length === 0
              ? '暂无记录'
              : value.attempts.map((attempt) => `${attempt.action}（${attempt.result}）`).join('；')}
          </p>
          <p>
            <span className="ec-issue-draft__label">关联位置：</span>
            {related.length === 0 ? '未关联' : related.join(' / ')}
          </p>
          <p>
            <span className="ec-issue-draft__label">关联提交：</span>
            {value.commitSha ? <Tag color="neutral">{value.commitSha}</Tag> : '未检测到提交'}
          </p>
          <p>
            <span className="ec-issue-draft__label">代码位置：</span>
            {value.codeLocations.length === 0
              ? '暂无'
              : value.codeLocations.map((location) => location.filePath).join('、')}
          </p>
        </section>
      </div>
    </Modal>
  );
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
