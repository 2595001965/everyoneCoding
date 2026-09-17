import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import {
  TARGET_PLATFORMS,
  TARGET_PLATFORM_LABELS,
  defaultChoice,
  questionsForTargets,
  techChoiceToStack,
  validateChoice,
  type ChoiceQuestion,
  type DesktopFramework,
  type MobileFramework,
  type TechChoice,
  type TargetPlatform,
  type WebFramework,
} from '@ec/pipeline';
import { Button, Checkbox, Modal, Radio, RadioGroup, Tag } from '@ec/ui';

export interface TechChoiceWizardProps {
  projectId: string;
  open: boolean;
  initial?: TechChoice | null;
  onComplete(choice: TechChoice): void;
  onClose(): void;
}

/** 题目 id → TechChoice 字段（问卷结果回填映射） */
type ChoiceValueField =
  | 'web'
  | 'mobile'
  | 'harmony'
  | 'desktop'
  | 'frontend'
  | 'backend'
  | 'database'
  | 'orm'
  | 'deploy';

const FIELD_FOR_QUESTION: Record<string, ChoiceValueField> = {
  'platform-web': 'web',
  'platform-android': 'mobile',
  'platform-ios': 'mobile',
  'platform-harmonyos': 'harmony',
  'platform-windows': 'desktop',
  'platform-linux': 'desktop',
  'platform-macos': 'desktop',
  frontend: 'frontend',
  backend: 'backend',
  database: 'database',
  orm: 'orm',
  deploy: 'deploy',
};

const STEPS = ['选择目标端', '技术选型', '确认'] as const;

/** 技术选型问卷向导（T5-04）：多选目标端 → 动态出题 → 确认栈文本 */
export function TechChoiceWizard({ open, initial, onComplete, onClose }: TechChoiceWizardProps): ReactElement {
  const [choice, setChoice] = useState<TechChoice>(() => initial ?? defaultChoice([]));
  const [step, setStep] = useState<number>(1);
  const [issues, setIssues] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setChoice(initial ?? defaultChoice([]));
      setStep(1);
      setIssues([]);
    }
  }, [open, initial]);

  const toggleTarget = (platform: TargetPlatform, checked: boolean): void => {
    setChoice((prev) => {
      const has = prev.targets.includes(platform);
      const targets = checked
        ? has
          ? prev.targets
          : [...prev.targets, platform]
        : prev.targets.filter((t) => t !== platform);
      return { ...prev, targets };
    });
    setIssues([]);
  };

  const applyAnswer = (field: ChoiceValueField, value: string): void => {
    setChoice((prev) => {
      switch (field) {
        case 'web':
          return { ...prev, web: value as WebFramework };
        case 'mobile':
          return { ...prev, mobile: value as MobileFramework };
        case 'harmony':
          return { ...prev, harmony: value as 'arkts' };
        case 'desktop':
          return { ...prev, desktop: value as DesktopFramework };
        case 'frontend':
          return { ...prev, frontend: value };
        case 'backend':
          return { ...prev, backend: value };
        case 'database':
          return { ...prev, database: value };
        case 'orm':
          return { ...prev, orm: value };
        case 'deploy':
          return { ...prev, deploy: value };
      }
    });
    setIssues([]);
  };

  const questions: ChoiceQuestion[] = questionsForTargets(choice.targets);

  const handleComplete = (): void => {
    const result = validateChoice(choice);
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues([]);
    onComplete(choice);
  };

  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <Button variant="ghost" onClick={onClose}>
        取消
      </Button>
      <div style={{ display: 'flex', gap: 8 }}>
        {step > 1 && (
          <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>
            上一步
          </Button>
        )}
        {step < 3 && (
          <Button variant="primary" onClick={() => setStep((s) => s + 1)}>
            下一步
          </Button>
        )}
        {step === 3 && (
          <Button variant="primary" onClick={handleComplete}>
            完成
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="技术选型向导"
      size="lg"
      footer={footer}
    >
      <div className="ec-pipe-wizard">
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {STEPS.map((label, idx) => (
            <span
              key={label}
              style={{
                fontSize: 13,
                padding: '4px 10px',
                borderRadius: 999,
                background: idx + 1 === step ? '#2563eb' : '#f1f5f9',
                color: idx + 1 === step ? '#fff' : '#475569',
              }}
            >
              {idx + 1}. {label}
            </span>
          ))}
        </div>

        {step === 1 && (
          <div>
            <h4 style={{ margin: '0 0 8px' }}>选择目标端（可多选）</h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {TARGET_PLATFORMS.map((platform) => (
                <Checkbox
                  key={platform}
                  checked={choice.targets.includes(platform)}
                  onChange={(checked) => toggleTarget(platform, checked)}
                  label={TARGET_PLATFORM_LABELS[platform]}
                />
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {questions.length === 0 && <p style={{ color: '#6b7280' }}>请先在第一步选择至少一个目标端。</p>}
            {questions.map((q) => {
              const field = FIELD_FOR_QUESTION[q.id];
              if (field === undefined) return null;
              const value = String(choice[field]);
              return (
                <div key={q.id}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{q.label}</div>
                  <RadioGroup
                    name={q.id}
                    value={value}
                    onChange={(val) => applyAnswer(field, val)}
                  >
                    {q.options.map((opt) => (
                      <Radio
                        key={opt.value}
                        value={opt.value}
                        disabled={opt.disabled}
                        label={
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span>
                              {opt.label}
                              {opt.recommended === true && (
                                <Tag color="primary" style={{ marginLeft: 6 }}>
                                  推荐
                                </Tag>
                              )}
                              {opt.disabled === true && opt.disabledReason !== undefined && (
                                <span style={{ color: '#9ca3af', marginLeft: 6, fontSize: 12 }}>
                                  （禁选：{opt.disabledReason}）
                                </span>
                              )}
                            </span>
                            <span style={{ color: '#6b7280', fontSize: 12 }}>{opt.tradeoffs}</span>
                          </div>
                        }
                      />
                    ))}
                  </RadioGroup>
                </div>
              );
            })}
          </div>
        )}

        {step === 3 && (
          <div>
            <h4 style={{ margin: '0 0 8px' }}>确认技术栈</h4>
            <pre
              style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                padding: 12,
                fontSize: 13,
                whiteSpace: 'pre-wrap',
              }}
            >
              {techChoiceToStack(choice)}
            </pre>
            {issues.length > 0 && (
              <div
                style={{
                  marginTop: 12,
                  color: '#dc2626',
                  background: '#fef2f2',
                  borderRadius: 6,
                  padding: '8px 10px',
                }}
              >
                <div style={{ fontWeight: 600 }}>以下选型尚未通过校验：</div>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
