# Wave 5 — 开发流水线 S1–S7（T5-01 ~ T5-06）

> 目标：需求 → 界面 → 技术文档 → 拆分 → 逐个生成 全链路可视化、可版本化、可回退、可断点恢复。
> 依赖：Wave 1（AI 网关）、Wave 2（记忆）、Wave 3（设计器）、Wave 4（上下文与写入）。

---

## T5-01 流水线状态机内核

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-PIPE-01/02/04/11；§6.2 pipeline_run / stage_artifact |
| 优先级 | P0 |
| 前置任务 | T0-07、T0-08、T0-09 |
| 可并行 | 无 |

**产出物**

- `packages/pipeline/src/{pipeline-machine.ts,stage-defs.ts,artifact-store.ts,persistence.ts,recovery.ts}`
- 测试（含状态机全覆盖）

**实现要点**

1. 七阶段 S1–S7（定义见 PRD §7.1：输入、产出物、完成条件），状态：`pending / running / awaiting_confirm / confirmed / stale`。
2. 阶段产物版本化：每阶段文档支持 v1/v2/v3…，保留全部历史与 diff；版本切换不影响下游已生成内容，但提示"文档已更新，是否重新生成下游"。
3. 回退：从任意阶段回退到之前阶段需二次确认，回退后下游状态自动置为 `stale`。
4. 持久化与恢复：关闭客户端后重开可恢复进度（含断点续生成）；恢复时校验产物文件一致性，异常时提示。
5. 状态机非法转移被拒绝（如 pending 直接到 confirmed）。

**验收标准**

- [ ] 七阶段状态机合法转移全覆盖，非法转移被拒绝
- [ ] 产物版本化可切换、可 diff，切换下游提示正确
- [ ] 回退需二次确认且下游置 stale
- [ ] 模拟强杀后重启可恢复到断点（丢失窗口 ≤30s）
- [ ] 产物文件被外部删除时恢复阶段给出明确提示

**▶ AI 执行提示词**

```
任务 T5-01：实现流水线状态机内核（packages/pipeline）。
要求：
1) stage-defs.ts：定义 S1–S7 七阶段（S1 需求文档生成 / S2 界面设计 / S3 技术文档生成 / S4 功能与页面拆分 / S5 逐个生成 / S6 集成联调 / S7 交付与维护），每阶段含 输入、产出物类型、完成条件、可否跳过。
2) pipeline-machine.ts：显式状态机，状态 pending|running|awaiting_confirm|confirmed|stale；定义合法转移表，非法转移抛 InvalidTransitionError；提供 advance/back/confirm/markStale/skip 操作。
3) artifact-store.ts：阶段产物版本化（requirement_doc/design_dsl/tech_doc/code_patch 等 artifact_type），每版本独立存储内容引用与 diff 引用；支持版本切换（切换不影响下游已生成内容，但发事件提示"文档已更新，是否重新生成下游"）。
4) 回退：back(fromStage, toStage) 需二次确认（由 UI 层调用前确认），回退后 fromStage 之后全部置 stale。
5) persistence.ts + recovery.ts：状态与产物引用落 pipeline_run / stage_artifact 表；每 20s 持久化一次（复用 T0-09 崩溃恢复机制）；重启后恢复进度并支持断点续生成；恢复时校验产物文件一致性（缺失/被改则提示并列出）。
6) 测试：合法转移全覆盖、非法转移拒绝、版本切换与 diff、回退置 stale、崩溃恢复（模拟强杀后重启）、产物缺失提示。
验收：测试通过；给出一次"强杀 → 重启 → 恢复到断点继续生成"的记录。
```

---

## T5-02 流水线 UI（步骤条 / 产物面板 / 四种修改操作）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-PIPE-01/02/03/12；E2E-03 |
| 优先级 | P0 |
| 前置任务 | T5-01、T0-06 |
| 可并行 | 无 |

**产出物**

- `apps/renderer/src/features/pipeline/{PipelineBar.tsx,StagePanel.tsx,ArtifactViewer.tsx,VersionSwitcher.tsx,DiffPanel.tsx,ModifyActions.tsx,SupplementDialog.tsx}`
- 测试

**实现要点**

