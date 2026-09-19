# Wave 9 — 工作台 / 设置 / 文档 / 账号（T9-01 ~ T9-06）

> 目标：补齐项目生命周期、全局设置、文档与记忆关联、四种登录方式。
> 依赖：Wave 0（内核、存储、UI 库）；账号服务端（T9-06）可与客户端并行开发。

---

## T9-01 工作台与项目管理（M2）

| 项       | 内容                  |
| -------- | --------------------- |
| 覆盖需求 | FR-WSP-01 ~ FR-WSP-05 |
| 优先级   | P0                    |
| 前置任务 | T0-05、T0-08、T0-06   |
| 可并行   | T9-04、T9-05          |

**产出物**

- `apps/renderer/src/features/workspace/{WorkspaceHome.tsx,ProjectCard.tsx,NewProjectDialog.tsx,ProjectSettings.tsx,RecycleBin.tsx}`
- `packages/core/src/project/{project-service.ts,project-templates.ts,git-import.ts,doc-import.ts}`
- 测试

**实现要点**

1. 工作台首页：项目卡片网格（缩略图、名称、更新时间、流水线当前阶段进度环），100 项目下首屏 ≤1s，支持网格/列表切换。
2. 新建项目四类来源：空白 / 模板（内置 Web 管理后台、移动端 App、官网落地页）/ 从 Git 仓库导入 / 从需求文档导入。
3. 项目设置：名称、目标端（Web/Android/iOS/HarmonyOS/Windows/Linux/macOS 七端多选）、各端技术方案（FR-AI-13 矩阵，与 T5-04 问卷联动）、技术栈指纹、关联 Git 远程；修改目标端后设计器画布尺寸与组件库联动切换。
4. 最近打开与收藏按时间倒序、支持置顶，退出后保留最近 10 条。
5. 归档 / 删除 / 复制：删除需二次确认并进入回收站（保留 30 天，可恢复）。

**验收标准**

- [ ] 100 项目首屏渲染 ≤1s（虚拟化 + 缩略图懒加载，附实测）
- [ ] 四类新建来源均可用（Git 导入与文档导入各一个集成测试）
- [ ] 修改目标端后画布尺寸与组件库联动
- [ ] 删除进回收站保留 30 天可恢复，二次确认生效

**▶ AI 执行提示词**

```
任务 T9-01：实现工作台与项目管理（apps/renderer/src/features/workspace + packages/core/src/project）。
要求：
1) WorkspaceHome：项目卡片网格（缩略图、名称、更新时间、流水线当前阶段进度环），100 项目下首屏渲染 ≤1s（虚拟化 + 缩略图懒加载 + 骨架屏），支持网格/列表切换、排序（更新时间/名称/创建时间）、搜索。
2) NewProjectDialog：四类来源——空白 / 模板（内置至少 Web 管理后台、移动端 App、官网落地页三套模板，模板含初始页面 DSL 与项目记忆）/ 从 Git 仓库导入（克隆 + 识别项目类型 + 生成项目记忆初稿）/ 从需求文档导入（解析 Markdown/Word/PDF 提取功能清单）。
3) ProjectSettings：名称、目标端（Web/Android/iOS/HarmonyOS/Windows/Linux/macOS 七端多选）、各端技术方案（按 FR-AI-13 矩阵出选项，与 T5-04 问卷共用数据源；无可用方案的端禁用并说明）、技术栈指纹（前端/后端/数据库/各端方案）、关联 Git 远程；修改目标端后发事件使设计器画布尺寸预设与组件库联动切换（与 T3-02 联动）。
4) 最近打开与收藏：按时间倒序、支持置顶，持久化最近 10 条（重启后保留）。
5) 归档/删除/复制：删除二次确认并进入回收站（保留 30 天，可恢复与彻底删除，彻底删除再次确认）；复制项目含设计、记忆、文档与代码（可勾选）。
6) 测试：100 项目渲染性能（输出实测）、四类新建、目标端联动事件、收藏与最近列表持久化、回收站保留与恢复。
验收：测试通过；给出 100 项目首屏渲染耗时数据。
```

---

## T9-02 项目仪表盘

