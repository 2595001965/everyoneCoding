/**
 * OnboardingCard（T10-05 / NFR-U-01）：首次使用引导。
 *
 * 出现条件：工作台处于「项目」页签 + 项目列表为空 + 用户尚未关闭引导
 * （关闭状态持久化在 `globalThis.__EC_ONBOARDING__` 端口，未注入时退化为 sessionStorage，
 *  会话内不重复打扰即可——绝不因端口缺失而阻塞首跑体验）。
 *
 * 三步引导对齐 NFR-U-01 的目标路径：新建项目 → 描述想法 → S1 生成需求文档 → S2 生成界面。
 * 步骤状态由外壳按真实事件（项目创建 / S1 产物 / S2 产物）推进，未注入时只显示引导文案。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@ec/ui';

export interface OnboardingProgress {
  /** 已创建过项目（至少 1 个，含回收站） */
  projectCreated: boolean;
  /** S1 需求文档已产出过 */
  requirementReady: boolean;
  /** S2 界面（页面 DSL）已产出过 */
  interfaceReady: boolean;
}

export interface OnboardingApi {
  /** 读取引导进度（真实事件推进） */
  getProgress(): Promise<OnboardingProgress>;
  /** 引导是否已被用户关闭（跨会话持久） */
  isDismissed(): Promise<boolean>;
  /** 用户点击「不再显示」：持久化关闭标记 */
  dismiss(): Promise<void>;
}

/** 渲染层端口注入键（外壳装配，Wave 10 口径） */
export const ONBOARDING_PORT_KEY = '__EC_ONBOARDING__';

/** 未注入端口时的会话级兜底键 */
const SESSION_KEY = 'ec-onboarding-dismissed';

const STEPS: Array<{ key: keyof OnboardingProgress; title: string; hint: string }> = [
  {
    key: 'projectCreated',
    title: '① 新建项目',
    hint: '工作台右上角「新建项目」，可从空白、模板或需求文档开始。',
  },
  {
    key: 'requirementReady',
    title: '② 描述你的想法',
    hint: '在流水线 S1 输入约 200 字的产品想法，AI 生成需求文档，可编辑可回退。',
  },
  {
    key: 'interfaceReady',
    title: '③ 生成界面',
    hint: 'S2 由 AI 生成页面 DSL，进入设计器用拖拽继续打磨。',
  },
];

function readSessionDismissed(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSessionDismissed(): void {
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    /* 会话存储不可用（隐私模式等）时静默忽略，引导下次再显示 */
  }
}

export interface OnboardingCardProps {
  /** 点击「新建项目」直达按钮 */
  onCreateProject: () => void;
}

export function OnboardingCard({ onCreateProject }: OnboardingCardProps): JSX.Element {
  const port = (globalThis as Record<string, unknown>)[ONBOARDING_PORT_KEY] as
    OnboardingApi | undefined;
  const [dismissed, setDismissed] = useState<boolean>(() => readSessionDismissed());
  const [progress, setProgress] = useState<OnboardingProgress>({
    projectCreated: false,
    requirementReady: false,
    interfaceReady: false,
  });

  // 端口就绪后读取一次真实进度与持久化关闭标记；未注入时保持全 false（只显示引导，不显示进度）
  useEffect(() => {
    if (!port) return;
    let cancelled = false;
    void port
      .getProgress()
      .then((next) => {
        if (!cancelled) setProgress(next);
      })
      .catch(() => undefined);
    void port
      .isDismissed()
      .then((persisted) => {
        if (persisted && !cancelled) setDismissed(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [port]);

  const dismiss = useCallback(() => {
    if (port) {
      void port.dismiss().catch(() => undefined);
    }
    writeSessionDismissed();
    setDismissed(true);
  }, [port]);

  if (dismissed) return <></>;

  return (
    <section className="ec-ws__onboarding" aria-label="新手引导">
      <div className="ec-ws__onboarding-main">
        <h2>欢迎使用 EveryoneCoding</h2>
        <p>
          三步把想法变成可运行项目：描述需求，AI 生成界面与技术文档，再逐个功能生成前后端代码。
          全程可视化，每一步都可以回退。
        </p>
        <ol className="ec-ws__onboarding-steps">
          {STEPS.map((step) => (
            <li
              key={step.key}
              className="ec-ws__onboarding-step"
              data-done={progress[step.key] ? 'true' : 'false'}
            >
              <span className="ec-ws__onboarding-step-title">{step.title}</span>
              <small>{step.hint}</small>
            </li>
          ))}
        </ol>
      </div>
      <div className="ec-ws__onboarding-actions">
        <Button variant="primary" onClick={onCreateProject}>
          新建第一个项目
        </Button>
        <button type="button" className="ec-ws__onboarding-dismiss" onClick={dismiss}>
          不再显示
        </button>
      </div>
    </section>
  );
}
