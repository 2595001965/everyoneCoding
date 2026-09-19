import {
  composeTemplate,
  renderTemplate,
  type PromptTemplate,
  type PromptTemplateInput,
} from './shared';

/**
 * 提交信息模板（Conventional Commits，AI 生成节点自动提交时使用，FR-GIT-09）。
 *
 * 与其他模板的区别：产物不是文件，而是一段提交信息文本。
 * 因此**覆写输出契约**，只要求 `summary`（首行）+ `notes`（正文）+ `decision.risks`，
 * 不要求 files / anchors，避免模型为了凑格式编造文件清单。
 */
export const COMMIT_MSG_CONTRACT = [
  '## 输出契约（必须严格遵守）',
  '只输出一个 JSON 对象，不要包裹解释性文字。',
  '结构如下：',
  '{',
  '  "summary": "type(scope): 一句话说明（Conventional Commits）",',
  '  "notes": "提交正文：变更点逐条列出，每行以 - 开头",',
  '  "decision": { "referencedMemory": [], "rationale": "为什么这样改", "risks": ["潜在风险"], "uncovered": ["未覆盖点"] }',
  '}',
  '要求：files 与 anchors 必须为空数组；summary 首行不超过 72 个字符。',
].join('\n');

export const commitMsgTemplate: PromptTemplate = composeTemplate({
  id: 'commit-msg',
  label: '提交信息',
  systemRole:
    '你是 EveryoneCoding 的提交信息撰写者。你只输出符合 Conventional Commits 规范的提交信息，不做任何代码改动。',
  task: '请依据本次生成的变更说明（summary）、文件清单与决策说明，撰写一条提交信息：首行为 `type(scope): 简述`，正文逐条列出变更点。',
  constraints: [
    'type 只能取 feat / fix / refactor / perf / docs / test / chore / build 之一。',
    'scope 用受影响的模块名（英文小写）。',
    '禁止把文件清单原样堆进正文，正文要说明"为什么"而不只是"改了什么"。',
    '不输出 files 与 anchors（本任务不产生文件）。',
  ],
  outputContract: COMMIT_MSG_CONTRACT,
  requiresAnchors: false,
});

export function buildCommitMsgPrompt(input: PromptTemplateInput = {}) {
  return renderTemplate(commitMsgTemplate, input);
}
