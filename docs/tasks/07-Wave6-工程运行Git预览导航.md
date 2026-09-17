# Wave 6 — 工程运行：Git / 预览 / 导航（T6-01 ~ T6-07）

> 目标：全可视化 Git（无命令行）、Mock 与真实后端联动预览、Ctrl+点击双向跳转。
> 约束：用户不手动改代码，仓库变更全部来自 AI 生成节点、重命名事务与迁移执行（D-04）。

---

## T6-01 Git 内核封装（git2 / CLI 回退）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-GIT-01；FR-SET-08（无命令行） |
| 优先级 | P0 |
| 前置任务 | T0-02、T0-11 |
| 可并行 | 无 |

**产出物**

- `packages/git/src/{git-client.ts,backend/{git2-backend.ts,cli-backend.ts,index.ts},models.ts,gitignore.ts}`
- 测试（用临时仓库做集成测试）

**实现要点**

1. 后端策略：优先 git2（libgit2，Node 侧用 nodegit 或 isomorphic-git 替代方案需评估；若 Electron 版用 nodegit，Tauri 版走 CLI 或 Rust git2 命令），回退系统 git CLI；**两者对上层透明**。
2. 能力：init / open / status / add / reset / commit / log / branch / checkout / merge / rebase / stash / remote / push / pull / fetch / diff / blame-lite。
3. 仓库初始化生成按技术栈模板的 `.gitignore`（复用 T0-11 模板）。
4. 凭据：HTTPS 用令牌、SSH 用 ed25519 密钥，凭据存密钥环（DPAPI），不落明文。
5. 所有操作返回结构化结果（含 stdout/stderr 结构化日志），供 UI 回显。

**验收标准**

- [ ] init / status / add / commit / log 在临时仓库中全部通过（集成测试）
- [ ] git2 不可用时自动回退 CLI 且行为一致（同一套测试跑两遍）
- [ ] 凭据不落明文（检索临时目录与日志无令牌）
- [ ] 每个操作返回结构化日志，可直接渲染到 UI

**▶ AI 执行提示词**

```
任务 T6-01：实现 Git 内核封装（packages/git）。
要求：
1) 定义 GitClient 接口：init/open/status/add/unstage/reset/commit/log/branch/createBranch/switchBranch/deleteBranch/merge/rebase/stash/listStash/popStash/remote/addRemote/push/pull/fetch/diff/show。
2) 双后端：git2-backend（优先，Node 侧选用成熟 libgit2 绑定；如依赖不可得则明确说明并给出 CLI 优先方案）与 cli-backend（系统 git，通过 Shell API process 调用，需处理中文路径与输出编码）；backend/index.ts 运行时探测可用性并选择，git2 失败自动回退 CLI，对上层完全透明。
3) 返回值统一：{ok, data, logs:[{level, message, raw}]}，日志结构化可直接渲染到 UI（FR-SET-08：用户永不接触命令行）。
4) 仓库初始化时按技术栈生成 .gitignore（复用 packages/core 的 gitignore-templates）。
5) 凭据：HTTPS 用 Personal Access Token、SSH 用 ed25519 密钥；凭据通过 packages/core 的 secure-store 存取（DPAPI），绝不明文落盘；push/pull 时自动注入。
6) 测试：用临时目录建真实仓库跑 init→add→commit→branch→merge→stash→log 全流程（git2 与 CLI 两套后端各跑一遍）；断言凭据不在任何文件与日志中出现。
验收：两套后端均通过同一套集成测试；给出一次完整操作日志样例。
```

---

## T6-02 变更视图与提交

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-GIT-02；FR-GIT-03；FR-GIT-09；E2E-07 |
| 优先级 | P0 |
| 前置任务 | T6-01、T0-06 |
| 可并行 | 无 |

**产出物**

- `apps/renderer/src/features/git/{ChangesPanel.tsx,FileDiff.tsx,CommitBox.tsx,HunkSelector.tsx}`
- `packages/git/src/{diff-service.ts,commit-message.ts}`
- 测试

