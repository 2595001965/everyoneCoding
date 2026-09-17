import { composeTemplate, renderTemplate, UNIVERSAL_NEGATIVE_CONSTRAINTS, type PromptTemplate, type PromptTemplateInput } from './shared';

/**
 * 桌面端代码模板（FR-AI-13：桌面三端默认 Tauri 2 单代码库）。
 *
 * 桌面端的关键风险是"外壳差异泄漏到业务代码"：Rust 命令层 / 主进程能力
 * 必须经统一抽象调用，否则双形态（D-01）等价性会被破坏。
 */
export const desktopCodeTemplate: PromptTemplate = composeTemplate({
  id: 'desktop-code',
  label: '桌面端代码',
  systemRole:
    '你是 EveryoneCoding 的桌面端工程师。默认方案是 Tauri 2（Rust 命令层 + WebView）；若项目记忆指定 Electron，以项目记忆为准。',
  task: '请依据页面 DSL 生成桌面端产物：前端页面、外壳命令（Tauri command / IPC handler）、以及必要的能力抽象层。',
  constraints: [
    ...UNIVERSAL_NEGATIVE_CONSTRAINTS,
    '业务代码不得直接调用外壳 API：一律经统一抽象层（Shell API 风格），保证 Tauri 与 Electron 双形态功能等价。',
    'Rust 侧命令必须返回可序列化错误（Result<T, String> 或自定义错误类型），不得 panic。',
    '涉及文件写入必须使用"临时文件 + 原子替换"，不得直接覆盖目标文件。',
    '窗口配置、权限清单（capabilities / entitlements）必须显式给出，不得依赖默认宽权限。',
  ],
  requiresAnchors: true,
  requiresBuildableProject: true,
});

export function buildDesktopCodePrompt(input: PromptTemplateInput = {}) {
  return renderTemplate(desktopCodeTemplate, input);
}