| 项       | 内容         |
| -------- | ------------ |
| 覆盖需求 | FR-WSP-06    |
| 优先级   | P2           |
| 前置任务 | T9-01、T4-01 |
| 可并行   | T9-03        |

**产出物**

- `apps/renderer/src/features/workspace/{ProjectDashboard.tsx,MetricsCard.tsx,DrilldownPanel.tsx}`
- 测试

**实现要点**

1. 指标：记忆条目数、页面数、功能完成度、AI 调用量与成本、最近 Git 提交；所有指标可点击下钻。
2. 数据来源：memory_item 统计、DSL 页面统计、pipeline 节点状态、usage_record 汇总、git log。
3. 缓存与增量刷新（避免每次打开都全量聚合）。

**验收标准**

- [ ] 五项指标数值与源数据一致（断言测试）
- [ ] 每个指标可下钻到明细列表
- [ ] 打开仪表盘 ≤1s（中等规模项目，附实测）

**▶ AI 执行提示词**

```
任务 T9-02：实现项目仪表盘（apps/renderer/src/features/workspace/ProjectDashboard）。
要求：
1) 五项指标：记忆条目数（按五层分组）、页面数（按端分组）、功能完成度（已完成/总节点）、AI 调用量与成本（本期与累计，按 Provider/模型分组）、最近 Git 提交（最近 5 条）。
2) 每个指标可点击下钻：打开明细面板（如点"记忆条目数"→ 列出各层条目数并可跳转到记忆中心对应筛选）。
3) 数据来源：memory_item 聚合查询、页面 DSL 文件统计、pipeline 节点状态、usage_record 汇总、git log（复用 packages/git）。
4) 性能：中等规模项目（50 页面 / 500 记忆 / 200 提交）打开 ≤1s；用缓存 + 增量刷新（数据变更事件触发局部重算），避免每次全量聚合。
5) 测试：五项指标数值与源数据一致性断言、下钻跳转、性能实测。
验收：测试通过；给出中等规模项目打开耗时。
```

---

## T9-03 设置与本地数据（M13）

| 项       | 内容                                        |
| -------- | ------------------------------------------- |
| 覆盖需求 | FR-SET-01/02/03/04/06/07；FR-SET-08（兜底） |
| 优先级   | P1                                          |
| 前置任务 | T0-10、T0-11、T8-02                         |
| 可并行   | T9-02                                       |

**产出物**

- `apps/renderer/src/features/settings/{SettingsHome.tsx,GeneralSettings.tsx,DataLocation.tsx,BackupPanel.tsx,PrivacyPanel.tsx,ShortcutSettings.tsx}`
- 测试

**实现要点**

1. 全局设置：语言（简中/英文）、主题（浅色/深色/跟随系统）、字体、编辑器偏好；即时生效无需重启。
2. **本地存储 + 手动迁移（D-02）**：状态栏不显示任何同步状态；导出/导入入口在设置页一级可见（调用 T8-02/T8-03）。
3. 数据目录自定义：工作区根目录、工程目录、SQLite 位置、缓存目录；修改后自动迁移并校验。
4. 数据导出：一键导出项目（代码 + 设计 DSL + 记忆 + 文档）为归档包（轻量"仅代码"导出，与 `.ecpkg` 共用排除与脱敏策略）。
5. 遥测与隐私：匿名使用数据默认关闭需显式授权；AI 请求内容默认不上传；隐私面板一键清除。
6. 快捷键自定义：全部可视化操作可配置快捷键，支持导入/导出键位方案。

**验收标准**

- [ ] 设置修改即时生效，无需重启
- [ ] 设置页与状态栏无任何云端同步入口（D-02 断言）
- [ ] 数据目录修改后自动迁移成功且数据完整（迁移前后条数一致）
- [ ] 隐私面板一键清除后本地无残留遥测数据
- [ ] 快捷键方案可导入导出

**▶ AI 执行提示词**

