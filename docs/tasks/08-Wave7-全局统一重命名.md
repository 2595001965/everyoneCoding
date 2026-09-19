# Wave 7 — 全局统一模块：标识注册与重命名级联（T7-01 ~ T7-05）

> 目标：改一个元素名，前端代码、后端代码、文档、记忆、逻辑结构全部级联同步，且事务化、可回滚、不误伤。
> 对应 PRD M15（FR-UNI-01 ~ FR-UNI-14）。这是风险最高的模块（误改会静默破坏），**必须严格按 AST 作用域重构 + 三级风险分级 + 一键撤销**。

---

## T7-01 统一标识注册表与命名规则引擎

| 项       | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 覆盖需求 | FR-UNI-01；FR-UNI-02（D-10）；FR-UNI-11；§6.2 registry_entry |
| 优先级   | P0                                                           |
| 前置任务 | T3-01、T0-08                                                 |
| 可并行   | 无（T7-02 强依赖）                                           |

**产出物**

- `packages/registry/src/{registry-model.ts,registry-repo.ts,naming/{rule-engine.ts,presets.ts,pinyin.ts,identifier.ts},conflict-check.ts}`
- 测试

**实现要点**

1. 注册表项：稳定 ID（ULID，永不变更）、entityType（element/page/feature）、规范名（可变）、**八类标识符投影**（component / variable / cssClass / i18nKey / apiField / methodName / routeSegment / testName）、别名与废弃时间、命名规则 id、历史名数组、同步状态。
2. 命名规则引擎：为每类投影定义转换模板（PascalCase / camelCase / kebab-case / snake_case / i18n 前缀）、禁用字符、长度上限；**默认策略遵循 D-10：组件名与标识符用英文或拼音，显示文案保留中文**（中文→拼音可切换为保留原文或自定义映射表）；提供 Web / Android / iOS / HarmonyOS / Windows / Linux / macOS 七端预设（鸿蒙按 ArkTS 规范用 PascalCase 组件名，桌面端与 Web 同风格），支持项目级覆盖。
3. 冲突与非法检测：与已有标识符冲突、语言保留字、超长、非法字符 → 阻断并给出 3 个建议名；检测覆盖前端与后端符号表。
4. 同步状态：`synced / drift_detected / conflict`；AI 生成后自动校验投影一致性。

**验收标准**

- [ ] 八类投影从"用户登录按钮"正确派生（`UserLoginButton` / `userLoginButton` / `user-login-button` / `page.login.userLoginButton.label` / `user_login_button` / `handleUserLoginButton` / `/user-login-button` / `should render UserLoginButton`）
- [ ] 七端预设可切换，项目级覆盖生效
- [ ] 保留字、冲突、超长、非法字符四类检测均阻断且给出 3 个建议名
- [ ] 中文→拼音可切换为保留原文或使用自定义映射表

**▶ AI 执行提示词**

```
任务 T7-01：实现统一标识注册表与命名规则引擎（packages/registry）。
要求：
1) registry-model.ts：字段对齐 docs/PRD-EveryoneCoding.md §6.2 registry_entry（id/project_id/entity_type/entity_id/canonical_name/projections_json/aliases_json/naming_rule_id/name_history_json/sync_state）；projections 含八类：component、variable、cssClass、i18nKey、apiField、methodName、routeSegment、testName；entityId 为 ULID 且永不变更。
2) naming/rule-engine.ts：每类投影一套转换模板（PascalCase / camelCase / kebab-case / snake_case / i18n 前缀模板如 page.<page>.<name>.label / 路由片段），支持禁用字符、长度上限、保留字表（JS/TS、Java、Python、Dart、ArkTS 常用保留字）。
3) naming/pinyin.ts + presets.ts：默认策略遵循 D-10——组件名与标识符用英文或拼音，显示文案保留中文；中文→拼音转换可切换为"保留原文"或使用自定义映射表；提供 Web / Android / iOS / HarmonyOS / Windows / Linux / macOS 七端预设（差异如 i18n 前缀与路由风格；鸿蒙预设组件名 PascalCase、资源引用遵循 ArkTS 规范），支持项目级覆盖。
4) conflict-check.ts：检测与已有标识符冲突（前端符号表与后端符号表）、保留字、超长、非法字符；命中时阻断并返回 3 个建议名（加后缀/换近义词/缩写）。
5) 同步状态机 synced / drift_detected / conflict；AI 生成后提供 validateProjections() 校验投影与代码中实际符号是否一致，不一致置 drift_detected。
6) 测试：八类投影派生（以"用户登录按钮"为输入，断言与 PRD §15.1 表格一致）、七端预设差异、项目级覆盖、四类非法检测与建议名、拼音三种模式、drift 检测。
验收：测试通过；输出一份"用户登录按钮 → 登录提交"的投影前后对照表。
```