**实现要点**

1. 变更视图：可视化文件树（新增/修改/删除/重命名状态色），支持按文件查看 diff（并排/内联切换），大文件（>1MB）自动跳过内容 diff 并提示。
2. 提交：勾选文件/代码块（hunk 级）→ 填写提交信息 → 提交；支持 AI 生成规范 commit message（Conventional Commits，可在设置切换规范）。
3. 自动生成节点提交：AI 每完成一个功能/页面生成可配置为自动提交（默认关闭，建议"每阶段提交"），格式 `<type>(<scope>): <subject>` + 自动生成 body。
4. 变更来源可追溯：每个变更展示其来源（AI 生成任务 id / 重命名事件 / 迁移执行），点击可跳转对应记录。

**验收标准**

- [ ] E2E-07：初始化 → 修改 → 提交 → 建分支 → 推送 全程无命令行
- [ ] diff 并排/内联切换可用，>1MB 文件跳过 diff 并提示
- [ ] hunk 级勾选提交生效
- [ ] AI 生成的 commit message 符合 Conventional Commits，规范可切换

**▶ AI 执行提示词**

```
任务 T6-02：实现 Git 变更视图与提交（apps/renderer/src/features/git + packages/git）。
要求：
1) diff-service.ts：解析 diff 为文件级与 hunk 级结构（含重命名识别），提供并排/内联两种渲染模型；>1MB 文件跳过内容 diff 并返回 skipped 标记与提示文案。
2) ChangesPanel.tsx：变更文件树（新增/修改/删除/重命名 四态颜色），支持勾选文件与 hunk（HunkSelector），全选/反选/按目录折叠；每个变更展示来源标签（AI 生成任务 id / 重命名事件 / 迁移执行 / 外部改动），点击跳转到对应记录。
3) FileDiff.tsx：并排/内联切换、语法高亮（按扩展名）、折叠未修改区域、行号对齐。
4) CommitBox.tsx：提交信息输入 + 「AI 生成提交信息」按钮（调用 packages/ai 的 commit-msg 用途，基于本次 diff 生成 Conventional Commits 格式 <type>(<scope>): <subject> + body），提交规范可在设置中切换（如 angular / custom）。
5) 自动生成节点提交（FR-GIT-09）：AI 完成一个功能/页面生成后，按配置自动提交（默认关闭，建议"每阶段提交"），提交信息含生成节点来源标记。
6) 测试：diff 解析（含重命名与二进制）、大文件跳过、hunk 勾选提交、AI 提交信息格式校验、自动提交开关。
验收：测试通过；E2E-07 全程无命令行走通。
```

---

## T6-03 分支 / 远程 / 历史

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-GIT-04；FR-GIT-05；FR-GIT-08；E2E-07 |
| 优先级 | P1 |
| 前置任务 | T6-01 |
| 可并行 | T6-05 |

**产出物**

- `apps/renderer/src/features/git/{BranchTree.tsx,BranchGraph.tsx,RemoteManager.tsx,HistoryTimeline.tsx,HistoryFilter.tsx}`
- `packages/git/src/{branch-service.ts,remote-service.ts,history-service.ts}`
- 测试

**实现要点**

1. 分支管理：创建/切换/重命名/删除分支；分支树可视化（正确展示分叉与合并关系）。
2. 远程管理：添加/编辑远程仓库；Push / Pull / Fetch；HTTPS（令牌）与 SSH（ed25519）凭据由密钥环保管。
3. 历史时间线：提交列表（虚拟化），支持查看详情（文件变更、作者、时间、commit body）、按文件/作者/关键词过滤；1000 条提交下滚动流畅。
4. 危险操作（删除分支、强制推送）二次确认。

**验收标准**

- [ ] 分支 CRUD 与分支图分叉/合并渲染正确
- [ ] Push/Pull/Fetch 可用，HTTPS 与 SSH 两种凭据路径均验证
- [ ] 1000 条提交滚动流畅（给出帧率数据），过滤按文件/作者/关键词生效
- [ ] 删除分支与强制推送有二次确认

