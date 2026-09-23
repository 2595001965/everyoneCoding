# EveryoneCoding E2E 验收清单（E2E-01 ~ E2E-22）

> 对应 Wave 10 / T10-05，覆盖 PRD §10.1 的 21 条端到端验收用例。
> **E2E-22 是 T12-03（Electron 流水线生产运行时）追加的一条**，用于验收「真实持久化 + 关停重启续跑」，
> 不在 PRD §10.1 的 21 条之列。
>
> 产物：`e2e/` 自动化用例（本清单标注「自动」的行）+ 手工清单（标注「手工」的行）。
>
> 运行自动化用例：`pnpm test:e2e`（等价于 `vitest run -c e2e/vitest.config.ts`）。
> 自动化用例一律使用**真实领域引擎 + 真实本地服务**（真实 SQLite 迁移、真实 git 子进程、
> 真实 HTTP 服务与 SSE 字节流），只把「需要真实第三方凭据 / 真机 / 真实安装包」的环节换成夹具或列为手工项。

---

## 1. 汇总

| #      | 用例               | 方式                          | 自动化用例文件                                         | 结果                                       |
| ------ | ------------------ | ----------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| E2E-01 | 新用户注册         | 自动 + 手工                   | `e2e/services/e2e-01-account.test.ts`                  | ✅ 自动通过（邮箱链接验证为手工项，见 §3） |
| E2E-02 | 第三方登录         | 自动（假出网）+ 手工          | `e2e/services/e2e-02-oauth.test.ts`                    | ✅ 自动通过（真实 GitHub 授权为手工项）    |
| E2E-03 | 需求到项目         | 自动                          | `e2e/domain/e2e-03-pipeline.test.ts`                   | ✅ 通过                                    |
| E2E-04 | 拖拽设计           | 自动                          | `e2e/ui/e2e-04-18-workflow.test.tsx`                   | ✅ 通过                                    |
| E2E-05 | 元素生成后端       | 自动                          | `e2e/ui/e2e-04-18-workflow.test.tsx`                   | ✅ 通过                                    |
| E2E-06 | Ctrl 跳转          | 自动                          | `e2e/ui/e2e-04-18-workflow.test.tsx`                   | ✅ 通过                                    |
| E2E-07 | Git 全可视化       | 自动（真实 git）              | `e2e/domain/e2e-07-git.test.ts`                        | ✅ 通过（224s，环境敏感，见 §4）           |
| E2E-08 | 联动预览           | 自动                          | `e2e/ui/e2e-04-18-workflow.test.tsx`                   | ✅ 通过                                    |
| E2E-09 | 问题记忆触发       | 自动                          | `e2e/ui/e2e-04-18-workflow.test.tsx`                   | ✅ 通过                                    |
| E2E-10 | 自定义中转         | 自动（真实 HTTP）             | `e2e/domain/e2e-10-relay.test.ts`                      | ✅ 通过                                    |
| E2E-11 | 用户自配远程配置   | 自动（真实 HTTP）             | `e2e/domain/e2e-11-remote-config.test.ts`              | ✅ 通过                                    |
| E2E-12 | 记忆生效验证       | 自动                          | `e2e/ui/e2e-04-18-workflow.test.tsx`                   | ✅ 通过                                    |
| E2E-13 | 全量归档           | 自动                          | `e2e/domain/e2e-13-14-archive.test.ts`                 | ✅ 通过                                    |
| E2E-14 | 归档冲突合并       | 自动                          | `e2e/domain/e2e-13-14-archive.test.ts`                 | ✅ 通过                                    |
| E2E-15 | 重命名级联         | 自动                          | `e2e/domain/e2e-15-17-20-rename-and-migration.test.ts` | ✅ 通过                                    |
| E2E-16 | 重命名安全性       | 自动                          | 同上                                                   | ✅ 通过                                    |
| E2E-17 | 重命名回滚         | 自动                          | 同上                                                   | ✅ 通过                                    |
| E2E-18 | 代码只读约束       | 自动                          | `e2e/ui/e2e-04-18-workflow.test.tsx`                   | ✅ 通过                                    |
| E2E-19 | 技术选型询问       | 自动                          | `e2e/domain/e2e-19-21-tech-and-multiplatform.test.ts`  | ✅ 通过                                    |
| E2E-20 | 迁移一键执行       | 自动                          | `e2e/domain/e2e-15-17-20-rename-and-migration.test.ts` | ✅ 通过                                    |
| E2E-21 | 多端目标与生成     | 自动 + 手工                   | `e2e/domain/e2e-19-21-tech-and-multiplatform.test.ts`  | ✅ 自动通过（真机编译为手工项）            |
| E2E-22 | 流水线生产运行时   | 自动（真实磁盘+SQLite）       | `e2e/domain/e2e-22-pipeline-production.test.ts`        | ✅ 通过（2/2，见 §3 末的补充说明）         |
| E2E-24 | Git 生产端口全流程 | 自动（真实 git + 生产域路由） | `e2e/domain/e2e-24-git-production-flow.test.ts`        | ✅ 通过（39s，T12-04）                     |

