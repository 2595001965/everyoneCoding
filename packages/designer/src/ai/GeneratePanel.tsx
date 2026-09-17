import * as React from 'react';

import { Button, Switch, Tag, Textarea } from '@ec/ui';

import type { PageDsl, Platform } from '../dsl/types';
import { countElements, dslFromAi, type AiDslIssue, type DslFromAiContext } from './dsl-from-ai';
import { describeSketch, isVisionSupported, readSketchFile, type SketchPayload } from './sketch-import';
import { useDesignerPorts } from '../store/designer-context';

/**
 * AI 生成界面（T3-11 要点 1）。
 *
 * 流程：自然语言描述（可选草图）→ 经 `DesignGenerationPort` 生成 → zod + 组件白名单校验
 * → 落地画布（**仍可自由拖拽修改**）→ 自动写入页面记忆。
 *
 * 降级链：解析失败 **重试 1 次** → 仍失败且带草图时**降级为纯文本生成** → 再失败给中文错误。
 * Provider 不支持视觉时，草图上传入口直接禁用并提示。
 */

export interface GeneratePanelProps {
  projectId: string;
  pageId: string;
  platform: Platform;
  route: string;
  /** 生成成功后回调（落到画布 / 写页面记忆由调用方或本组件负责） */
  onGenerated?: (dsl: PageDsl, meta: { issues: AiDslIssue[]; degraded: boolean; usedSketch: boolean; attempts: number }) => void;
  /** 目标元素规模提示 */
  elementBudget?: number;
}

interface GenerationState {
  status: 'idle' | 'running' | 'done' | 'failed';
  message: string | null;
  issues: AiDslIssue[];
  attempts: number;
  degraded: boolean;
}

export function GeneratePanel({ projectId, pageId, platform, route, onGenerated, elementBudget = 20 }: GeneratePanelProps): React.ReactElement {
  const ports = useDesignerPorts();
  const design = ports.design;
  const vision = isVisionSupported(design);

  const [prompt, setPrompt] = React.useState('');
  const [sketch, setSketch] = React.useState<SketchPayload | null>(null);
  const [state, setState] = React.useState<GenerationState>({ status: 'idle', message: null, issues: [], attempts: 0, degraded: false });

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const context: DslFromAiContext = { id: pageId, projectId, name: prompt.slice(0, 12) || 'AI 生成页面', platform, route };

  const attempt = async (useSketch: SketchPayload | null): Promise<ReturnType<typeof dslFromAi>> => {
    if (design === undefined) {
      return { dsl: null, issues: [{ kind: 'invalid-structure', message: '未接入 AI 生成能力（缺少 design 端口）' }], degraded: false };
    }
    const result = await design.generatePage({
      prompt,
      projectId,
      platform,
      route,
      elementBudget,
      ...(useSketch !== null ? { sketch: { kind: useSketch.kind, value: useSketch.value } } : {}),
    });
    if (typeof result.candidate === 'object' && result.candidate !== null) {
      return dslFromAi(result.candidate, context);
    }
    return { dsl: null, issues: [{ kind: 'invalid-structure', message: '模型返回内容无法解析为 JSON' }], degraded: false };
  };

  const generate = async (): Promise<void> => {
    if (prompt.trim().length === 0) {
      setState({ status: 'failed', message: '请先描述你想要的界面', issues: [], attempts: 0, degraded: false });
      return;
    }
    if (design === undefined) {
      setState({ status: 'failed', message: '未接入 AI 生成能力（缺少 design 端口）', issues: [], attempts: 0, degraded: false });
      return;
    }

    setState({ status: 'running', message: '正在生成…', issues: [], attempts: 0, degraded: false });
    let attempts = 0;
    let result = await attempt(sketch);
    attempts += 1;

    if (result.dsl === null) {
      // 解析失败：重试 1 次
      result = await attempt(sketch);
      attempts += 1;
    }

    let usedSketch = sketch !== null;
    if (result.dsl === null && sketch !== null) {
      // 仍失败：降级为纯文本生成
      result = await attempt(null);
      attempts += 1;
      usedSketch = false;
    }

    if (result.dsl === null) {
      setState({
        status: 'failed',
        message: '生成失败：模型输出无法解析为合法页面结构，请调整描述后重试',
        issues: result.issues,
        attempts,
        degraded: false,
      });
      return;
    }

    // 自动写入页面记忆（端口缺省时跳过）
    try {
      await ports.memory?.writePageStructure({ projectId, pageId, dsl: result.dsl });
    } catch {
      // 记忆写入失败不应阻断「已经生成好的界面」
    }

    setState({
      status: 'done',
      message: `已生成 ${countElements(result.dsl)} 个元素${usedSketch ? '（含草图）' : ''}`,
      issues: result.issues,
      attempts,
      degraded: result.degraded,
    });
    onGenerated?.(result.dsl, { issues: result.issues, degraded: result.degraded, usedSketch, attempts });
  };

  const onPickFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    const read = await readSketchFile(file);
    if (!read.ok) {
      setState({ status: 'failed', message: read.message, issues: [], attempts: 0, degraded: false });
      return;
    }
    setSketch(read.payload);
    setState({ status: 'idle', message: `已选择草图：${describeSketch(read.payload)}`, issues: [], attempts: 0, degraded: false });
  };

  return (
    <section className="ec-generate-panel" data-testid="generate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={{ fontSize: 13 }}>AI 生成界面</strong>
        <Tag color="info">{`目标约 ${elementBudget} 个元素`}</Tag>
        <span style={{ flex: 1 }} />
        {state.degraded && <Tag color="warning">已降级</Tag>}
      </header>

      <Textarea
        aria-label="界面描述"
        rows={3}
        value={prompt}
        placeholder="例如：做一个登录页，包含手机号、密码、记住登录与注册入口"
        onChange={setPrompt}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: vision ? 1 : 0.5 }}>
          <Switch
            aria-label="使用草图"
            checked={sketch !== null}
            disabled={!vision}
            onChange={(checked) => {
              if (!checked) {
                setSketch(null);
                return;
              }
              fileInputRef.current?.click();
            }}
          />
          使用草图
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="上传草图"
          disabled={!vision}
          style={{ display: 'none' }}
          onChange={(event) => {
            void onPickFile(event);
          }}
        />
        {!vision && (
          <span data-testid="vision-unsupported" style={{ fontSize: 12, color: 'var(--ec-color-warning, #b8860b)' }}>
            当前模型不支持图片理解，草图上传已禁用（可直接用文字描述）
          </span>
        )}
        {sketch !== null && <Tag color="success">{describeSketch(sketch)}</Tag>}
        <span style={{ flex: 1 }} />
        <Button variant="primary" data-testid="generate-button" disabled={state.status === 'running'} onClick={() => void generate()}>
          {state.status === 'running' ? '生成中…' : '生成界面'}
        </Button>
      </div>

      {state.message !== null && (
        <p
          data-testid="generate-status"
          role={state.status === 'failed' ? 'alert' : 'status'}
          style={{ fontSize: 12, color: state.status === 'failed' ? 'var(--ec-color-danger, #e5484d)' : 'inherit' }}
        >
          {state.message}
          {state.attempts > 1 && `（尝试 ${state.attempts} 次）`}
        </p>
      )}

      {state.issues.length > 0 && (
        <ul data-testid="generate-issues" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          {state.issues.map((issue, index) => (
            <li key={`${issue.kind}-${index}`} data-issue-kind={issue.kind}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