```
任务 T9-03：实现设置与本地数据（apps/renderer/src/features/settings）。
要求：
1) GeneralSettings：语言（简体中文/English）、主题（浅色/深色/跟随系统）、字体与字号、编辑器偏好；全部即时生效，无需重启。
2) 严格遵循 D-02：状态栏与设置页**不出现任何云端同步状态或入口**；导出/导入（.ecpkg）入口在设置页一级可见，调用 T8-02/T8-03；写断言测试确认无同步相关 UI 文案。
3) DataLocation：工作区根目录、工程目录、SQLite 位置、缓存目录可自定义；修改后自动迁移（复制 + 校验 + 切换 + 旧目录保留备份），迁移失败可回滚；迁移前后数据条数一致（测试断言）。
4) BackupPanel：一键导出项目（代码 + 设计 DSL + 记忆 + 文档），轻量"仅代码"导出与完整 .ecpkg 共用同一套排除规则与脱敏策略（FR-SET-04）。
5) PrivacyPanel：匿名使用数据默认关闭需显式授权；AI 请求内容默认不上传服务端统计；一键清除本地遥测与缓存数据（清除后断言无残留）。
6) ShortcutSettings：全部可视化操作可配置快捷键（列出 T0-09 注册的命令），冲突检测提示，支持导入/导出键位方案 JSON。
7) 测试：设置即时生效、无同步入口断言、目录迁移与回滚、隐私清除、快捷键冲突检测与方案导入导出。
验收：测试通过；确认设置页与状态栏无云端同步入口。
```

---

## T9-04 文档管理与记忆关联（M5）

| 项       | 内容                       |
| -------- | -------------------------- |
| 覆盖需求 | FR-DOC-01 ~ FR-DOC-06      |
| 优先级   | P0（关联）/ P1、P2（其余） |
| 前置任务 | T2-01                      |
| 可并行   | T9-01、T9-05               |

**产出物**

- `packages/core/src/docs/{doc-service.ts,parsers/{markdown,docx,pdf,txt,image-ocr}.ts,versioning.ts}`
- `apps/renderer/src/features/docs/{DocLibrary.tsx,DocViewer.tsx,DocMemoryLink.tsx,ConvertToMemoryDialog.tsx}`
- 测试

**实现要点**

1. 文档管理：创建/导入 Markdown、Word、PDF、TXT，图片走 OCR；导入 PDF/Word 后正确提取文本与标题层级。
2. **文档关联至记忆**：任一文档可关联到 长期/项目/功能/页面/问题 任一记忆节点；记忆卡片显示"📎 N 篇关联文档"并可展开。
3. 双向跳转：从记忆打开关联文档并定位到段落（Markdown 用标题 id、PDF 用页码）；从文档反查被哪些记忆引用。
4. 一键转记忆：选中文档或片段 → 转为项目/长期记忆，自动生成结构化摘要，结果可编辑并保留原文链接。
5. 流水线产物自动入档（与 T5-03/T5-04 打通），命名 `<项目>-需求文档-v<阶段版本>.md`。

**验收标准**

- [ ] Markdown / Word / PDF / TXT 四类导入解析正确（标题层级保留）
- [ ] 文档可关联到五类记忆节点，记忆卡片显示关联数并可展开
- [ ] 双向跳转定位准确（Markdown 标题锚点、PDF 页码）
- [ ] 转记忆生成的结构化摘要可编辑且保留原文链接

**▶ AI 执行提示词**

```
任务 T9-04：实现文档管理与记忆关联（packages/core/src/docs + 渲染层）。
要求：
1) doc-service.ts + parsers/：支持 Markdown、DOCX、PDF、TXT 导入与文本提取（PDF/DOCX 用成熟解析库，注意许可证兼容性；图片走 OCR，不可用时给出"暂不支持"提示而非静默失败）；需保留标题层级结构（输出 {docId, title, sections:[{level, heading, anchor, text}]}）。
2) 文档关联记忆（FR-DOC-02）：任一文档可关联到 长期/项目/功能/页面/问题 任一记忆节点，关系落 memory_doc_link 表；记忆卡片显示"📎 N 篇关联文档"并可展开跳转。
3) 双向跳转（FR-DOC-03）：从记忆打开关联文档并定位到段落（Markdown 用标题 id 锚点，PDF 用页码 + 高亮）；从文档面板反查"被哪些记忆引用"并列出。
4) 一键转记忆（FR-DOC-04）：选中整个文档或某段落 → 转为项目记忆/长期记忆，调用 AI 生成结构化摘要（走 memory-extract 用途），结果可编辑，并保留原文链接（docId + 段落锚点）。
5) 文档版本（FR-DOC-05）：修改后保留历史版本，关联记忆显示"文档已更新"提示，可忽略（忽略后不再提醒该版本）。
6) 流水线产物自动入档（FR-DOC-06）：与 T5-03/T5-04 打通，产物按 <项目>-需求文档-v<阶段版本>.md 命名并入档 + 自动关联对应记忆。
7) 测试：四类格式解析与层级保留、关联与反查、段落定位、转记忆保留原文链接、版本提示与忽略、产物入档命名。
验收：测试通过；手工导入一份 PDF 并关联到项目记忆后能跳转定位。
```