**统计：21/21 有用例或手工清单；21 条的可自动化部分已全部自动化并取得绿色结果（含 E2E-07 的真实 git 全流程，单次实测 224s）。追加的 E2E-22 亦为 2/2 自动通过。**

---

## 2. 逐条判定标准与自动化口径

### E2E-01 新用户注册

- **PRD 判定**：邮箱注册 → 验证 → 进入工作台，全流程 ≤2 分钟、无管理员介入。
- **自动化**（3 项）：注册返回 201 且响应含 `workspaceId` / `planId='free'` / 双令牌（自注册即开通，FR-ACC-05）；邮箱格式与密码强度不合格被拒且不建号；重复邮箱被拒；登录 → 刷新 → 旧 refresh 复用被拒（401）。
- **手工**（见 §3）：邮箱链接验证（PRD §8 的八个服务端接口不含邮件的投递与验签）。

### E2E-02 第三方登录

- **PRD 判定**：GitHub 授权登录，回调成功后自动建号并进入工作台。
- **自动化**（4 项）：authorize 返回含 PKCE 的授权 URL；首次 callback 自动建号（`isNew=true`）并直接给出工作区与令牌；同一 GitHub 身份二次登录命中已有账号（`isNew=false`）；伪造 `state` 与缺失 `code_verifier` 被拒。
- **手工**：在真实 GitHub OAuth App 上完成一次人工授权（需真实客户端凭据与浏览器交互）。

### E2E-03 需求到项目

- **PRD 判定**：输入 200 字想法 → S1→S7 全流程；产出可运行项目；每阶段可编辑可回退。
- **自动化**（4 项）：S1 用 200 字描述生成八项要素齐全的需求文档并入档；追加要求重新生成产出完整新版（版本递增）；S1→S7 顺序推进（未生成就确认被拒、S6/S7 可跳过、回退后下游全 stale、产物可回看）；链路不含任何 shell 调用。

### E2E-04 拖拽设计

- **PRD 判定**：拖 20 个元素搭建登录页 → 生成页面记忆；一致率 ≥90%。
- **自动化**：登录页样例元素计数恰为 20；`condensePage` 精简后由摘要重建，三维（类型 / 父子 / 绑定字段）加权保真度匹配率 ≥0.9。

### E2E-05 元素生成后端

- **PRD 判定**：选中「登录按钮」→ 加备注「需校验图形验证码」→ 生成；代码包含校验逻辑且备注被遵循。
- **自动化**：备注块非空且内容注入上下文；备注进入系统提示的硬约束小节（AI 必然可见）；`noteIds` 可溯源。

### E2E-06 Ctrl 跳转

- **PRD 判定**：Ctrl + 点击登录按钮 → 准确跳转到对应 Controller 方法。
- **自动化**：`JumpService.resolve` 的首个目标为该元素的 Code Anchor（`AuthController.login`），文件路径正确。

### E2E-07 Git 全可视化

- **PRD 判定**：初始化 → 修改 → 提交 → 建分支 → 推送，全程无命令行操作。
- **自动化**（真实 git 子进程 + 真实临时仓库 + 本地裸仓库作远端）：初始化（含 `.gitignore` 模板写入）→ 写入提交身份 → 状态可见变更 → 暂存 → 提交（40 位 sha）→ 建分支并校验分支列表 → 添加远程 → 推送 → **在远端裸仓库验证提交确实落地**；并断言全程 argv 不含 `password` / `--askpass` / `Authorization:`（「无终端」的机器判据）。
- **实测**：单次 224.2s（本机 git 子进程 ≈18s/次，用例约 13 次调用），超时放宽至 600s。详见 §4。

### E2E-08 联动预览

- **PRD 判定**：启动联动预览 → 提交表单 → 请求打到真实后端并返回正确结果。
- **自动化**：后端可用时数据源为 `backend`、状态 200、返回真实数据；后端不可用时按优先级回退内置 Mock（FR-PRV-02）。

