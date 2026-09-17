import { backendCodeTemplate, buildBackendCodePrompt } from './backend-code';
import { commitMsgTemplate, buildCommitMsgPrompt } from './commit-msg';
import { desktopCodeTemplate, buildDesktopCodePrompt } from './desktop-code';
import { frontendCodeTemplate, buildFrontendCodePrompt } from './frontend-code';
import { harmonyCodeTemplate, buildHarmonyCodePrompt } from './harmony-code';
import { interfaceTemplate, buildInterfacePrompt } from './interface';
import { mobileCodeTemplate, buildMobileCodePrompt } from './mobile-code';
import { requirementTemplate, buildRequirementPrompt } from './requirement';
import { techdocTemplate, buildTechdocPrompt } from './techdoc';
import {
  COMMON_CONSTRAINTS,
  GENERATION_TARGETS,
  UNIVERSAL_NEGATIVE_CONSTRAINTS,
  composeTemplate,
  renderTemplate,
  type GenerationTarget,
  type PromptTemplate,
  type PromptTemplateInput,
  type TemplateConfig,
} from './shared';

/**
 * 九类提示词模板表（T4-04 要点 2）。
 *
 * 用法：
 * ```ts
 * const { system, user } = buildPromptFor('backend-code', { instruction: '……', stack: 'Java + Spring Boot' });
 * ```
 */

export const PROMPT_TEMPLATES: Readonly<Record<GenerationTarget, PromptTemplate>> = {
  requirement: requirementTemplate,
  interface: interfaceTemplate,
  techdoc: techdocTemplate,
  'backend-code': backendCodeTemplate,
  'frontend-code': frontendCodeTemplate,
  'mobile-code': mobileCodeTemplate,
  'harmony-code': harmonyCodeTemplate,
  'desktop-code': desktopCodeTemplate,
  'commit-msg': commitMsgTemplate,
};

/** 端矩阵 → 默认技术方案（FR-AI-13；项目记忆未指定时使用） */
export const DEFAULT_STACKS: Record<GenerationTarget, string> = {
  requirement: '—',
  interface: 'EveryoneCoding PageDSL',
  techdoc: '—',
  'backend-code': 'TypeScript + Node（NestJS 风格分层：controller/service/dto/repo）',
  'frontend-code': 'React 18 + TypeScript + Vite',
  'mobile-code': 'Flutter（Dart，单代码库覆盖 Android 与 iOS）',
  'harmony-code': 'ArkTS + ArkUI（Stage 模型）',
  'desktop-code': 'Tauri 2（Rust 命令层 + WebView）',
  'commit-msg': '—',
};

export function templateFor(target: GenerationTarget): PromptTemplate {
  return PROMPT_TEMPLATES[target];
}

/** 渲染指定目标的提示词；未指定 stack 时自动补端默认方案 */
export function buildPromptFor(
  target: GenerationTarget,
  input: PromptTemplateInput = {},
): { system: string; user: string; template: PromptTemplate } {
  const merged: PromptTemplateInput = {
    ...input,
    stack: input.stack === undefined || input.stack === null ? DEFAULT_STACKS[target] : input.stack,
  };
  return renderTemplate(PROMPT_TEMPLATES[target], merged);
}

export {
  COMMON_CONSTRAINTS,
  GENERATION_TARGETS,
  UNIVERSAL_NEGATIVE_CONSTRAINTS,
  composeTemplate,
  renderTemplate,
  buildBackendCodePrompt,
  buildCommitMsgPrompt,
  buildDesktopCodePrompt,
  buildFrontendCodePrompt,
  buildHarmonyCodePrompt,
  buildInterfacePrompt,
  buildMobileCodePrompt,
  buildRequirementPrompt,
  buildTechdocPrompt,
  backendCodeTemplate,
  commitMsgTemplate,
  desktopCodeTemplate,
  frontendCodeTemplate,
  harmonyCodeTemplate,
  interfaceTemplate,
  mobileCodeTemplate,
  requirementTemplate,
  techdocTemplate,
};
export type { GenerationTarget, PromptTemplate, PromptTemplateInput, TemplateConfig };
