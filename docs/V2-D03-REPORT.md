# V2-D03：运行 DOM 选取与可验证源码映射

任务：V2-D03。状态：**已实现待验收**。验证日期：2026-10-02，Windows，Node v24.21.0，Electron 33。

已阅读增量任务通用规则、D02/D03 卡、PRD §5 和当前仓库说明。本记录只更新 D03；保留其他任务的在途改动。本次没有执行 Git 提交、推送、部署或真实付费模型调用。

## 复用与 D02 核验

复用 `PreviewFrame`、预览域/受控进程、D02 的确认计划与 `RuntimeOrchestrator`、公共 `ElementAnchor`/`SourceRef`/`SourceRevision`、既有前端文件导航、SettingStore 和 AI 上下文组合器。生成期 `elementId`、DOM id、CSS selector 和文本均不作为任意源码映射依据。

已复跑 D02 运行器 7 项、真实域运行 9 项及既有运行端口 24 项。D03 原生 E2E 另外通过生产 `confirmRunPlan → startRun` 启动 React/Vue Vite 子进程，使用当前运行实例的 runtimeId、真实预览代理、IPC 和生产 DOM 检查 UI。开发服务器不是测试端口替身，源码映射也不是仅在夹具服务器中注入后宣称接线完成。

针对 D03 的必要接线包括根 cwd `.` 的解析、预览 RPC 白名单、开发期编译桥、沙箱模块的限域 GET CORS、前端退出时撤销映射会话。真实 Electron 验证发现 `agent:false` 的上游连接会让部分大模块响应停在尾段；代理改用 Node 的默认连接代理后，React/Vue 原生加载、共享组件和 HMR 验证通过。没有放开 iframe 的宿主权限。

## 本次增量

- `packages/preview/src/dom/`：浏览器安全契约、DOM 选择器和 Node 侧源码登记。提前安装窗口捕获监听；选择态阻断点击、键盘、表单、导航等业务事件；hover/选中框随滚动、缩放更新，支持祖先选择、实例序号与失效提示。
- 消息验证覆盖当前 iframe WindowProxy、opaque origin、projectId/runtimeId/nonce、documentId、严格载荷和递增序号；旧文档/重放/伪造身份不进入当前选择。宿主命令也校验来源、身份、字段集合和载荷。ready/hello 握手处理监听建立与页面加载的时序。
- 原始 HTML 用 parse5、JSX/TSX 用 TypeScript AST、Vue SFC template 用 Vue parser 取原文件行列与组件/符号。随机 token 只在本运行实例的登记表内解析；每次定位和附加都重新读取真实源码并校验 SHA-256。HMR 源码变化淘汰旧 token。
- `dom-vite-bridge.ts` 在已确认的标准 Vite 开发命令上生成临时配置，保留工程原配置、先于框架编译进行登记。私有编译 RPC 仅接受回环连接、独立 capability、无 Origin 的受控 POST，并要求输入等于原文件；页面 nonce 不授权编译 RPC。配置文件位于项目 meta，开发服务器拒绝提供这些文件。工程源码不落入调试属性。
- `DomInspector` 在既有工作台交付交互/选取、hover、祖先链、映射可信度、源码行列/修订、共享组件范围、源码定位、备注、插入位置和目标页面。附加共享组件前需要明确确认范围。
- 备注经生产 preview 域持久化，附加对象进入现有 AI 上下文组合器。过期或删除文件的附加对象不进入上下文；备注/运行页面文本作为不可信数据。修改依然使用已有计划、diff、确认和 WritePipeline，检查器本身没有业务 DOM 改写或源码写入口。

## 逐项实际验证

| 范围                      | 实际结果与限制                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOM-01 真实选取与业务隔离 | Electron sandbox iframe 中以原生 CDP 鼠标/键盘选取删除按钮、提交按钮、导航链接；删除/提交计数保持 0，导航不发生。切回交互后业务点击正常，Enter 在选择态不提交，Esc 退出。滚动和桌面缩放后 overlay 仍覆盖真实元素。                                                                                                        |
| DOM-02 动态页面与失效     | 真实业务按钮创建动态节点后可选；未登记节点为 unresolved，定位/附加禁用。静态文件修订、SPA 路由变化、React/Vue HMR 和停止运行后，旧选择或会话失效，必须重新选择。                                                                                                                                                          |
| DOM-03 身份与隐私         | 当前 iframe/origin/运行身份/nonce/document/序号及载荷反例通过。原生页面不能访问 require、ecShell 或 Tauri 内部桥；带伪造 filePath 字段的宿主命令被拒绝。密码输入选择的载荷不含 value，祖先摘要也不读取表单值。                                                                                                            |
| DOM-04/05 源码事实        | 静态按钮定位 `index.html:3:1`，生产导航目标为真实文件行。React/Vue 两个 Shared 实例定位原 `Shared.jsx` / `Shared.vue` 第 2 行，映射为 react_compiled / vue_compiled、exact，带原文件 SHA-256 与行列；变更后旧映射 unresolved、新映射匹配真实新文件。作者自写调试属性、库/构建路径、未知 token、不可确认转换不被猜成源码。 |
| DOM-06 上下文             | 原生 UI 输入备注并附加，经 preload/IPC、生产域、SettingStore 进入现有上下文；含位置、目标页、源文件和修订。关联接口目前明确显示“暂无经核验关联”，没有根据元素文字捏造接口关系。                                                                                                                                           |
| DOM-07 源码修改与共享范围 | React/Vue 当前页 2 个同源实例可见；共享影响确认前附加禁用。测试实际写入 Shared 源文件，把 Shared action 改为 HMR updated，页面经真实 HMR 更新，hash 与映射更新。选取操作前后原工程源码保持不变，运行时 DOM 变化不作为源码实现证据。本轮未调用模型生成补丁；D09 的定点生成/受控合入仍需其任务验收。                        |
| 生产无插桩                | 真实 React/Vue 原始源码夹具执行 Vite production build，扫描全部输出：无 data-ec-source、ec-dom-v1、ec-local-dom-inspection。开发期插件限定 apply:serve；构建前后原文件内容相同。                                                                                                                                          |
| DOM-08 支持边界           | iframe、Shadow DOM、canvas/原生控件显示宿主边界降级；没有声称可穿透跨源 iframe、闭合 shadow 或恢复第三方/压缩代码的准确源码。此为 P1 限制说明，未扩展成额外内核实现。                                                                                                                                                     |