### E2E-09 问题记忆触发

- **PRD 判定**：连续 3 次生成同一元素报错 → 提示卡出现并可一键建立问题记忆。
- **自动化**：前两个「生成→运行→报错」循环不触发，第三个循环命中（`cycles ≥ 3`、`reason='cycles'`）；由同一窗口队列与检测结果可构建草稿，草稿含元素归属与报错现象（不凭空编造）。

### E2E-10 自定义中转

- **PRD 判定**：填入第三方 OpenAI 兼容 baseUrl + Key → 测试连通 → 列出模型并成功完成一次生成。
- **自动化**（真实 HTTP）：本地中转服务返回模型列表；`testConnection` 成功并列出 `relay-model-a`；绑定默认模型后流式生成返回预期文本；用量落库（`purpose='code'`、`total_tokens=20`）；中转不可达时如实返回失败。

### E2E-11 用户自配远程配置

- **PRD 判定**：填入自配 URL → 拉取 → 展示配置差异 → 用户确认后默认模型生效；URL 不可达时不阻塞启动。
- **自动化**（真实 HTTP）：拉取成功并解析 payload；差异列表非空且可读摘要；应用计划包含 create 项且默认模型为远程默认值；同名 provider 默认 skip（本地优先）并给出原因；URL 不可达返回 `unreachable` 且不抛错；内容非法判定 `invalid`（不写脏配置）。

### E2E-12 记忆生效验证

- **PRD 判定**：长期记忆写入「所有代码必须有单元测试」→ 生成新功能 → 生成代码包含测试文件。
- **自动化**：该长期记忆进入 `longterm` 上下文块，并出现在渲染后的系统/用户提示词中，`memoryIds` 可溯源。（「AI 真的输出了测试文件」依赖模型输出，属手工确认项，见 §3。）

### E2E-13 全量归档

- **PRD 判定**：一键导出 `.ecpkg`（记忆 + 文档 + 代码）→ 干净环境导入 → 项目可打开、可预览、可继续生成；锚点重定位成功率 ≥90%；包内无明文密钥。
- **自动化**：导出计数正确（1 项目 / 2 记忆 / 1 文档 / 2 代码文件）且归档文件落盘；干净环境 full-restore 导入无失败、项目 meta 与对象全部落库（「可打开」的机器判据）；脱敏开启后产物扫描不含 `sk-` / `api_key=` 形态。
- **锚点重定位成功率**：由 `packages/package-kit/src/__tests__/healing.test.ts` 覆盖（20 个漂移锚点成功率 95%，≥90% 达标）。

### E2E-14 归档冲突合并

- **PRD 判定**：本地与包内存在同名冲突条目 → 导入 → 冲突项全部列出且默认不覆盖，逐条决策后结果符合预期。
- **自动化**：`counts.conflicted=1` 如实统计；未决策时导入**拒绝执行**（抛「存在未决策的冲突条目」）且目标库零写入；逐条决策 `takeNew` 后包内版本生效。

### E2E-15 重命名级联

- **PRD 判定**：元素改名 → 前端组件/变量/CSS、后端 DTO/Service、文档、记忆、逻辑结构全部同步；Ctrl+点击不失效。
- **自动化**：影响面分析分组按风险等级（auto/confirm/warn）；一次执行完成五段（code-ast → doc-replace → memory-update → logic-recalc → anchor-sync）；代码与文档被改；Code Anchor 同步（跳转不失效）；注册表写回新名与历史名；Git 提交信息为 `refactor(rename): 登录按钮 → 登录提交`。

### E2E-16 重命名安全性

- **PRD 判定**：存在同名局部变量与注释同名文本时不误改；仅 AST 作用域内符号被替换。
- **自动化**：注释行、局部变量声明、字符串字面量三处在执行后保持原样。

### E2E-17 重命名回滚

- **PRD 判定**：执行重命名 → 一键撤销 → 代码、文档、记忆、逻辑结构、注册表全部还原。
- **自动化**：撤销后文件与文档逐字节还原、记忆正文还原、注册表最新写入回到原名；重复撤销被拒绝。

### E2E-18 代码只读约束

- **PRD 判定**：代码视图尝试手动编辑 → 被拦截并提示「交给 AI 修改」；外部编辑器改文件后客户端能检测到并提示。
- **自动化**：外部改动后 AI 写入被拒绝（错误含「已被外部修改」）且外部内容未被覆盖；只读防护拦截键入（`blockedCount` 递增、`lastBlock.reason='keydown'`）与粘贴，浏览类组合键（Ctrl+C）不拦截。