---

## T7-02 出现位置索引（Occurrence Index）

| 项       | 内容                                                                                 |
| -------- | ------------------------------------------------------------------------------------ |
| 覆盖需求 | FR-UNI-04（影响面数据基础）；FR-UNI-06（AST 级）；§6.2 occurrence；NFR-P-06（≤1.5s） |
| 优先级   | P0                                                                                   |
| 前置任务 | T7-01                                                                                |
| 可并行   | 无                                                                                   |

**产出物**

- `packages/registry/src/occurrence/{index-builder.ts,ast/{ts-parser.ts,python-parser.ts,java-parser.ts,index.ts},doc-scanner.ts,memory-scanner.ts,logic-scanner.ts,risk-classifier.ts}`
- 测试（含误改反例）

**实现要点**

1. 代码侧用 **AST 解析**（禁止纯文本替换）：TS/JS 用 ts-morph，Python 用 libcst，Java 用 JavaParser；作用域感知，**不误伤同名局部变量、注释中的同名文本、第三方库同名符号**。
2. 文档侧：扫描需求文档、技术文档与关联文档段落，命中标 `kind=doc`、locator 为段落锚点，语义匹配带置信度。
3. 记忆侧：扫描五层记忆的 structured 与 content 正文，命中带置信度。
4. 逻辑结构侧：扫描 DSL 树节点名与绑定路径。
5. 风险分级：auto（安全，自动改：组件名、变量名、CSS 类、i18n key、逻辑结构）/ confirm（需用户勾选：API 字段名、DTO 字段、Service 方法）/ warn（默认不改：数据库列名、已发布外部 API 路径、跨项目引用、反射与动态调用）。
6. 性能：1 万行工程影响面分析 ≤1.5s。

**验收标准**

- [ ] 三类语言的 AST 解析均能精确定位符号（file:line:col）且作用域正确
- [ ] 反例测试通过：同名局部变量、注释中的同名文本、第三方库同名符号**均不被索引为可改项**
- [ ] 文档/记忆/逻辑结构三类非代码命中带置信度与段落定位
- [ ] 三级风险分类正确（构造 9 个样例覆盖三类）
- [ ] 1 万行工程索引构建 + 影响面分析 ≤1.5s（附实测）

**▶ AI 执行提示词**

```
任务 T7-02：实现出现位置索引（packages/registry/src/occurrence）。
要求（FR-UNI-06：禁止纯文本替换，必须 AST 作用域感知）：
1) ast/ts-parser.ts（ts-morph）、python-parser.ts（libcst，通过 Python 子进程或等效方案；不可得时给出降级策略与告警）、java-parser.ts（JavaParser 或等效）；统一输出 Occurrence{kind:'code', refPath, locator:'file:line:col', matchedSymbol(投影类型), confidence:1.0, riskLevel}。
2) **作用域感知**：只索引真正引用该符号的位置（导入、声明、调用、类型引用），必须排除：同名局部变量、注释/字符串字面量中的同名文本、第三方库同名符号。编写 3 个专项反例测试断言这些位置不出现在索引中。
3) doc-scanner.ts：扫描需求文档/技术文档/关联文档，按段落（Markdown 标题 id / PDF 页码）定位提及，语义匹配置信度 0~1。
4) memory-scanner.ts：扫描五层记忆的 structured（精确匹配 confidence 1.0）与 content 正文（语义匹配置信度）。
5) logic-scanner.ts：扫描 PageDSL 树节点名、绑定路径、事件动作目标。
6) risk-classifier.ts：三级风险——auto（组件名、变量名、CSS 类、i18n key、逻辑结构）/ confirm（API 字段名、DTO 字段、Service 方法名）/ warn 默认不改（数据库列名、已发布外部 API 路径、跨项目引用、反射与动态调用）；分级规则可在设置中调整。
7) 索引持久化到 occurrence 表（§6.2），代码变更后标记 status='stale' 并支持增量重建。
8) 性能：1 万行工程的索引构建 + 影响面分析 ≤1.5s，输出实测数据。
9) 测试：三类语言解析、3 个反例、三类非代码扫描、9 个风险分级样例、stale 标记与增量重建、性能基准。
验收：测试通过；输出 1 万行工程的实测耗时。
```