原生证据：[选取截图](evidence/v2-d03/dom-selection.png)、[结构化结果](evidence/v2-d03/result.json)。截图已实际查看。测试窗口是实际 Electron 离屏窗口，截图与鼠标/键盘事件来自原生 Chromium；它不等同于 Tauri GUI 或真实模型质量验收。

## 执行命令与结果

最终串行专项/相关回归 **9 文件、97 项通过**：

```powershell
node node_modules/vitest/vitest.mjs run packages/preview/src/__tests__/dom-mapping.test.ts apps/desktop-electron/src/main/__tests__/dom-inspection.test.ts apps/renderer/src/features/preview/__tests__/dom-frame.test.tsx apps/renderer/src/features/preview/__tests__/preview-toolbar.test.tsx packages/preview/src/__tests__/runtime-orchestrator.test.ts packages/shell-api/src/__tests__/domain-control.test.ts apps/desktop-electron/src/main/__tests__/domain-production.test.ts apps/desktop-electron/src/main/__tests__/domain-preview-run.test.ts apps/desktop-electron/src/main/__tests__/domain-run-ports.test.ts --no-file-parallelism
```

真实 Electron E2E **2 文件、2 项通过**，其中 D03 单项内部包含静态页、React、Vue、共享实例、生产接线、HMR、RPC/上下文和无插桩生产构建：

```powershell
node node_modules/vitest/vitest.mjs run -c e2e/vitest.config.ts e2e/domain/e2e-27-dom-inspection.test.ts e2e/domain/e2e-26-electron-pipeline.test.ts --no-file-parallelism
```

命令中 e2e-26 为既有真实 Electron 流水线暂停、退出、重启恢复回归。补宿主命令字段验证后另行复跑 e2e-27 和映射/消息 8 项。

```powershell
node node_modules/eslint/bin/eslint.js packages/preview/src/dom apps/desktop-electron/src/main/domain/dom-inspection.ts apps/desktop-electron/src/main/domain/dom-vite-bridge.ts apps/renderer/src/features/preview/DomInspector.tsx apps/renderer/src/features/preview/PreviewFrame.tsx e2e/electron/dom-main.ts e2e/electron/dom-renderer.tsx e2e/domain/e2e-27-dom-inspection.test.ts --max-warnings 0
node node_modules/typescript/bin/tsc -p packages/preview/tsconfig.json
node node_modules/typescript/bin/tsc -p apps/renderer/tsconfig.json
node scripts/build-sidecar.mjs
```

专项 ESLint、preview/renderer 类型检查通过。最后一条在 `apps/desktop-electron` 执行，侧车构建成功：protocol=1，507 modules。变更文件运行 Prettier 检查、`git diff --check`。

## 尚未通过的仓库门禁与外部边界

- 整站 `apps/renderer` Vite build 失败：`ProviderList.tsx` 引入的 `PROVIDER_SOURCE_LABELS` 未由 `packages/ai/src/browser.ts` 导出。D03 的实际 renderer 特性 bundle、原生 E2E 及 React/Vue 原始工程 production build 通过，整站构建不能标绿。
- `tsc -p apps/desktop-electron/tsconfig.json` 仍失败：D02 测试中两个未使用导入、task-write 测试的 `CommitInput.message`、usage-domain 的 `AttemptFilter` exactOptionalPropertyTypes。没有为 D03 顺手修改其他任务。
- `tsc -p e2e/tsconfig.json` 仍失败：e2e-26 的环境变量对象未声明 `ELECTRON_RUN_AS_NODE` 索引。实际原生 e2e-26 执行通过，E2E 全目录类型检查仍应如实保留失败。
- 首轮把原生 E2E 与端口回归同时运行，产生 4173 端口冲突；最终改为分批串行，97 项全部通过。没有放宽端口断言或跳过测试。
- 未运行 Tauri 原生 GUI、发行安装包、付费模型补丁生成或 D16 全仓验收。因此任务状态保留“已实现待验收”，不标为全部已验收。
- 自动审批拒绝删除本会话临时测试目录的清理命令，返回 `blocked by policy`；两个早期 `.tmp-dom-e2e-*` 目录和诊断日志保留，不影响上述执行结果。