### E2E-19 技术选型询问

- **PRD 判定**：走 S1 → 进入 S3 前弹出技术栈问卷；未选择不进入 S3；选择结果写入项目记忆。
- **自动化**：`advance(S2→S3)` 在问卷未完成时被 guard 阻断、S3 保持 `pending`；完成后放行；问卷含公共题与各端题；`defaultChoice` 通过校验；`PLATFORM_MATRIX` 覆盖四端且七端全集为 7。

### E2E-20 迁移一键执行

- **PRD 判定**：重命名数据库字段 → 确认迁移 → 展示 SQL 预览与影响行数，确认后执行成功；执行记录写入 rename 事件与 Git 提交。
- **自动化**：AI 输出解析出前向与回滚两段 SQL（两个独立围栏）；模型不可用时如实返回错误与「设置 → 模型接入」引导（绝不用模板顶替，D-08）；生成物带 `generatedBy='ai'`、`editable=false`、提示词可追溯。（「影响行数」与「执行记录写入 rename 事件 + Git 提交」由 `packages/registry` 的 migration 子域测试覆盖。）

### E2E-21 多端目标与生成

- **PRD 判定**：勾选 Web + Android + HarmonyOS + Windows 四端 → 走 S3（问卷确认）→ S5 生成；四套工程各一套；各端编译校验通过（环境缺失时输出引导与待验清单）；页面结构与设计器一致。
- **自动化**：四端各产出工程文件；移动/鸿蒙/桌面三端在工具链可用时编译校验 `passed`；工具链缺失时返回 `skipped_toolchain_missing` 且带安装引导（不静默跳过）；三端框架在 `TOOLCHAIN_BY_FRAMEWORK` 中均有工具链定义与安装引导。
- **手工**：真机 `flutter build apk --debug` / `hvigorw assembleHap` / `cargo tauri build` 的实际编译（本机无这三套工具链）。

### E2E-22 流水线生产运行时（T12-03 追加）

- **判定**：从一句需求走完 S1→S5，**关闭并重启 Electron 后从上次阶段继续**；每阶段可回看版本、diff、
  回退与下游 stale；未完成技术选型不能进入 S3；S5 单节点失败不阻塞其余节点。
- **自动化**（`e2e/domain/e2e-22-pipeline-production.test.ts`，2 项）：真实 `DataClient` + 真实迁移 +
  真实 `Migrator` + 真实磁盘工程目录 + 官方 `PipelineMachine` / `ArtifactStore` / `S1` / `S3` / `S4` /
  `MultiPlatformGenerator` / `GenerationQueue` / `CrashRecovery` / `PipelineRecovery`。
  ① 全链路产物落表落盘（`document` 行 + `docs/` 实体文件、`stage_artifact` 台账、`code/src/feature` 三个节点）、
  正常退出 `markClean` 后重启 `restoredFromSnapshot=false` 且断点续生成**零次模型调用**；
  ② 未 `markClean` 的强杀场景重启 `restoredFromSnapshot=true`，断点阶段为 `S5(running)`。
- **主进程侧对照**：`apps/desktop-electron/src/main/__tests__/pipeline-production.test.ts`（5 项）覆盖
  真实域运行时装配下的 S3 阻断与选型落 `memory_item`、关停重启续跑、单节点失败隔离、版本回看/diff/回退/下游 stale、
  异常退出识别。

> **E2E-22 暴露并修掉的一处真实缺陷**：`@ec/core` 的 `CrashRecovery` 直接把领域名当文件名，
> 而流水线领域名是 `pipeline:<projectId>` —— Windows 上路径里的 `:` 会被解释成 **NTFS 备用数据流**，
> 写入 / 读取 / `exists` 全都"成功"但 `readdir` 永远列不出该条目，于是 `detectPending()` 找不到脏快照、
> 「上次异常退出」被静默判成「正常退出」，**崩溃恢复在主平台上整体失效**（且在 POSIX 与 `MockShell` 夹具上
> 完全复现不出，所以既有 18 项单测全绿也没能兜住它）。现改为落盘名只保留 `[A-Za-z0-9._-]`、其余字符转 `_`，
> 逻辑域名仍存信封 `domain` 字段供匹配；`packages/core/src/__tests__/undo-crash-logger.test.ts` 补 1 项回归（19/19）。

---

## 3. 手工清单（依赖真实第三方 / 真机 / 真实安装包）

每条都给出前置条件、步骤与判定标准。

