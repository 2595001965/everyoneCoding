/**
 * 提交框（T6-02 要点 2 / 5）：输入提交信息 + 「AI 生成提交信息」+ 规范切换 + 校验 + 自动提交策略。
 *
 * - 校验用领域层 `validateCommitMessage`，不合法时禁用提交并给出中文错误；
 * - 提交成功清空输入；
 * - 自动提交策略（FR-GIT-09）三档，默认关闭，切换即调 `setAutoCommitPolicy`。
 */
import { useCallback, useEffect, useState } from 'react';

import { Button, Input, Select, Textarea } from '@ec/ui';
import {
  AUTO_COMMIT_TRIGGER_LABELS,
  COMMIT_CONVENTIONS,
  type AutoCommitPolicy,
  type AutoCommitTrigger,
  parseCommitMessage,
  validateCommitMessage,
} from '@ec/git';

import { useGitApi } from './git-api';

export interface CommitBoxProps {
  /** 提交成功后回调（用于刷新变更列表） */
  onCommitted?: () => void;
  /** 预填提交信息（例如由上层根据选中 hunk 生成） */
  initialSubject?: string;
  initialBody?: string;
}

export function CommitBox({
  onCommitted,
  initialSubject = '',
  initialBody = '',
}: CommitBoxProps): JSX.Element {
  const api = useGitApi();
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [convention, setConvention] = useState<'angular' | 'custom'>('angular');
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [policy, setPolicy] = useState<AutoCommitPolicy>({ trigger: 'off', convention: 'angular' });

  useEffect(() => {
    void api.autoCommitPolicy().then((p) => setPolicy(p));
  }, [api]);

  const message = subject.length > 0 ? (body.length > 0 ? `${subject}\n\n${body}` : subject) : '';
  const validation =
    message.length > 0 ? validateCommitMessage(message, COMMIT_CONVENTIONS[convention]) : null;
  const valid = validation === null || validation.valid;

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    const result = await api.generateCommitMessage({ convention });
    if (result.ok && result.data !== null) {
      const parsed = parseCommitMessage(result.data);
      if (parsed !== null) {
        setSubject(parsed.subject);
        setBody(parsed.body);
      } else {
        setSubject(result.data.split('\n')[0] ?? '');
        setBody('');
      }
    } else {
      setError(result.error?.message ?? '生成失败');
    }
    setGenerating(false);
  }, [api, convention]);

  const submit = useCallback(async () => {
    if (!valid || message.length === 0) return;
    setSubmitting(true);
    const result = await api.commit({ subject, ...(body.length > 0 ? { body } : {}) });
    setSubmitting(false);
    if (result.ok) {
      setSubject('');
      setBody('');
      setError(null);
      onCommitted?.();
    } else {
      setError(result.error?.message ?? '提交失败');
    }
  }, [api, valid, message, subject, body, onCommitted]);

  const changePolicy = useCallback(
    async (trigger: AutoCommitTrigger) => {
      const next: AutoCommitPolicy = { trigger, convention };
      setPolicy(next);
      await api.setAutoCommitPolicy(next);
    },
    [api, convention],
  );

  return (
    <div className="ec-commit-box" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="ec-commit-box__row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Select
          aria-label="提交规范"
          value={convention}
          onChange={(v) => setConvention(v as 'angular' | 'custom')}
          options={[
            { label: COMMIT_CONVENTIONS.angular.label, value: 'angular' },
            { label: COMMIT_CONVENTIONS.custom.label, value: 'custom' },
          ]}
          data-testid="convention-select"
        />
        <Button size="sm" onClick={generate} loading={generating} data-testid="ai-generate">
          AI 生成提交信息
        </Button>
      </div>

      <Input
        aria-label="提交标题"
        placeholder="提交标题，例如 feat: 新增登录页"
        value={subject}
        onChange={setSubject}
        invalid={!valid && subject.length > 0}
        data-testid="commit-subject"
      />
      <Textarea
        aria-label="提交说明"
        placeholder="提交说明（可选）"
        value={body}
        onChange={setBody}
        style={{ minHeight: 64 }}
        data-testid="commit-body"
      />

      {error !== null && (
        <div
          className="ec-commit-box__error"
          role="alert"
          style={{ color: 'var(--ec-color-danger)' }}
          data-testid="commit-error"
        >
          {error}
        </div>
      )}
      {validation !== null && !validation.valid && (
        <div
          className="ec-commit-box__invalid"
          role="alert"
          style={{ color: 'var(--ec-color-danger)' }}
          data-testid="commit-invalid"
        >
          {validation.errors[0] ?? '提交信息格式不正确'}
        </div>
      )}

      <Button
        variant="primary"
        onClick={submit}
        loading={submitting}
        disabled={!valid || message.length === 0}
        data-testid="commit-submit"
      >
        提交
      </Button>

      <div
        className="ec-commit-box__auto"
        style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}
      >
        <span style={{ color: 'var(--ec-color-text-secondary)' }}>自动提交策略</span>
        <Select
          aria-label="自动提交策略"
          value={policy.trigger}
          onChange={(v) => void changePolicy(v as AutoCommitTrigger)}
          options={(['off', 'per-stage', 'per-node'] as AutoCommitTrigger[]).map((t) => ({
            label: AUTO_COMMIT_TRIGGER_LABELS[t],
            value: t,
          }))}
          data-testid="auto-policy-select"
        />
      </div>
    </div>
  );
}