1. 横向步骤条：当前阶段高亮，已完成可点击回看，状态四色（未开始/进行中/已确认/已跳过）。
2. 产物面板：文档渲染（Markdown + 图表）、版本切换与 diff 对比。
3. 「修改至满意」闭环四操作：重新生成 / 局部修改 / 手动编辑 / 追加要求；追加要求时保留原文档并要求 AI 输出完整新版（避免碎片化）。
4. 用户补充指令：任意阶段可"插入补充需求"，系统评估影响范围并高亮需重新生成的节点。

**验收标准**

- [ ] 步骤条七阶段状态显示正确，已确认阶段可回看
- [ ] 四操作全部可用；"追加要求"后文档为完整新版而非补丁拼接
- [ ] 版本切换可 diff，切换后下游提示"是否重新生成"
- [ ] 补充需求能列出影响范围清单（与 T5-05 拆分结果联动）

**▶ AI 执行提示词**

```
任务 T5-02：实现流水线 UI（apps/renderer/src/features/pipeline）。
要求：
1) PipelineBar.tsx：横向 7 阶段步骤条，当前高亮，显示四态（未开始/进行中/已确认/已跳过），已完成阶段可点击回看（切换到该阶段的产物视图），回退按钮带二次确认。
2) StagePanel + ArtifactViewer：展示当前阶段产物（Markdown 渲染、Mermaid 图表渲染、DSL 结构预览），支持只读查看与版本切换。
3) VersionSwitcher + DiffPanel：版本下拉切换（v1/v2/…），切换后对比 diff（Markdown 用文本 diff，DSL 用结构化 diff），并在下游已生成时提示"文档已更新，是否重新生成下游"。
4) ModifyActions：「修改至满意」四操作——重新生成（重跑本阶段）、局部修改（选中章节/段落让 AI 改）、手动编辑（文档类产物允许编辑，代码类不允许）、追加要求（把补充指令与原文档一起提交，要求 AI 输出**完整新版**而非补丁）。
5) SupplementDialog：任意阶段可插入补充需求，调用影响面评估（回调 T5-05 的拆分结果）高亮列出需重新生成的节点，用户确认后执行。
6) 测试：步骤条状态渲染、四操作行为（重点验证追加要求返回完整新版）、版本 diff、补充需求影响清单渲染。
验收：测试通过；E2E-03（输入 200 字想法走完全流程且每阶段可编辑与回退）手工走通。
```

---

## T5-03 S1 需求文档生成

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-PIPE-05；FR-DOC-06（产物入档） |
| 优先级 | P0 |
| 前置任务 | T4-04、T5-01 |
| 可并行 | T5-05 |

**产出物**

- `packages/pipeline/src/stages/{s1-requirement.ts,templates/requirement-doc.ts}`
- 测试 + 一份样例输出

**实现要点**

1. 基于用户自然语言描述，结合**长期记忆偏好**与**相似项目记忆**（用 T2-03 检索相似项目）生成结构化需求文档。
2. 输出含：项目背景、目标用户、功能清单（含优先级）、用户故事、业务流程图（Mermaid）、验收标准、非功能要求、风险与假设。
3. 产物自动入档文档库并关联对应记忆（命名 `<项目>-需求文档-v<阶段版本>.md`）。
4. 版本化与四种修改操作复用 T5-01 / T5-02 能力。

**验收标准**

- [ ] 输入 200 字描述能产出含全部八项要素的需求文档
- [ ] 长期记忆中的偏好被体现（例："必须有单元测试"出现在非功能要求）
- [ ] 产物入档文档库并关联项目记忆（断言 document 与 memory_doc_link 记录）
- [ ] 文件命名符合 `<项目>-需求文档-v<版本>.md`

**▶ AI 执行提示词**

```
任务 T5-03：实现 S1 需求文档生成（packages/pipeline/src/stages/s1-requirement.ts）。
要求：
1) 输入：用户自然语言描述 + 长期记忆（偏好、禁止事项）+ 相似项目记忆（调 packages/memory 的检索接口取 top3 相似项目的项目记忆摘要）。
2) 输出结构化需求文档，必须包含八项：项目背景、目标用户、功能清单（含 P0/P1/P2 优先级）、用户故事（作为…我希望…以便…）、业务流程图（Mermaid flowchart）、验收标准（可勾选清单）、非功能要求、风险与假设。
3) 上下文组装与提示词复用 T4-02/T4-04（purpose='requirement'），长期记忆中的禁止事项必须用强约束句式注入（§13.2）。
4) 产物入档：保存到文档库并关联项目记忆（写 document 表 + memory_doc_link），文件命名 <项目>-需求文档-v<阶段版本>.md（FR-DOC-06）。
5) 版本化与四种修改操作（重新生成/局部修改/手动编辑/追加要求）复用 T5-01 与 T5-02。
6) 测试：八项要素齐全（正则/结构断言）、长期记忆偏好体现（构造"必须有单元测试"的记忆断言其出现在非功能要求）、入档与关联断言、命名规范。
验收：测试通过；附一份 200 字输入生成的完整需求文档样例。
```