**▶ AI 执行提示词**

```
任务 T6-03：实现 Git 分支、远程与历史（apps/renderer/src/features/git + packages/git）。
要求：
1) branch-service.ts：create/checkout/rename/delete/list，返回分支列表与上下游关系；BranchTree 树形展示，BranchGraph 用 SVG 绘制提交图（正确展示分叉与合并，含 HEAD 标记、分支标签、tag）。
2) remote-service.ts：add/edit/remove remote，push/pull/fetch（含进度回调用于 UI 进度条）；HTTPS 走 PAT、SSH 走 ed25519，凭据读写走 secure-store（DPAPI），提供连通性测试（fetch --dry-run 或 ls-remote）。
3) history-service.ts：分页游标拉取提交历史（虚拟化列表），支持按文件路径、作者、关键词（subject/body）、时间范围过滤；提交详情展示文件变更清单与 diff。
4) UI：HistoryTimeline（虚拟滚动，1000 条提交下流畅，输出帧率数据）、HistoryFilter、RemoteManager（含凭据配置与连通性测试结果展示）。
5) 危险操作（删除分支、强制推送、删除远程）必须二次确认并展示影响说明。
6) 测试：分支 CRUD 与图结构、push/pull/fetch 的 mock 远程（用本地 bare 仓库）、历史过滤、1000 条滚动性能、危险操作确认拦截。
验收：测试通过；用本地 bare 仓库完成一次完整 push/pull 验证。
```

---

## T6-04 冲突解决、回滚与 Stash

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-GIT-06；FR-GIT-07；FR-GIT-10；FR-GIT-11 |
| 优先级 | P1（冲突）/ P2（合并变基、Stash） |
| 前置任务 | T6-02、T6-03 |
| 可并行 | 无 |

**产出物**

- `apps/renderer/src/features/git/{MergePanel.tsx,ConflictEditor.tsx,RollbackDialog.tsx,StashPanel.tsx}`
- `packages/git/src/{merge-service.ts,conflict-service.ts,recovery-service.ts}`
- 测试（含冲突场景构造）

**实现要点**

1. 合并与变基：可视化选择源/目标分支，预览影响提交；操作前自动创建备份分支 `backup/<timestamp>`。
2. 冲突解决：三栏式（当前 / 结果 / 传入），支持逐块选择，解决后自动生成合并提交；**注意 D-04：用户不改代码，冲突解决本质是选择采用哪一侧 AI 生成结果**（提供"两侧都要 → 交给 AI 合并"入口）。
3. 回滚：对单个生成节点执行"回退到生成前"（soft reset / revert 可选），回滚前自动创建安全快照分支。
4. Stash：暂存/恢复/删除列表可视化。
5. 所有破坏性操作二次确认 + 可撤销。

**验收标准**

- [ ] 构造冲突场景后三栏编辑器可用，逐块选择后生成合并提交
- [ ] 合并/变基前自动创建 `backup/<timestamp>` 分支
- [ ] 生成节点回滚可 soft reset / revert，回滚前有安全快照分支
- [ ] Stash 三类操作可用
- [ ] 全部破坏性操作有二次确认

**▶ AI 执行提示词**