---

## T7-03 重命名触发与影响面分析 UI

| 项       | 内容                                                     |
| -------- | -------------------------------------------------------- |
| 覆盖需求 | FR-UNI-03；FR-UNI-13（D-07 项目内）；FR-UNI-11；NFR-P-06 |
| 优先级   | P0                                                       |
| 前置任务 | T7-02、T3-06、T3-07                                      |
| 可并行   | 无                                                       |

**产出物**

- `apps/renderer/src/features/rename/{RenameDialog.tsx,ImpactPanel.tsx,RiskGroup.tsx,ConflictWarning.tsx}`
- `packages/registry/src/{rename-trigger.ts,impact-analyzer.ts}`
- 测试

**实现要点**

1. 触发点：设计器画布属性面板改名、图层树重命名、页面名、功能名；**修改后 300ms 内弹出影响面分析面板**（防抖）。
2. 影响面：基于 AST 引用图 + 出现位置索引列出全部受影响位置，按 auto / confirm / warn 三级分组展示；warn 区默认不勾选。
3. 合法性校验前置：保留字、冲突、非法字符、长度 → 不通过则阻断并给出建议名（复用 T7-01）。
4. **作用范围限定项目内（D-07）**：影响面面板中不存在跨项目条目；长期记忆中的提及由用户在记忆中心自行维护，面板需明确提示这一边界。
5. 分级规则可在设置中调整。

**验收标准**

- [ ] 四处触发点改名后 300ms 内弹出面板（E2E-15 前置）
- [ ] 三级分组正确，warn 区默认未勾选
- [ ] 非法名被阻断并给出 3 个建议名
- [ ] 面板中不含任何跨项目条目，且有"仅限本项目生效"的明确提示
- [ ] 1 万行工程影响面分析 ≤1.5s

**▶ AI 执行提示词**

```
任务 T7-03：实现重命名触发与影响面分析 UI（apps/renderer/src/features/rename + packages/registry）。
要求：
1) rename-trigger.ts：监听四处触发点——画布属性面板改名、图层树重命名、页面名修改、功能名修改；300ms 防抖后触发影响面分析（FR-UNI-03）。
2) 前置合法性校验（复用 T7-01 conflict-check）：保留字、与已有标识符冲突、非法字符、超长 → 阻断并给出 3 个建议名，不允许进入影响面分析。
3) impact-analyzer.ts：基于 T7-02 的出现位置索引 + AST 引用图，列出全部受影响位置，输出 {auto[], confirm[], warn[]} 三级分组，每组含 kind（code/doc/memory/logic）、位置、命中投影类型、置信度。
4) ImpactPanel：分三组折叠展示，auto 与 confirm 默认勾选、warn 默认不勾选；每条可展开查看上下文 ±3 行；支持搜索定位；顶部显示总计与预计耗时。
5) **作用范围限定项目内（D-07）**：结果集中绝不包含跨项目条目；面板顶部明确提示"本次重命名仅影响当前项目，不修改长期记忆与其他项目；跨项目复用请手动导入 .ecpkg"。
6) 分级规则可在设置中调整（auto/confirm/warn 的归属可自定义）。
7) 性能：1 万行工程 ≤1.5s（复用 T7-02 基准）。
8) 测试：四处触发、300ms 防抖、非法名阻断与建议、三级分组与默认勾选、无跨项目条目、设置调整分级、性能。
验收：测试通过；E2E-15 前置条件具备。
```

---

## T7-04 事务化执行、diff 预览与一键撤销

| 项       | 内容                                                                 |
| -------- | -------------------------------------------------------------------- |
| 覆盖需求 | FR-UNI-05/06/07/08/09/12；E2E-15；E2E-16；E2E-17；NFR-R-04；NFR-P-07 |
| 优先级   | P0                                                                   |
| 前置任务 | T7-03、T4-05、T4-06                                                  |
| 可并行   | 无                                                                   |

**产出物**

