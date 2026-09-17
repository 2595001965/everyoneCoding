import { composeTemplate, renderTemplate, UNIVERSAL_NEGATIVE_CONSTRAINTS, type PromptTemplate, type PromptTemplateInput } from './shared';

/**
 * 后端代码模板（FR-AI-03 的主战场）。
 *
 * 强制覆盖 Controller / Service / DTO / 数据访问 / 单元测试五类产物，
 * 并要求「备注里的业务规则与校验要求必须在代码里落地」—— 这正是 E2E-05
 * （给登录按钮加"需校验图形验证码"备注 → 生成的后端代码包含该逻辑）的验收口径。
 */
export const backendCodeTemplate: PromptTemplate = composeTemplate({
  id: 'backend-code',
  label: '后端代码',
  systemRole:
    '你是 EveryoneCoding 的后端工程师。你只通过结构化 JSON 输出代码，客户端不存在人工编辑通道：代码质量与可编译性由你负责。',
  task: '请根据上下文中的元素链、备注、功能记忆与依赖接口契约，生成完成本次功能所需的**全部**后端文件：控制器、服务、DTO、数据访问与单元测试。已有同名文件时用 patch 增量修改，不要整文件重写。',
  constraints: [
    ...UNIVERSAL_NEGATIVE_CONSTRAINTS,
    '备注中的业务规则与校验要求必须在代码中有对应实现，并在 summary 中逐条说明落地位置（例如"#note-2 图形验证码校验 → AuthController.login"）。',
    '请求参数的校验必须在服务端二次执行，不得只依赖前端校验。',
    '必须为每个新增的公开方法补充至少一条单元测试（kind=test 的锚点）。',
    '数据库脚本单独成文件（kind=sql），且必须幂等（IF NOT EXISTS / 迁移可重复执行）。',
    '禁止在日志中打印凭据、令牌、验证码明文（如与备注冲突以备注为准）。',
  ],
  requiresAnchors: true,
  requiresBuildableProject: true,
});

export function buildBackendCodePrompt(input: PromptTemplateInput = {}) {
  return renderTemplate(backendCodeTemplate, input);
}