```
任务 T6-04：实现 Git 冲突解决、回滚与 Stash（apps/renderer/src/features/git + packages/git）。
要求（注意 D-04：用户不手动改代码，冲突解决是"选择采用哪一侧 AI 生成结果"）：
1) merge-service.ts：merge/rebase 前预览影响提交列表（将被引入的提交），操作前自动创建备份分支 backup/<timestamp>；失败时进入冲突状态并列出冲突文件。
2) conflict-service.ts + ConflictEditor：三栏式冲突编辑器（当前 / 结果 / 传入），逐块（hunk）选择采用哪一侧；提供「两侧都要 → 交给 AI 合并」入口（把两侧内容与上下文提交给 AI 生成合并结果，走 T4-05 写入管线，不允许用户手改）；解决后自动生成合并提交。
3) recovery-service.ts + RollbackDialog：对单个 AI 生成节点执行"回退到生成前"，支持 soft reset 与 revert 两种模式（说明差异），回滚前自动创建安全快照分支；列出将受影响的提交与文件。
4) StashPanel：stash 列表可视化，支持 apply/pop/drop/create，展示暂存的文件数与说明。
5) 所有破坏性操作（merge/rebase/reset/revert/drop）二次确认并说明影响；可撤销路径写集成测试。
6) 测试：脚本构造冲突仓库（同一文件两侧不同修改），验证三栏编辑、逐块选择、合并提交生成、备份分支创建、回滚两种模式、stash 三类操作、确认拦截。
验收：测试通过；输出一次冲突解决到合并提交的完整记录。
```

---

## T6-05 预览服务：静态预览 + Mock Server

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-PRV-01（静态/联动）；FR-PRV-02；FR-PRV-03；E2E-08 部分 |
| 优先级 | P0 |
| 前置任务 | T3-08、T5-04（OpenAPI 草案）、T0-02 |
| 可并行 | T6-03 |

**产出物**

- `packages/preview/src/{preview-server.ts,mock/{openapi-loader.ts,response-generator.ts,rules.ts,fault-injection.ts},static-server.ts,binding-resolver.ts}`
- `apps/renderer/src/features/preview/{PreviewToolbar.tsx,PreviewFrame.tsx}`
- 测试

**实现要点**

1. 三种预览模式一键切换：静态预览（数据取 Mock）、联动预览（连接真实后端逻辑）、真机/模拟器预览（T6-06）。
2. 接口来源优先级：真实运行中的后端 > 内置 Mock Server > 静态假数据（FR-PRV-02）。
3. Mock Server：依据技术文档中的 OpenAPI 草案自动生成响应，支持字段规则（随机/枚举/关联）、响应延迟与错误率模拟。
4. 数据绑定解析：页面元素的数据绑定（列表/表单/详情）在预览时自动调用后端接口（binding-resolver 与 T3-08 StateStore、T3-09 flow-runtime 打通）。
5. 预览服务在客户端内启动（通过 Shell API 起本地端口），端口冲突自动顺延并提示。

**验收标准**

- [ ] 静态预览渲染页面且数据来自 Mock
- [ ] 联动预览时表单提交打到真实后端并返回正确结果（E2E-08，与 T6-06 联调）
- [ ] Mock Server 能按 OpenAPI 草案生成响应，字段规则与延迟/错误率可配
- [ ] 端口冲突自动顺延并提示

**▶ AI 执行提示词**

```
任务 T6-05：实现预览服务与 Mock Server（packages/preview）。
要求：
1) static-server.ts：本地静态资源服务（通过 Shell API 起 HTTP 服务，端口从 4173 起自动顺延并提示用户），托管预览构建产物。
2) openapi-loader.ts：解析技术文档产出的 OpenAPI 3.0 草案（YAML/JSON），构建路由表 {method, path, requestSchema, responseSchema}。
3) response-generator.ts + rules.ts：按 responseSchema 生成 Mock 响应，支持字段规则（随机字符串/数字范围/枚举/日期/关联字段引用/数组长度）、响应延迟（固定或区间）、错误率（按概率返回指定错误码）。
4) binding-resolver.ts：解析页面元素的数据绑定与动作流（对接 T3-08 StateStore 与 T3-09 flow-runtime），请求按优先级路由：真实运行中的后端（T6-06 提供）> Mock Server > 静态假数据（FR-PRV-02），并在 UI 标注当前数据来源。
5) PreviewToolbar：三种模式一键切换（静态 / 联动 / 真机·模拟器·本地运行，具体通道在 T6-06 接入），显示当前服务地址与数据来源标记；按项目所选目标端展示可用预览通道。
6) PreviewFrame：iframe 嵌入预览页，与宿主通过 postMessage 通信（上报请求日志、元素点击事件，供高亮联动）。
7) 测试：OpenAPI 解析、字段规则生成（含关联与数组）、延迟与错误率、来源优先级路由、端口顺延、绑定解析与动作流执行。
验收：测试通过；手工验证一个列表页在静态模式下显示 Mock 数据、表单提交走通动作流。
```