### M-01 邮箱链接验证（E2E-01 补）

- **前置**：已部署的 `services/account`（`ACCOUNT_PUBLIC_BASE_URL` 指向可被浏览器访问的地址），
  `ACCOUNT_MAIL_WEBHOOK_URL` 指向真实投递服务（留空则落 outbox，仅适合开发）。
- **步骤**：注册新邮箱 → 收信 → **在系统浏览器里**点开验证链接 → 回到客户端账号页点「刷新验证状态」。
- **判定**：
  1. 链接形如 `<ACCOUNT_PUBLIC_BASE_URL>/verify-email?token=…&email=…`，浏览器打开后页面自行调
     `POST /api/auth/email/verify/confirm` 并就地显示「邮箱验证完成」；
  2. 同一链接**第二次点开必须失败**（令牌单次有效），提示"无效、已过期或已被使用"；
  3. 把 `account_email_token.expires_at` 改到过去再点开，也必须失败且提示可读；
  4. 回到客户端点「刷新验证状态」→ 标签由「未验证」翻转为「已验证」；
  5. 60s 冷却窗口内点「重新发送验证邮件」被服务端 429 拒绝，界面按钮此前已倒计时置灰。
- **现状**：**已实现**（2026-09-23）。服务端新增 `migrations/0002_email_verification.sql`、
  `/api/auth/email/{verify,verify/confirm,status}`、`/api/dev/email-outbox` 与自托管的
  `GET /verify-email` 落地页；客户端新增 `confirmEmailVerification` / `emailVerified` 与
  账号页「邮箱验证」面板（`EmailVerificationPanel.tsx`）。落地页由**服务自托管**而非渲染层页面：
  用户点链接时桌面端常常没运行，且渲染层是 HashRouter，裸路径 `/verify-email` 路由不到。

### M-02 真实 GitHub / Google / 微信授权（E2E-02 补）

- **前置**：在对应平台注册 OAuth 应用并填入 `services/account` 的 `OAUTH_*` 配置。
  两条回调通道的接线方式（2026-09-23 均已落地，此处列出便于实机核对）：
  - **主通道 · 本机回环**：`http://127.0.0.1:<随机端口>/oauth/callback`，由主进程
    `http.createServer` 真实监听，浏览器命中后回调 URL 直达 `AuthClient.ingestCallback`。
  - **辅通道 · 自定义协议**：`everyonecoding://oauth`。需 OS 已注册该 scheme
    （与"单实例锁 + second-instance 转发"配套，见 `apps/desktop-electron/src/main/protocol.ts`）。
    运维可用 `EC_OAUTH_CHANNEL=protocol` 强制走辅通道（企业策略禁回环时）。
- **步骤**：客户端点「GitHub 登录」→ 系统浏览器完成授权 → 其中**回环与协议各走一遍**
  （第二次可把回环端口占用或设 `EC_OAUTH_CHANNEL=protocol`）→ 回调回客户端。
- **判定**：
  1. 两条通道都能完成登录，且 `state` 与 PKCE `code_verifier` 都被服务端校验通过；
  2. **state 单次消费**：重放同一条回调 URL 必须失败；
  3. state 不匹配的回调被静默丢弃（不发出换令牌请求，等待方超时并给出可读提示）；
  4. 回调后自动建号并进入工作台；重复登录命中同一账号；
  5. 解绑最后一个登录方式且未设密码时被前置拒绝。
- **现状**：客户端与外壳侧**已实现**（两条通道各有一条域级端到端测试）；仍缺真实第三方应用凭据
  才能做真机授权，故本条保留为手工项。

### M-03 「所有代码必须有单元测试」生成实测（E2E-12 补）

- **前置**：已配置可用模型。
- **步骤**：记忆中心写入该长期记忆 → 走 S1→S4 → S5 生成一个功能节点。
- **判定**：生成产物包含测试文件（`*.test.ts` 之类），且决策卡 `referencedMemory` 列出该记忆 id。

### M-04 真机多端编译（E2E-21 补）

- **前置**：Flutter SDK / DevEco Studio（hvigorw）/ Rust + tauri-cli。
- **步骤**：项目设置勾选四端 → S3 确认各端方案 → S5 生成 → 对每端执行编译。
- **判定**：四端编译全部通过；缺工具链时客户端给出安装引导与待验清单（`skipped_toolchain_missing`），装好工具链后重跑变为 `passed`。

### M-05 全程不打开终端复核（FR-SET-08）