- `packages/registry/src/{rename-transaction.ts,executors/{code-ast.ts,doc-replace.ts,memory-update.ts,logic-recalc.ts,anchor-sync.ts},unified-diff.ts,rename-event.ts}`
- `apps/renderer/src/features/rename/{UnifiedDiffView.tsx,RenameProgress.tsx,RenameHistory.tsx}`
- 测试（含失败注入）

**实现要点**

1. 四栏 diff 预览：代码 / 文档 / 记忆 / 逻辑结构，逐项可勾选，支持检索定位，任一栏可展开上下文 ±3 行。
2. 事务化执行顺序：AST 级重构 → 文档替换 → 记忆更新 → 逻辑结构重算 → 注册表与锚点更新；**任一步失败整体回滚，不留中间态**。
3. AST 重构（FR-UNI-06）：ts-morph / libcst / JavaParser，作用域感知，不误伤同名局部变量与字符串字面量。
4. 记忆更新：更新页面/功能/项目记忆的 structured 逻辑结构 JSON（高置信自动改）与正文提及（低置信列为候选由用户确认）。
5. 文档更新：需求文档、技术文档及关联文档提及处同步修改，保留修订记录（可切换显示/隐藏修订标记）。
6. 成功后生成 rename 事件（含完整变更集与 commit sha）+ Git 提交 `refactor(rename): A → B`；支持一键撤销与历史查看；代码与脚本只能由 AI 写入（D-04），重命名引擎属于 AI 写入链路的一部分。
7. 性能：≤200 处变更 ≤5s 且全程可中断回滚。

**验收标准**

- [ ] E2E-15：改"登录按钮"为"登录提交"后，前端组件/变量/CSS、后端 DTO/Service、需求与技术文档、页面与功能记忆、逻辑结构全部同步，Ctrl+点击跳转不失效
- [ ] E2E-16：同名局部变量与注释中的同名文本不被误改，仅 AST 作用域内符号被替换
- [ ] E2E-17：一键撤销后代码、文档、记忆、逻辑结构、注册表全部还原
- [ ] 失败注入测试：在任一步注入失败，断言整体回滚且无中间态（NFR-R-04）
- [ ] ≤200 处变更执行 ≤5s 且可中断

**▶ AI 执行提示词**

```
任务 T7-04：实现重命名事务化执行、四栏 diff 与一键撤销（packages/registry + 渲染层）。
要求（这是本产品风险最高的功能，必须严格实现）：
1) unified-diff.ts + UnifiedDiffView：四栏 diff（代码 / 文档 / 记忆 / 逻辑结构），逐项可勾选，支持检索定位；任一栏可展开上下文 ±3 行；底部显示"将修改 N 处，其中确认区 M 处、警告区 K 处"。
2) rename-transaction.ts：事务化执行——① AST 级代码重构 ② 文档替换 ③ 记忆更新 ④ 逻辑结构重算 ⑤ 注册表与 Code Anchor 更新；任一步失败**整体回滚**，不留中间态（所有文件写操作走原子写，变更前先备份到事务临时区）。
3) executors/code-ast.ts：ts-morph（TS/JS）、libcst（Python）、JavaParser（Java），**作用域感知**，必须不误伤同名局部变量、字符串字面量、注释文本、第三方同名符号；写 5 个专项测试（E2E-16 场景）。
4) executors/doc-replace.ts：需求文档、技术文档、关联文档提及处同步修改（图表标题、表头、正文均同步），保留修订记录并支持"显示/隐藏修订标记"切换。
5) executors/memory-update.ts：更新页面/功能/项目记忆的 structured 逻辑结构 JSON（置信度 ≥0.8 自动改）与 content 正文提及（<0.8 列入候选，由用户在"记忆提及候选"列表逐条采纳/忽略）。
6) executors/logic-recalc.ts：重算 DSL 与逻辑结构摘要（调用 T2-06），executors/anchor-sync.ts：同步更新 Code Anchor 保证 Ctrl+点击不失效。
7) rename-event.ts：成功后记录 rename 事件（oldName/newName/changeset/scope/commitSha/undone），生成 Git 提交 refactor(rename): A → B；提供一键撤销（按 changeset 反向应用并还原文件、文档、记忆、注册表、锚点）与历史查看。
8) 性能：≤200 处变更 ≤5s，全程可中断回滚。
9) 测试：四栏 diff 渲染、事务成功路径、失败注入（在 5 个执行器各自注入失败断言整体回滚）、E2E-15/16/17 三个场景、一键撤销、性能与中断。
验收：E2E-15/16/17 全部通过；失败注入测试 100% 覆盖五个执行器。
```