---

## T9-05 账号与登录客户端（M1）

| 项       | 内容                                  |
| -------- | ------------------------------------- |
| 覆盖需求 | FR-ACC-01 ~ FR-ACC-08；E2E-01；E2E-02 |
| 优先级   | P0                                    |
| 前置任务 | T0-10、T9-06                          |
| 可并行   | T9-06                                 |

**产出物**

- `packages/account/src/{auth-client.ts,oauth/{google,github,wechat}.ts,session.ts,binding.ts}`
- `apps/renderer/src/features/auth/{LoginPage.tsx,RegisterForm.tsx,WechatQR.tsx,BindingPanel.tsx,OfflineBanner.tsx}`
- 测试

**实现要点**

1. 四种登录：邮箱注册/登录（密码 ≥8 位含两类字符、二次确认、弱密码实时提示）、微信扫码（PC 二维码 + 轮询授权态，5 分钟过期自动刷新）、Google OAuth 2.0、GitHub OAuth。
2. OAuth 回调用**本地回环监听**（`127.0.0.1:<随机端口>`）为主、`everyonecoding://oauth` 自定义协议为辅的双通道 + PKCE。
3. 会话安全：Access Token 短时效 + Refresh Token 自动续期；Token 存 DPAPI 加密区；退出清除本地缓存；"记住我" ≤30 天。
4. 绑定与解绑：一个主账号可绑定多个第三方身份；解绑时若仅剩单一登录方式且未设密码，必须先设置密码。
5. **离线本地模式**：云端不可达时已有本地项目与记忆可继续使用，登录入口置灰并提示（FR-ACC-05 保障）。

**验收标准**

- [ ] E2E-01：邮箱注册 → 验证 → 进入工作台 ≤2 分钟，无管理员介入
- [ ] E2E-02：GitHub 授权登录成功自动建号并进入工作台
- [ ] Token 落 DPAPI，明文不可检索；退出登录后本地缓存清除
- [ ] 云端不可达时进入离线模式，本地项目可用，登录入口置灰

**▶ AI 执行提示词**

```
任务 T9-05：实现账号与登录客户端（packages/account + 渲染层）。
要求：
1) 四种登录：① 邮箱注册/登录（密码 ≥8 位且含两类字符、二次确认、弱密码实时提示、注册成功即进入工作台）② 微信扫码（PC 端二维码 + 轮询授权态，5 分钟过期自动刷新，首次扫码自动建号）③ Google OAuth 2.0 ④ GitHub OAuth（申请 read:user、user:email scope，授权后展示已绑定信息）。
2) OAuth 回调：本地回环监听（127.0.0.1:<随机端口>）为主、自定义协议 everyonecoding://oauth 为辅的双通道；使用 PKCE；通过 Shell API 打开系统默认浏览器与注册协议。
3) 会话安全（FR-ACC-07）：Access Token 短时效 + Refresh Token 自动续期（并发刷新去重）；Token 存 DPAPI 加密区（secure-store），明文永不落日志；退出登录清除本地缓存；支持"记住我"≤30 天。
4) 绑定与解绑（FR-ACC-06）：设置页查看/绑定/解绑第三方身份；解绑时若仅剩单一登录方式且未设置密码，必须先设置密码才能解绑。
5) 离线本地模式：云端账号服务不可达时进入离线模式——本地项目与记忆可继续使用，登录相关入口置灰并提示"当前离线，本地功能可用"；恢复后自动尝试重新鉴权。
6) 邮箱验证与找回密码（FR-ACC-08）：注册后发送验证邮件（可配置为不强制验证即可使用）、支持验证码重置密码。
7) 测试：四种登录流程（用 mock 服务端）、PKCE 流程、Token 刷新并发、DPAPI 存储无明文、离线模式降级、解绑前置校验。
验收：测试通过；E2E-01 与 E2E-02 手工走通。
```