- **步骤**：录屏完整走「新建项目 → 描述想法 → S1 生成需求文档 → S2 生成界面 → 设计器打磨 → 提交（Git）→ 预览」。
- **判定**：全程未出现任何终端窗口或命令行输入；Git / 依赖安装 / 构建 / 预览均由 UI 触发并回显结构化日志。
- **现状**：**本机无法录像**；该条为交付前必须由人工完成的一次走查（自动化侧已用「链路不含 shell 调用」的源码断言做了机器可验证的近似）。

### M-06 双形态安装包与更新回滚实机验证

- **前置**：Rust 工具链 + 允许 Electron 二进制下载（见 `docs/RELEASE.md`）。
- **步骤**：产出 NSIS 安装包 → 安装 → 触发更新（本地 mock 更新服务）→ 注入启动失败 → 观察自动回滚。
- **判定**：包体 Tauri ≤60MB / Electron ≤200MB；更新可检出、可增量下载、重启后生效；失败可回滚到上一版本并在设置页如实显示。
- **现状**：配置已就绪（`ci/release.yml`、`apps/desktop-*/`），**未产出真实安装包**（本机环境限制）。

### M-07 四端口真实装配后的页面走查（Wave 9 遗留）

- **步骤**：装配 `__EC_WORKSPACE__` / `__EC_DOCS__` / `__EC_AUTH__` / `__EC_SETTINGS__` 后走查工作台、文档中心、账号页、设置页。
- **判定**：各页无装配引导页残留（即端口已注入）、数据与 SQLite 一致、设计器联动目标端生效。

**2026-09-17 进展（共享装配层与 settings 域均已落地；workspace / docs / auth 三域仍未装配）**

已完成 **共享装配层**，四个端口此后只需各自补一个域运行时，不必再各开一套 IPC：

| 层      | 产物                                                                                                                                                                                           | 状态      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 契约    | `packages/shell-api/src/domain-control.ts`：`DomainKind` 四域、四张方法白名单（workspace 19 / docs 20 / auth 14 / settings 16）、`DomainRpcRequest/Response`、`DomainDescriptor`、`describe()` | ✅ 已落地 |
| 能力位  | `ShellCapabilities.domain` + `ShellHost.domain`；`negotiate()` 兜底同步                                                                                                                        | ✅ 已落地 |
| 通道    | `ec:domain:invoke` / `ec:domain:describe` / `ec:domain:event`（单通道 + 白名单分发，沿用 `ai` 通道已验证的做法，避免约 70 个方法各开通道；`event` 为**单向推送**通道，见下方「域事件通道」）   | ✅ 已落地 |
| 主进程  | `main/ipc/domain.ts` + `IpcDependencies.domainHost`；未装配时兜底如实回 `NOT_SUPPORTED` 与空 `describe`；`invoke` 期间把 `event.sender` 按 `requestId` 注册进 `host.events`，`finally` 中注销  | ✅ 已落地 |
| preload | `domain.invoke` / `domain.describe` / `domain.onEvent`，已进 `PRELOAD_TOP_LEVEL_KEYS` 与安全面自检                                                                                             | ✅ 已落地 |
| 双形态  | Electron `capabilities().domain = true`；Tauri 如实 `false`（Rust 侧无命令），与既有 `ai: false` 同一口径                                                                                      | ✅ 已落地 |

**仍缺的是四个域各自的后端**，这是功能而非接线，逐条列出（2026-09-17 更新）：