---

## T7-05 数据库字段改名迁移、别名兼容期与批处理

| 项       | 内容                                            |
| -------- | ----------------------------------------------- |
| 覆盖需求 | FR-UNI-07（D-08）；FR-UNI-10；FR-UNI-14；E2E-20 |
| 优先级   | P0（迁移）/ P1、P2（别名、批处理）              |
| 前置任务 | T7-04                                           |
| 可并行   | 无                                              |

**产出物**

- `packages/registry/src/{migration/{ddl-generator.ts,migration-preview.ts,migration-executor.ts,safety-check.ts},alias-manager.ts,batch-rename.ts}`
- `apps/renderer/src/features/rename/{MigrationDialog.tsx,AliasCleanupPanel.tsx,BatchRenameDialog.tsx}`
- 测试

**实现要点**

1. 数据库字段改名遵循 D-08：**迁移脚本由 AI 生成**，用户确认后可一键执行；脚本本身也只能由 AI 生成/修改。执行前展示 SQL 预览与影响行数；高危操作（DROP、改类型）二次确认并建议备份；默认只生成脚本不自动执行。
2. 执行后记录到 rename 事件与 Git 提交。
3. 别名与兼容期：可选为旧名生成兼容层（代码 alias 导出、API 旧字段兼容、i18n 旧 key 回退），标记废弃时间与清理待办，项目中以"待清理"清单呈现。
4. 批处理：多选对象批量重命名；"一键全项目命名规范化"（按命名规则重新对齐全部投影）；批处理同样提供 diff 预览与事务回滚。

**验收标准**

- [ ] E2E-20：重命名数据库字段 → 展示 SQL 预览与影响行数 → 确认后执行成功 → 执行记录写入 rename 事件与 Git 提交
- [ ] 高危 SQL（DROP/改类型）二次确认并建议备份；默认只生成不执行
- [ ] 别名兼容层三类（代码 alias / API 旧字段 / i18n 旧 key）可生成，废弃时间可配，待清理清单正确
- [ ] 批量重命名与全项目规范化均有 diff 预览与事务回滚

**▶ AI 执行提示词**

```
任务 T7-05：实现数据库字段改名迁移、别名兼容期与批处理重命名。
要求（D-08：DDL 与迁移脚本只能由 AI 生成，用户确认后一键执行）：
1) ddl-generator.ts：字段改名时调用 AI 生成迁移脚本（含前向迁移与回滚脚本），输入为表结构上下文与旧/新字段名；生成的脚本**禁止用户手动编辑**，只能让 AI 重生成。
2) migration-preview.ts + MigrationDialog：执行前展示 SQL 预览、影响行数估算、锁表/耗时风险提示；safety-check.ts 对高危操作（DROP COLUMN、类型变更、NOT NULL 收紧）强制二次确认并建议先备份；**默认只生成脚本不自动执行**。
3) migration-executor.ts：用户确认后一键执行（通过项目配置的数据源连接，连接串走 secure-store），执行过程流式输出日志；成功后记录到 rename 事件（含 commit sha）与 Git 提交；失败自动尝试回滚脚本并告警。
4) alias-manager.ts + AliasCleanupPanel：可选为旧名生成兼容层——代码 alias 导出、API 旧字段兼容、i18n 旧 key 回退；每项标记废弃时间与清理期限，项目中以"待清理"清单呈现，支持一键清理。
5) batch-rename.ts + BatchRenameDialog：多选对象批量重命名，以及"一键全项目命名规范化"（按当前命名规则重新对齐全部投影）；批处理必须提供 diff 预览与事务回滚（复用 T7-04 事务）。
6) 测试：DDL 生成与回滚脚本、SQL 预览与影响行数、高危二次确认与默认不执行、执行成功记录到 rename 事件与提交、执行失败回滚、三类别名生成与清理清单、批处理 diff 与回滚。
验收：测试通过；E2E-20 手工走通（含 SQL 预览与执行记录）。
```

---

**Wave 7 出口检查**：E2E-15（级联同步）、E2E-16（不误伤局部变量与注释）、E2E-17（一键撤销）、E2E-20（迁移一键执行）四条全部通过；失败注入测试覆盖五个执行器。