---

## T6-06 真实后端托管、热更新与接口调试面板

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-PRV-04；FR-PRV-05；FR-PRV-06；FR-PRV-08；E2E-08 |
| 优先级 | P1 |
| 前置任务 | T6-05、T0-02 |
| 可并行 | 无 |

**产出物**

- `packages/preview/src/backend/{project-detector.ts,dependency-installer.ts,runner.ts,log-stream.ts,port-manager.ts}`
- `apps/renderer/src/features/preview/{BackendPanel.tsx,ApiDebugger.tsx,DevicePreview.tsx}`
- 测试

**实现要点**

1. 自动识别项目类型（Node / Python / Java / Go），探测依赖、执行安装与启动、托管进程与日志；启动日志在客户端内实时展示；端口冲突自动顺延并提示。
2. 热更新：代码或设计变更后预览自动刷新（HMR 或整页刷新），刷新时间 ≤3s。
3. 接口调试面板：查看每个请求的方法、路径、入参、响应、耗时、状态码；支持重放请求与复制为 cURL。
4. 多端预览（FR-PRV-08）：移动端通过二维码 + 局域网地址在真机查看，或调用本机 Android/iOS 模拟器；HarmonyOS 通过 DevEco 模拟器或真机（探测 hdc，缺失时给出安装引导）；桌面端（Windows/Linux/macOS）以本地运行窗口预览（触发对应构建/运行命令并以窗口呈现）；需提示局域网访问的安全风险与开关（D-09：不生成云端链接）；未选择的目标端隐藏对应入口。
5. 依赖安装与构建全过程 UI 触发 + 结构化日志回显（FR-SET-08）。

**验收标准**

- [ ] Node/Python 两类项目可被自动识别、安装依赖、启动并托管（Java/Go 提供探测与手动命令映射）
- [ ] E2E-08：启动联动预览 → 提交表单 → 请求打到真实后端并返回正确结果
- [ ] 变更后预览刷新 ≤3s
- [ ] 接口调试面板可重放请求与复制 cURL
- [ ] 局域网预览有安全风险提示与开关，且不生成任何云端链接
- [ ] 鸿蒙 hdc 缺失与桌面工具链缺失时输出安装引导而非报错；未选择的端无对应预览入口

**▶ AI 执行提示词**

```
任务 T6-06：实现真实后端托管、热更新与接口调试面板（packages/preview/src/backend + 渲染层）。
要求：
1) project-detector.ts：识别项目类型（Node / Python / Java / Go），探测包管理文件与启动脚本，输出 {type, installCmd, startCmd, portHint, envHints}；Java/Go 若无标准探测结果则提供可编辑的命令映射。
2) dependency-installer.ts + runner.ts：通过 Shell API process 执行安装与启动（UI 触发，绝不要求用户开命令行），实时流式输出日志（log-stream.ts 支持分级着色与关键字过滤），进程可停止/重启；port-manager 检测端口冲突自动顺延并提示。
3) 热更新：监听产物与源码变更（fs.watch），触发 HMR（支持时）或整页刷新，目标 ≤3s，实测记录刷新耗时。
4) ApiDebugger.tsx：展示预览期间每个请求的方法、路径、入参、响应、耗时、状态码；支持重放请求（可改参数）与复制为 cURL；失败请求高亮并给出常见原因提示。
5) DevicePreview.tsx（FR-PRV-08）：生成本地局域网地址与二维码供真机查看，可调用本机 Android/iOS 模拟器（探测 adb / simctl，不存在时引导）；HarmonyOS 探测 hdc 调用 DevEco 模拟器或真机（缺失时输出安装引导）；桌面端按所选方案（Tauri/Electron）以本地运行窗口预览；**必须提示局域网访问的安全风险并提供开关**（D-09：不生成任何云端链接）；未选择的目标端隐藏对应入口。
6) 测试：项目识别（4 类）、安装与启动的日志流、端口顺延、热更新耗时、请求日志与重放、cURL 生成、局域网开关默认关闭。
验收：测试通过；E2E-08 手工走通（联动预览 + 表单提交打到真实后端）。
```