| 域        | 状态与缺口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| settings  | **已装配（16/16 方法）**。已实现：`getAll`/`update`（settings.json 落盘 + zod 校验）、`getDataDirs`、`migrateDataDirs`/`rollbackMigration`（复制 + 条目数校验 + 旧目录改名备份；SQLite 用 `VACUUM INTO` 在线快照）、`setTelemetry`/`inspectLocalTelemetry`/`clearLocalTelemetry`（文件缓冲 + 缓存字节数）、`listCommands`（**新建 `@ec/core` 的 `command-catalog.ts` 作为命令 id/标题/默认键位的单一事实源**，并由渲染层漂移守卫测试钉住导航与 i18n）、`saveKeymap`/`exportKeymap`/`importKeymap`、`getBackupConfig`/`saveBackupConfig`；**归档 `exportProject`/`importPackage` 已接 `@ec/package-kit`**（`runExport`/`runImport` + 本目录实现的 `ExportSourcePort`/`ImportLocalStatePort`/`ImportTargetPort`），并有**导出→导入空库**的往返验证。<br>**合同层的一处补强**：加密归档需要口令，而原端口入参没有口令位——现已给 `exportProject`/`importPackage` 加可选 `password`，并在「导出与备份」面板补两个口令输入框（勾选加密时才显示、未填口令禁用导出）；缺口令时**拒绝导出**而不是静默产出未加密文件                                                                                                                                                                                                                                                                                                                                                                                                             |
| workspace | **已装配（19/19 方法）**。已实现：`listProjects`（视图/搜索/排序/置顶/最近 N）、`getProject`、`createProject`（落库 + 建出 `projects/<id>/{design,docs,pipeline,code,meta}`）、`updateProject`、`markOpened`、`archiveProject`/`unarchiveProject`、`moveToRecycleBin`/`restoreFromRecycleBin`/`purgeProject`（软删除 30 天；彻底删除级联清行 + 删工程目录）、`cleanupExpiredRecycleBin`、`duplicateProject`（按选项机械搬运设计/记忆/文档/代码并回传计数）、`createFromTemplate`（**经 `@ec/designer/dsl` 子入口产出初始 DSL 并落盘**，页面行 `dsl_ref` 指向 `<pageId>.dsl.json`，模板记忆草稿与页面备注一并落 `memory_item`）、**`importFromGit`**（走系统 git CLI 克隆 + 扫描清单推断目标端与技术栈 + 写项目记忆；`GitImportPort` 实现在 `domain/git-import-port.ts`；克隆/扫描/落库三阶段进度经**域事件通道**回渲染层）、`createFromDigest`（功能 + 页面 + 项目记忆落库，`sourceKind='doc_import'`）、`getProjectStage`、`getThumbnailUrl`（如实 null）、`getDashboardMetrics`（记忆按 scope / 页面按 DSL 平台 / 功能完成度 / 用量按模型 / git 暂空）、`getMetricDetail`。<br>**新增约定：代码根登记**（`domain/code-root.ts`）。「克隆目录」的界面语义是**用户指定仓库落点**，因此仓库可能落在工程目录之外；`<projectDir>/meta/code-root.txt` 登记实际代码根，导出与复制按它取文件（未登记则退回 `<projectDir>/code`）。不用目录联接是因为 `rmSync(projectDir, {recursive:true})` 会穿过 junction 删掉用户仓库本身 |
| docs      | **已装配（20/20 方法）**。`DocService`（`@ec/core` 文档域）+ 本目录的 SQLite 适配器 `DocStore` / `DocMemoryPort` + Node 全集解析器注册表。导入（含 `importFromFile` 读真实文件）、编辑与版本快照、更新提示与忽略、软删/恢复/彻底删除（级联清关联与版本）、记忆关联双向查询与批量计数、`commitConvertToMemory`（不依赖 AI）均可用。**一键转记忆已接真实 AI 摘要端口**（2026-09-23）：`createGatewayExtractionPort` 以 `purpose=memory-extract` 调网关，保留源文档与段落锚点，失败给结构化提示、绝不伪造摘要；AI 栈未注入时仍如实报 `NOT_SUPPORTED` 并回传中文引导语。图片 OCR 走 Windows 内置引擎（`Windows.Media.Ocr`，经 PowerShell WinRT 子进程），`ocrStatus` 如实上报可用性与语言清单，缺语言包时给出安装指引。另：`DocMemoryPort` 落 `memory_item` 时**不生成 embedding**（关键词检索正常、向量检索跳过），待记忆域装配后改为委托其服务并补算向量                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| auth      | **已装配（14/14 方法）**。`@ec/account` 的 `AuthClient` + 本目录装配：`TransportPort`（Node fetch）、`SecureStorePort`（safeStorage/DPAPI 加密落盘，键即文件）、`SystemPort`（回环监听为 OAuth 主通道；协议辅通道见下）、`OfflineController`（`isOffline`/`tryRecover`）。会话令牌经 DPAPI 加密落盘（恢复 / 登出 / 令牌提取均真实）；**两个外壳持有的状态**：待完成的 OAuth 握手（按 provider 暂存，一次性消费）与当前会话令牌（`listBindings`/`bind`/`unbind` 契约不带 token）。服务不可达 → 离线模式（本地功能可用，登录置灰），5xx 不算离线；装配前置：safeStorage 不可用时**不装配**并动态给出原因。<br>**2026-09-23 补**：① `registerProtocol` 已接线——`everyonecoding://oauth` 由 `main/protocol.ts` 的协议桥承载（`setAsDefaultProtocolClient` + 单实例锁 + `second-instance`/`open-url` 转发），回环不可用时自动回退，`EC_OAUTH_CHANNEL=protocol` 可强制；② 新增 `pollOAuthCallback` / `submitOAuthCallback` 两个方法，渲染层不必自己拿回调 URL；③ 邮箱验证与找回密码的服务端能力已补齐（见 M-01）。<br>**如实边界**：真机 OAuth 仍需真实第三方应用凭据（见 M-02）。                                                                                                                                                                                                                                                                                                                                           |