---

## T9-06 云端账号服务端最小实现

| 项       | 内容                                                 |
| -------- | ---------------------------------------------------- |
| 覆盖需求 | §8 服务端接口；FR-ACC-05；D-02/D-06/D-09（接口边界） |
| 优先级   | P0                                                   |
| 前置任务 | 无（可早期启动）                                     |
| 可并行   | Wave 0 ~ Wave 9 任意任务                             |

**产出物**

- `services/account/`：`src/{server.ts,routes/{auth,usage,release}.ts,models/,oauth/{google,github,wechat}.ts,middleware/{error,idem-potency,rate-limit}.ts}`
- `services/account/migrations/*.sql`
- OpenAPI 文档与集成测试

**实现要点**

1. 接口严格按 §8：`/api/auth/register`、`/api/auth/login`、`/api/auth/oauth/{provider}/authorize`、`/api/auth/oauth/{provider}/callback`、`/api/auth/refresh`、`/api/auth/bindings`、`/api/usage/report`、`/api/release/check`。
2. **不得实现**已移除的接口：`/api/config/remote`（D-06）、`/api/sync/*`（D-02）、`/api/share`（D-09）。
3. 约定：RESTful + JSON；统一错误结构 `{code, message, traceId}`；分页 cursor；写接口需幂等键。
4. 自注册即开通：自动分配默认工作区与免费权益包，无任何人工审核。
5. 技术栈自选（推荐 Node + Fastify/NestJS + PostgreSQL），但需提供 Dockerfile 与本地一键启动脚本。

**验收标准**

- [ ] 八个接口全部可用，OpenAPI 文档与实现一致
- [ ] 代码库与路由表中不存在已移除的三个接口（grep 断言）
- [ ] 统一错误结构与幂等键生效（重复提交同幂等键只生效一次）
- [ ] 自注册后可直接登录使用，无审核环节

**▶ AI 执行提示词**

```
任务 T9-06：实现云端账号服务端最小实现（services/account）。
背景：客户端可离线工作，服务端**仅负责账号注册/登录与版本更新**。
要求：
1) 八个接口严格按 docs/PRD-EveryoneCoding.md §8：POST /api/auth/register、POST /api/auth/login、GET /api/auth/oauth/{provider}/authorize、GET /api/auth/oauth/{provider}/callback（provider = wechat|google|github）、POST /api/auth/refresh、GET/POST/DELETE /api/auth/bindings、POST /api/usage/report（需授权）、GET /api/release/check（按 tauri/electron 双形态分别下发版本与增量包清单）。
2) **严禁实现**以下已移除接口（D-02/D-06/D-09）：/api/config/remote、/api/sync/memory、/api/sync/project-meta、/api/share；并在 README 中写明"本服务不提供云同步、远程配置下发与分享链接"。
3) 约定：RESTful + JSON；统一错误结构 {code, message, traceId}；分页用 cursor；所有写接口支持幂等键（Idempotency-Key 头，重复请求返回首次结果）。
4) 自注册即开通（FR-ACC-05）：注册后自动分配默认工作区与免费权益包，无任何人工审核环节。
5) 技术栈自选（推荐 Node + Fastify + PostgreSQL + Prisma），必须提供 Dockerfile、docker-compose 与本地一键启动脚本、OpenAPI 文档、集成测试（覆盖注册/登录/OAuth mock/刷新/绑定/幂等）。
6) 安全：密码哈希（argon2/bcrypt）、JWT 短时效 + Refresh Token、限流、审计日志脱敏。
验收：集成测试全通过；grep 确认无已移除接口；提供 OpenAPI 文档与启动说明。
```

---

**Wave 9 出口检查**：E2E-01（邮箱注册 ≤2 分钟）、E2E-02（GitHub 登录）通过；项目 CRUD 与模板可用；文档可关联记忆并双向跳转；设置页无云端同步入口。