---

## T5-04 S3 技术选型问卷与技术文档生成

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-PIPE-13（D-04）；FR-PIPE-06；FR-PIPE-07；E2E-19 |
| 优先级 | P0 |
| 前置任务 | T5-03、T2-01 |
| 可并行 | 无 |

**产出物**

- `packages/pipeline/src/stages/{s3-techdoc.ts,tech-choice-questionnaire.ts,templates/tech-doc.ts}`
- `apps/renderer/src/features/pipeline/{TechChoiceWizard.tsx,TechDocPanel.tsx}`
- 测试

**实现要点**

1. **进入 S3 前必须弹出技术选型问卷**（FR-PIPE-13）：目标端组合（七端多选：Web / Android / iOS / HarmonyOS / Windows / Linux / macOS）、各端技术方案（按 FR-AI-13 矩阵：Web 的 React/Vue 3；移动双端的 Flutter/React Native/原生；鸿蒙的 ArkTS + ArkUI；桌面三端的 Tauri 2/Electron/Qt）、前端框架、后端框架、数据库、ORM、部署方式；每项给出推荐项与权衡说明；**用户未选择不得进入 S3**；选择结果写入项目记忆并在后续所有生成中强制遵守；问卷可在设置中重填。
2. 技术文档生成：技术选型（含选型理由与权衡）、系统架构（分层图/部署图 Mermaid）、模块划分、数据模型（ER + 表结构）、接口设计（OpenAPI 草案）、安全设计、性能与容量估算、测试策略。
3. 尊重记忆：若长期/项目记忆已声明技术栈，生成方案必须遵循，冲突时给出对比说明而非直接覆盖；记忆中禁止的技术必须被遵守。
4. 接口设计输出 OpenAPI 3.0 草案，供 T6-05 Mock Server 消费。

**验收标准**

- [ ] E2E-19：S1→S3 前弹出问卷，未选择无法进入 S3；选择结果写入项目记忆
- [ ] 技术文档八项内容齐全，含 OpenAPI 草案（可被 T6-05 解析）
- [ ] 记忆中已声明技术栈被严格遵守；记忆中的禁止技术不出现在方案中
- [ ] 问卷可在设置中重填，重填后提示下游需重新生成

**▶ AI 执行提示词**

```
任务 T5-04：实现技术选型问卷与 S3 技术文档生成。
要求（严格遵循 D-04 与 FR-PIPE-13）：
1) tech-choice-questionnaire.ts + TechChoiceWizard.tsx：进入 S3 前强制弹出可视化问卷——目标端组合（七端多选）→ 各端技术方案（按 FR-AI-13 矩阵动态出题：Web 选 React/Vue 3（默认 React）；Android/iOS 选 Flutter/React Native/原生（默认 Flutter 并说明单代码库降低端间不一致风险的权衡）；HarmonyOS 选 ArkTS + ArkUI（v1.0 唯一推荐）；桌面三端选 Tauri 2/Electron/Qt（默认 Tauri 2））→ 前端框架、后端框架、数据库、ORM、部署方式；每项提供推荐项与 2-3 个选项的权衡说明；矩阵中无可用方案的端禁用并说明。**用户未选择不得进入 S3**（状态机层面阻断）；选择结果写入项目记忆 structured.stack 与 structured.targetPlatforms，并在后续所有生成中强制遵守；问卷可在设置中随时重填，重填后发事件提示下游需重新生成。
2) s3-techdoc.ts：基于需求文档 + 页面逻辑结构 + 项目/长期记忆生成技术文档，必须含八项：技术选型（含理由与权衡）、系统架构（Mermaid 分层图 + 部署图）、模块划分、数据模型（Mermaid ER + 表结构清单）、接口设计（**OpenAPI 3.0 草案**）、安全设计、性能与容量估算、测试策略。
3) 尊重记忆（FR-PIPE-07）：若长期/项目记忆已声明技术栈，生成方案必须遵循；冲突时给出对比说明而非直接覆盖；记忆中的禁止技术（如"禁止使用 XX 框架"）绝不可出现在方案中——实现后置校验器，检测到禁止技术则重新生成一次并告警。
4) OpenAPI 草案需结构合法（用 openapi 校验库断言），供 T6-05 Mock Server 消费。
5) 测试：问卷阻断未选择进入 S3、选择结果写入项目记忆、八项内容齐全、OpenAPI 草案可校验、禁止技术后置校验触发重生成、重填问卷的 stale 提示。
验收：测试通过；E2E-19 手工走通；输出一份含 OpenAPI 草案的技术文档样例。
```