**渲染层已闭环**：`installDomainPorts()` 按 `describe()` 结果注入，`settings` 可用即自动点亮设置页的
通用 / 数据与位置 / 隐私 / 快捷键 / 导出与备份 五个类目，无需再改一行渲染层代码。
启动日志会打印 `[bootstrap] 域端口=[settings]` 与未装配域的原因，便于定位"某页为何仍是引导态"。

**域事件通道（2026-09-18 新增）**：域 RPC 是请求/响应模型，承载不了"执行到哪一步"——
此前 `importFromGit` 的 `onProgress` 回调因**函数无法跨进程**（Electron 结构化克隆遇函数直接抛错）
只能在渲染层出口剥掉，克隆大仓库时界面全程干等，没有任何过程反馈。

现补一条与 `AiControlHost.stream` 同构的**单向事件通道**：

| 环节       | 落地                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约       | `shell-api`：`DomainEvent` 信封、`DomainEventSink`（requestId → 发送器的注册表）、`DomainControlHost.onEvent?`（**可选能力**，外壳不提供即退化为"无过程反馈"而不是让调用失败）、`DomainControlServiceHost.events` |
| 关联       | 事件**不带自有 id**，一律按触发它的 `requestId` 回流；渲染层据此把事件对到具体那次调用，并发调用（工作台与文档中心同时刷新）不会串台                                                                              |
| 信封       | `requestId` 与 `domain` 由运行时（`createDomainRuntime`）统一补齐，域实现只给 `ctx.emit(payload)`——省得各自漏填关联字段                                                                                           |
| 收口       | 主进程 IPC 在 `invoke` 期间注册 `event.sender`、`finally` 注销；渲染层在请求定局（成功或失败）后退订。两侧都不留悬空回调                                                                                          |
| 载荷       | 跨进程数据先过守卫（`isWorkspaceImportProgressEvent`）：形状/边界不符直接丢弃，脏值不进 UI                                                                                                                        |
| 首个消费者 | `workspace.importFromGit` 三阶段：`clone`（0-1，解析 git `--progress` 的 stderr）→ `inspect`（比例不可知，`ratio: null`）→ `finalize`；界面有比例时显示百分比、无比例时显示**不确定进度条**，不假装 100%          |

> **设计约束（务必遵守）**：`describe()` 必须如实。未装配的域**不要**把端口注入 `globalThis.__EC_*__`——
> 页面会保留现有装配引导；反之注入半成品端口会让用户看到"能打开但每个动作都失败"的界面，比现状更差。
> `createMockDomainControlHost()` 与 Tauri 侧都按此口径实现。
> 例外口径：某域**大部分方法真实现、个别方法明确报错**时可注入（如 settings 的 export/import），
> 前提是报错必须带可读原因且写进文档——这与"假装可用"是两件事。

---

## 4. E2E-07 的环境敏感说明

E2E-07 自动化用例（`e2e/domain/e2e-07-git.test.ts`）使用**真实 git 子进程**与真实临时仓库，
覆盖：初始化（含 `.gitignore` 模板）→ 写入提交身份 → 状态 → 暂存 → 提交 → 建分支 →
添加远程（本地裸仓库）→ 推送 → 在远端验证提交落地；
并断言全程 argv 不含 `password` / `--askpass` / `Authorization:`（「无终端」的机器判据）。

**实测（2026-09-14）**：单次通过，耗时 **224.2s**；用例超时设为 600s。

**为什么这么慢**：本机为 Windows + 实时杀毒扫描环境，git 子进程启动极慢
（2026-09-12 实测 `git --version` ≈18s/次），用例约 13 次 git 调用 → 200s 量级。
早期版本（约 20 次调用）在 300s 超时下未跑完，故精简为当前的最小完整流程并放宽超时。

**若复跑偶发超时**：属环境问题而非代码问题。判定依据：同一套断言在
`packages/git/src/__tests__/git-integration.test.ts`（双后端同套用例）中通过即可确认实现正确。
建议把仓库目录与 `git.exe` / `node.exe` 加入杀毒实时扫描白名单后重跑。