---

## T6-07 导航与跳转（M11）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-NAV-01/02/03/05；FR-PRV-07；E2E-06 |
| 优先级 | P0（Ctrl 跳转）/ P1、P2（图谱与数据流） |
| 前置任务 | T4-06、T6-05 |
| 可并行 | 无 |

**产出物**

- `packages/ai/src/nav/{jump-service.ts,target-resolver.ts,reverse-jump.ts,relation-graph.ts}`
- `apps/renderer/src/features/nav/{JumpOverlay.tsx,RelationGraphView.tsx,DataFlowOverlay.tsx}`
- 测试

**实现要点**

1. Ctrl + 点击页面名称或元素名称 → 跳转至关联后端代码位置；跳转目标按层级在下拉中选择（Controller 方法 → Service → 数据访问层）。
2. 悬停显示可跳转目标列表（后端接口、数据库表、测试用例、技术文档章节），按相关度排序。
3. 反向跳转：代码视图中 Ctrl + 点击锚点标记 → 跳回设计器对应元素并高亮；双向跳转成功率 ≥95%。
4. 关系图谱：图视图展示 页面—元素—接口—后端模块—数据表 的全局关系，支持缩放、筛选、按路径高亮。
5. 数据流可视化（FR-PRV-07）：预览时高亮"元素 → 事件 → 接口 → 后端处理 → 数据回写 → 元素渲染"链路（浮层动画）。

**验收标准**

- [ ] E2E-06：Ctrl + 点击登录按钮准确定位到对应 Controller 方法
- [ ] 悬停目标列表按相关度排序，四类目标均可跳转
- [ ] 反向跳转回到设计器并高亮元素，双向成功率 ≥95%（构造 20 组锚点统计）
- [ ] 关系图谱可缩放、筛选、路径高亮

**▶ AI 执行提示词**

```
任务 T6-07：实现导航与跳转（packages/ai/src/nav + 渲染层）。
要求：
1) jump-service.ts：Ctrl + 点击页面名/元素名 → 通过 Code Anchor（T4-06）解析跳转目标；同一元素多个锚点时给出层级下拉（Controller 方法 → Service → 数据访问层 → 测试），跳转后滚动定位并高亮行。
2) target-resolver.ts：悬停时展示可跳转目标列表（后端接口、数据库表、测试用例、技术文档章节），按相关度排序（锚点置信度 + 命名匹配 + 就近优先）。
3) reverse-jump.ts：代码视图中 Ctrl + 点击 anchor 注释标记（// @everyonecoding:anchor <elementId>）→ 跳回设计器对应元素并高亮选中；写 20 组锚点的双向跳转测试，成功率目标 ≥95%。
4) relation-graph.ts + RelationGraphView：构建 页面—元素—接口—后端模块—数据表 的全局关系图，SVG 渲染，支持缩放、按类型筛选、按路径高亮（选中节点后高亮其上下游路径）。
5) DataFlowOverlay.tsx（FR-PRV-07）：预览时高亮"元素 → 事件 → 接口 → 后端处理 → 数据回写 → 元素渲染"完整链路（浮层动画），数据来自预览请求日志与动作流执行记录。
6) 测试：Ctrl 跳转定位、多锚点下拉、悬停列表排序、20 组双向跳转成功率统计、图谱筛选与路径高亮。
验收：测试通过；E2E-06 手工走通；输出双向跳转成功率统计。
```

---

**Wave 6 出口检查**：E2E-07（Git 全流程无命令行）与 E2E-08（联动预览提交表单打到真实后端）通过；Ctrl+点击能跳到 Controller 并能反向跳回设计器。