---

## T5-05 S4 功能与页面拆分（DAG 拓扑）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-PIPE-08；FR-PIPE-12（影响面评估） |
| 优先级 | P1 |
| 前置任务 | T5-04 |
| 可并行 | T5-03 |

**产出物**

- `packages/pipeline/src/stages/{s4-split.ts,dependency-graph.ts,topo-sort.ts}`
- `apps/renderer/src/features/pipeline/{SplitGraph.tsx,SplitEditor.tsx}`
- 测试

**实现要点**

1. 自动把技术文档拆分为功能单元与页面单元，计算依赖关系，拓扑排序。
2. DAG 可视化：节点为功能/页面，边为依赖；支持手动调整顺序、合并/拆分节点。
3. 环检测：依赖成环时阻断并高亮环路。
4. 影响面评估接口 `evaluateImpact(changeInput)`：给定变更（需求补充/技术文档更新/重命名），返回需重新生成的节点列表（供 T5-02 与 T7 消费）。

**验收标准**

- [ ] 拆分结果包含功能树与页面清单，依赖关系正确
- [ ] DAG 图可视化可交互，手动调整顺序后拓扑重算
- [ ] 环检测能定位环路并阻断
- [ ] 影响面评估返回准确的需重生成节点（构造 3 个场景验证）

**▶ AI 执行提示词**

```
任务 T5-05：实现 S4 功能与页面拆分与 DAG 拓扑（packages/pipeline/src/stages）。
要求：
1) s4-split.ts：基于技术文档 + 页面清单 + 功能清单，自动拆分为功能单元与页面单元（调用 AI 的 techdoc 用途或规则解析，输出 {features:[{id,name,pageIds,dependsOn[]}], pages:[{id,name,featureId,dependsOn[]}]}），并进行拓扑排序（topo-sort.ts）。
2) dependency-graph.ts：图结构（节点、边、入度/出度查询、子图提取），环检测（DFS 染色，输出环路节点列表），阻断成环并高亮。
3) SplitGraph.tsx：DAG 可视化（自绘 SVG，分层布局），节点显示名称/状态/类型（功能/页面），边显示依赖方向；支持缩放、拖拽、按路径高亮。
4) SplitEditor.tsx：手动调整依赖顺序（增删边）、合并节点（多页面合并为一个功能单元）、拆分节点（一个功能拆为多个），变更后重算拓扑并校验环。
5) evaluateImpact(change: {type:'requirement'|'techdoc'|'rename'|'supplement', targets:string[]}) → 返回需重新生成的节点列表（沿依赖边正向传播，含间接影响），供 T5-02 补充需求与 T7 重命名消费。
6) 测试：拆分结果结构、拓扑排序正确性、环检测环路输出、手动合并/拆分后重算、影响面传播（3 个场景）。
验收：测试通过；输出一份含 5 个功能 8 个页面的 DAG 样例与拓扑序。
```

---

## T5-06 S5 逐个生成队列（含多端真实代码生成）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-PIPE-09；FR-PIPE-10；FR-AI-12/13（D-03）；FR-GIT-09 |
| 优先级 | P0 |
| 前置任务 | T5-05、T4-05、T4-06 |
| 可并行 | 无 |

**产出物**

- `packages/pipeline/src/stages/{s5-generate.ts,generation-queue.ts,contract-injector.ts,multi-platform-generator.ts}`
- `apps/renderer/src/features/pipeline/{GenerationQueuePanel.tsx,NodeStatusCard.tsx}`
- 测试

**实现要点**

1. 按拓扑序逐个生成；每节点独立可重试、可跳过、可单独回退；队列面板实时显示进度；单节点失败不阻塞队列（可配置暂停）。
2. 生成粒度：每节点上下文 = 自身记忆 + 上层记忆 + 已生成依赖的**接口契约**（调 contract-injector，注入接口摘要而非全部代码）。
3. 多端真实代码生成（FR-AI-12）：按 S3 问卷确认的各端方案（FR-AI-13 矩阵）为所选目标端生成可编译工程代码（页面、路由、状态管理、接口调用、平台适配）——移动端默认 Flutter、鸿蒙端生成 ArkTS + ArkUI（Stage 模型）工程、桌面端默认 Tauri 2（可改选 Electron）；生成后**强制编译校验**（Flutter 走 flutter build、鸿蒙走 hvigor、桌面走对应构建命令，失败反馈给 AI 重试 ≤2 次；工具链缺失时输出安装引导与待验清单，绝不静默跳过，NFR-C-05）；单端编译失败只阻断该端节点，不阻塞其他端。
4. 断点续生成（复用 T5-01 recovery）；每节点完成可配置自动 Git 提交（默认关闭，建议每阶段提交）。
5. 每个节点生成后：写回 Code Anchor、更新 Git 变更视图、触发预览热更新。

**验收标准**

- [ ] 队列按拓扑序执行，单节点失败可重试/跳过/回退且不阻塞整体（可配置暂停）
- [ ] 上下文仅含自身记忆 + 上层记忆 + 依赖接口契约（断言不含无关代码）
- [ ] 多端生成后可构建（提供一次 `flutter build apk --debug` 与一次鸿蒙 hvigor assembleHap 或桌面构建的成功记录；工具链缺失时输出降级说明与待验清单）
- [ ] 单端编译失败只阻断该端节点，其他端队列继续
- [ ] 断点续生成：强杀后重启从失败节点继续
- [ ] 自动提交开关生效，提交信息格式 `<type>(<scope>): <subject>`

**▶ AI 执行提示词**

```
任务 T5-06：实现 S5 逐个生成队列与多端真实代码生成（packages/pipeline/src/stages）。
要求：
1) generation-queue.ts：按 T5-05 的拓扑序串行生成；每个节点状态 pending|running|success|failed|skipped；支持单节点 重试 / 跳过 / 单独回退（回退到该节点生成前的 Git 状态或代码快照）；队列面板实时显示进度、当前节点、耗时；单节点失败默认不阻塞（可配置为失败即暂停）。
2) s5-generate.ts 的上下文严格限定为：节点自身记忆 + 上层记忆 + 已生成依赖的**接口契约摘要**（contract-injector.ts 从已生成代码/技术文档提取 OpenAPI 风格摘要），禁止注入全部历史代码（FR-PIPE-10，写断言测试验证）。
3) multi-platform-generator.ts（FR-AI-12 / FR-AI-13 / D-03）：按 S3 问卷确认的各端方案为所选目标端生成可编译工程代码——页面、路由、状态管理、接口调用、平台适配；移动端默认 Flutter（单代码库覆盖 Android/iOS），HarmonyOS 生成 ArkTS + ArkUI（Stage 模型）工程，桌面端默认 Tauri 2（单代码库覆盖 Windows/Linux/macOS，可改选 Electron）；生成后**强制编译校验**（探测本机 flutter / hvigor / cargo tauri 等命令，存在则执行构建，失败把编译错误回传给 AI 重试最多 2 次；工具链缺失时输出安装引导与"待验清单"，不得静默跳过，NFR-C-05）；单端失败只阻断该端节点，不阻塞其他端。
4) 断点续生成：节点级进度持久化（落 stage_artifact 或独立表），重启后从失败节点继续；复用 T5-01 recovery。
5) 每个节点完成后：写回 Code Anchor（T4-06）、发事件刷新 Git 变更视图、触发预览热更新；可配置自动 Git 提交（默认关闭，建议"每阶段提交"），提交信息格式 <type>(<scope>): <subject>（FR-GIT-09）。
6) 测试：拓扑序执行、失败重试/跳过/回退、契约注入断言（不含无关代码）、断点续生成、自动提交开关与信息格式、多端生成与单端失败隔离；Flutter/鸿蒙/桌面生成部分做可编译性冒烟（无环境时输出降级说明）。
验收：测试通过；输出一次含多端节点的队列完整执行日志与耗时统计。
```

---

**Wave 5 出口检查**：输入 200 字想法 → S1 需求文档 → S2 设计 → S3 技术选型问卷 + 技术文档 → S4 拆分 → S5 逐个生成，每阶段可编辑可回退（E2E-03）；技术选型未选择无法进入 S3（E2E-19）。
