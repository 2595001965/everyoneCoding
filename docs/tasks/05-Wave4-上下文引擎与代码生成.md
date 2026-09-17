# Wave 4 — 上下文引擎与代码生成（T4-01 ~ T4-06）

> 目标：选中元素 → 组装上下文 → 生成后端代码 → diff 预览 → 由 AI 应用 → 写回代码锚点。
> 对应 PRD M10（备注）、M6（上下文引擎与代码生成）。依赖 Wave 1、Wave 2、Wave 3。

---

## T4-01 备注与批注系统（M10）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-ANN-01 ~ FR-ANN-07 |
| 优先级 | P0 |
| 前置任务 | T3-01、T0-08 |
| 可并行 | 无 |

**产出物**

- `packages/designer/src/notes/{note-model.ts,note-repo.ts,NotePopover.tsx,NoteBadge.tsx,NotePanel.tsx,NoteHistory.tsx}`
- 测试

**实现要点**

1. 三级备注：元素级（右键添加）、页面级（页面标签页）、功能级（功能节点）；内容支持富文本 + checkbox 清单 + 代码片段。
2. 类型：业务规则 / 校验要求 / 交互说明 / 待办 / 疑问 / 禁止事项，颜色区分；**禁止事项自动提升优先级**。
3. 元素角标与图层树节点显示备注图标；备注面板集中查看当前项目全部备注，可筛选与跳转到元素；未解决备注计入项目仪表盘。
4. 变更留痕：修改保留历史，AI 生成时可对比"备注是否有更新"，更新后提示"重新生成该元素"。
5. 对外暴露 `getNotesForContext(target)` 供 T4-02 高优先级注入。

**验收标准**

- [ ] 三级备注均可增删改，元素角标与图层树图标正确显示
- [ ] 六类备注颜色区分，禁止事项在上下文排序中置顶
- [ ] 备注面板可按类型/状态筛选，点击跳转到元素并高亮
- [ ] 备注修改有历史，AI 生成时能对比出"备注已更新"

**▶ AI 执行提示词**

```
任务 T4-01：实现备注与批注系统（packages/designer/src/notes）。
要求：
1) note-model.ts：Note {id, targetType('element'|'page'|'feature'), targetId, type('业务规则'|'校验要求'|'交互说明'|'待办'|'疑问'|'禁止事项'), content(富文本 JSON), checklists[], codeBlocks[], status('open'|'resolved'), priority, version, history[]}；zod 校验。
2) 入口：元素右键菜单「添加备注」、页面标签页「页面备注」、功能节点「功能备注」；NotePopover 支持富文本（加粗/列表/代码）+ checkbox 清单 + 代码片段（带语言标记）。
3) NoteBadge：元素右上角与图层树节点显示备注角标；不同类型不同颜色，禁止事项用红色并**自动提升优先级**（priority 计算时加权）。
4) NotePanel：侧边栏集中查看项目全部备注，支持按类型/状态/目标筛选、搜索、点击跳转到元素并高亮；未解决备注计数暴露给项目仪表盘。
5) NoteHistory：每次修改保留历史版本；对外暴露 getNotesForContext(target) 返回按优先级排序的备注（禁止事项置顶），以及 hasNoteUpdatedSince(target, since) 供 AI 生成时对比。
6) 测试：三级备注 CRUD、类型与优先级排序、角标渲染、跳转定位、历史留痕与 hasNoteUpdatedSince。
验收：测试通过；手工给"登录按钮"加一条"需校验图形验证码"备注并在元素上看到角标。
```

---

## T4-02 上下文组装引擎（Context Engine）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-AI-01；FR-PIPE-10；FR-ANN-06；§13.2；NFR-P-04（≤300ms） |
| 优先级 | P0 |
| 前置任务 | T2-01、T4-01、T4-06（锚点可后置接入） |
| 可并行 | 无 |

**产出物**

- `packages/ai/src/context/{context-engine.ts,blocks/{longterm,project,feature,page,element-chain,note,issue,document,code,dependency-contract}.ts,context-panel-model.ts}`
- `apps/renderer/src/features/ai/{ContextPanel.tsx,BlockCard.tsx}`
- 测试 + 性能基准

**实现要点**

1. 八类上下文块（严格按 FR-AI-01）：① 长期记忆 ② 项目记忆 ③ 页面记忆 ④ 元素及祖先链结构 ⑤ 元素备注 ⑥ 关联问题记忆与文档片段 ⑦ 需求/技术文档相关章节 ⑧ 已有代码与 Code Anchor。
2. 组装顺序按 PRD §M6 建议顺序与配额（长期 ≤8k、项目 ≤24k、功能 ≤16k、页面 ≤16k、元素链+备注 ≤8k、问题+文档 ≤8k、代码 ≤40k、指令+历史 ≤16k）。
3. 上下文面板可视化：每块可勾选/折叠/编辑，展示"本次将提交什么"。
4. 依赖契约注入：S5 逐个生成时注入已生成依赖的**接口契约摘要**而非全部历史代码（与 T5-06 共用）。
5. 备注以高优先级注入；性能：组装耗时 ≤300ms。

**验收标准**

- [ ] 八类块全部能组装，缺失时优雅跳过并记录
- [ ] 组装顺序与配额符合 PRD 建议，实测 token 分布有报告
- [ ] 上下文面板可勾选/编辑，勾选变化实时反映到提交内容
- [ ] 1000 条记忆场景下组装 ≤300ms（附基准数据）

**▶ AI 执行提示词**

```
任务 T4-02：实现上下文组装引擎（packages/ai/src/context）。
要求：
1) 严格按 FR-AI-01 组装八类上下文块：① 长期记忆 ② 项目记忆 ③ 页面记忆 ④ 选中元素及其祖先链结构 ⑤ 元素备注 ⑥ 关联问题记忆与关联文档片段 ⑦ 需求文档与技术文档相关章节 ⑧ 已有代码与 Code Anchor 命中片段。每类一个 block 实现文件，统一接口 ContextBlock{ id, label, priority, tokens, content, source, editable }。
2) 组装顺序与配额遵循 docs/PRD-EveryoneCoding.md M6 的上下文组装顺序（长期 ≤8k、项目 ≤24k、功能 ≤16k、页面 ≤16k、元素链+备注 ≤8k、问题+文档 ≤8k、代码 ≤40k、指令+历史 ≤16k），总预算默认 128k（可配）。
3) 提示词策略遵循 §13.2：角色与输出契约前置、记忆按层排序（越具体越靠后优先级越高）、禁止事项用强约束句式、注入依赖接口契约而非全部代码、要求模型输出"变更说明+风险+未覆盖点"、结构化解析失败时降级为正则提取代码块。
4) 备注以高优先级注入并在面板标注来源（后续生成结果页要标注"已遵循备注 #id"，先传递 noteIds）。
5) 依赖契约注入：暴露 setDependencyContracts(contracts) 供 T5-06 逐个生成时注入已生成依赖的接口摘要。
6) ContextPanel.tsx：可视化"本次将提交什么"，每块可勾选/折叠/就地编辑，实时显示 token 分布条。
7) 测试：八类块缺失降级、顺序与配额、面板交互、性能基准（1000 条记忆下组装 ≤300ms，输出实测数据）。
验收：测试通过；给出一次真实组装的 token 分布报告。
```

---

## T4-03 Token 预算与裁剪

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-AI-02；§13.3（上下文超限） |
| 优先级 | P0 |
| 前置任务 | T4-02 |
| 可并行 | 无 |

**产出物**

- `packages/ai/src/context/{token-budget.ts,trimmer.ts,truncate-report.ts}`
- 测试

**实现要点**

1. 分块配额（见 T4-02）；超预算按优先级裁剪，保留顺序：元素链 > 备注 > 页面记忆 > 功能记忆 > 项目记忆 > 长期记忆 > 文档片段。
2. 裁剪发生时在面板明确提示"已省略 X 项（点击展开）"，并列出被省略条目与其 token。
3. 上下文超限时（模型返回 ContextLengthError）自动触发**更激进裁剪**（仅保留元素链 + 备注 + 页面记忆）并重试一次。
4. 单块内部裁剪策略：记忆按重要度与置信度排序截断；代码按锚点命中度排序截断；文档按相关段落截断。

**验收标准**

- [ ] 超预算时按优先级裁剪，高优先级块永不被裁（除非其自身超配额）
- [ ] 省略清单准确，点击可展开查看被省略内容摘要
- [ ] 触发 ContextLengthError 后激进裁剪并重试一次，仍失败则明确报错
- [ ] 裁剪后再组装的总 token 不超预算（断言）

**▶ AI 执行提示词**

```
任务 T4-03：实现 Token 预算与裁剪（packages/ai/src/context）。
要求：
1) token-budget.ts：总预算默认 128k（可配），按块分配配额（见 T4-02 配额表），支持为不同用途（代码生成/文档生成/记忆抽取）配置不同预算档位。
2) trimmer.ts：超预算时按优先级裁剪，保留顺序严格为 元素链 > 备注 > 页面记忆 > 功能记忆 > 项目记忆 > 长期记忆 > 文档片段；单块内部裁剪策略：记忆按 importance×confidence 排序截断、代码按 Code Anchor 命中度排序截断、文档按相关段落（标题匹配 + 关键词命中）截断。
3) truncate-report.ts：产出省略报告 {omittedCount, omittedTokens, items:[{block, label, tokens, reason}]}，UI 提示"已省略 X 项（点击展开）"并可查看被省略内容摘要。
4) 超限时联动：捕获 ContextLengthError 后自动执行激进裁剪（仅保留元素链 + 备注 + 页面记忆）并重试一次；仍失败则抛出明确错误并建议缩短上下文或换模型。
5) 测试：优先级裁剪顺序、单块内部三种截断策略、省略报告准确性、激进裁剪重试一次、组装后总 token 不超预算的断言。
验收：测试通过；给出一份"超预算 → 裁剪 → 省略报告"的完整示例输出。
```

---

## T4-04 提示词模板、结构化输出与多轮修正

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-AI-03；FR-AI-05；FR-AI-06；FR-AI-07；FR-AI-08；NFR-U-02 |
| 优先级 | P0 |
| 前置任务 | T4-02、T4-03、T1-05 |
| 可并行 | 无 |

**产出物**

- `packages/ai/src/generate/{prompt-templates/{requirement,interface,techdoc,backend-code,frontend-code,mobile-code,harmony-code,desktop-code,commit-msg}.ts,output-schema.ts,parser.ts,generator.ts,decision-card.ts,revision.ts}`
- 测试（含解析成功率统计）

**实现要点**

1. 输出契约：要求模型以 JSON Schema 输出 `{files:[{path,content,action:'create'|'patch'|'delete',language}], anchors:[...], notes, decision:{referencedMemory[], rationale, risks[], uncovered[]}}`。
2. 解析失败自动重试 1 次并降级为**纯文本代码块提取**，仍失败则原样展示并提示用户（成功率目标 ≥95%）。
3. 流式展示 + 随时中断并保留已生成部分；支持"继续生成"。
4. 多轮对话修正：对生成结果继续对话要求修改，修改同样进入增量补丁流程，每轮变更可单独回退。
5. 决策说明卡片：引用了哪些记忆、为什么这样选型、潜在风险（折叠卡片，NFR-U-02 100% 覆盖）。

**验收标准**

- [ ] 结构化输出解析成功率 ≥95%（构造 20 组含异常格式的响应做统计）
- [ ] 解析失败重试 1 次后降级为代码块提取仍可用
- [ ] 中断后保留部分内容且可继续生成
- [ ] 多轮修正每轮可单独回退
- [ ] 决策卡片包含引用记忆、选型理由、风险、未覆盖点四要素

**▶ AI 执行提示词**

```
任务 T4-04：实现提示词模板、结构化输出与多轮修正（packages/ai/src/generate）。
要求：
1) output-schema.ts：定义统一输出 JSON Schema {files:[{path, content, action:'create'|'patch'|'delete', language}], anchors:[{elementId, filePath, symbol, kind, startLine, endLine}], summary, decision:{referencedMemory:[{id,title,layer}], rationale, risks[], uncovered[]}}；并在系统提示中前置该契约（§13.2）。
2) prompt-templates/：九类模板——requirement(需求文档)、interface(界面 DSL)、techdoc(技术文档)、backend-code(Controller/Service/DTO/数据访问/单测)、frontend-code(Web 产物)、mobile-code(Flutter/React Native/原生)、harmony-code(ArkTS + ArkUI)、desktop-code(Tauri/Electron)、commit-msg；模板需注入"禁止臆造接口""必须输出 anchor 声明""变更说明+风险+未覆盖点"等硬约束；端专用模板按项目所选方案注入对应框架与工程结构约束。
3) parser.ts：解析模型输出，失败自动重试 1 次（把上次错误反馈给模型），再失败降级为正则提取 Markdown 代码块，仍失败则原样展示并提示用户手动处理；记录 parseSuccess 指标。
4) generator.ts：流式生成 + AbortSignal 中断（保留已生成部分，标记 partial）+ "继续生成"续写（把已生成内容作为上下文前缀）。
5) revision.ts：多轮对话修正——每轮作为一个 revision 记录（含 diff、prompt、时间），可单独回退到任意一轮。
6) decision-card.ts：把 decision 字段渲染为折叠卡片（引用记忆、选型理由、风险、未覆盖点），生成结果页必须展示（NFR-U-02）。
7) 测试：20 组合法/异常/截断/混排响应的解析成功率统计（目标 ≥95%）、降级路径、中断保留、续写、多轮回退、决策卡片渲染。
验收：测试通过；输出解析成功率统计报告。
```

---

## T4-05 代码写入管线与只读约束

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-AI-04；FR-AI-11；NFR-S-05；E2E-18；D-04 |
| 优先级 | P0 |
| 前置任务 | T4-04、T0-11 |
| 可并行 | T4-06 |

**产出物**

- `packages/ai/src/write/{write-pipeline.ts,diff-view-model.ts,apply-strategy/{create,patch,preview}.ts,read-only-guard.ts,external-change-watcher.ts}`
- `apps/renderer/src/features/code/{CodeView.tsx,DiffView.tsx,ApplyBar.tsx,AiFixEntry.tsx}`
- 测试

**实现要点**

1. 三种写入模式：新建文件 / 增量补丁（diff 应用）/ 预览后**由 AI 应用**；**不存在用户手动编辑代码的模式**。
2. 代码视图只读：编辑器 `readOnly` 100% 覆盖（静态扫描验证），编辑操作被拦截并弹出"交给 AI 修改"入口。
3. 外部改动检测：监听工程目录文件变更（排除 .git 与构建产物），检测到外部编辑器改动时提示"代码已被外部修改，建议回滚到最近提交或让 AI 重新生成"。
4. diff 展示逐文件差异，可选择性应用或要求 AI 重改；应用走原子写，失败整体回滚。
5. 写入后触发：更新 Git 变更视图、预览热更新、Code Anchor 写回。

**验收标准**

- [ ] E2E-18：打开代码视图尝试编辑被拦截，并弹出 AI 修改入口
- [ ] 外部编辑器改文件后 100% 被检测到并提示（用脚本改文件验证）
- [ ] 三种写入模式均可用；patch 失败时整体回滚不留中间态
- [ ] 静态扫描：代码编辑器组件 `readOnly` 100% 覆盖，无任何手动编辑入口

**▶ AI 执行提示词**

```
任务 T4-05：实现代码写入管线与只读约束（packages/ai/src/write + 渲染层代码视图）。
要求（严格遵守 D-04：代码与数据库脚本只能由 AI 写入）：
1) write-pipeline.ts：三种模式 create（新建文件）/ patch（增量补丁，解析 diff 并应用）/ preview（先展示 diff，确认后**由 AI 侧应用**）；不存在任何"用户手动编辑代码"的模式。应用前做冲突检测（文件自上次读取后被修改则拒绝并提示重新生成）。
2) read-only-guard.ts：代码视图强制只读——编辑器组件 readOnly=true，并屏蔽粘贴/拖拽/删除等一切变更入口；任何编辑尝试被拦截并弹出"交给 AI 修改"入口（预填该文件的上下文，跳转到 AI 对话）。
3) external-change-watcher.ts：监听工程目录文件变更（通过 Shell API fs.watch，排除 .git、node_modules、dist、target、构建缓存），发现外部修改时提示"代码已被外部修改，建议回滚到最近提交或让 AI 重新生成"，并提供两个操作按钮。
4) DiffView：逐文件并排/内联切换的 diff（>1MB 文件跳过内容 diff 并提示），支持按文件、按块选择性应用，以及"要求 AI 重改"（带上选择范围与用户意见）。
5) 写入走 packages/core 的原子写；批量写入作为事务，任一步失败整体回滚。
6) 写入后触发事件：Git 变更视图刷新、预览热更新、Code Anchor 写回（事件由 T4-06/T6-02 消费）。
7) 测试：三种模式、冲突检测、只读拦截（含粘贴/拖拽）、外部改动检测（脚本改文件后断言事件）、事务回滚、大文件跳过 diff。
验收：测试通过；E2E-18 手工走通；静态扫描确认编辑器 readOnly 覆盖 100%。
```

---

## T4-06 Code Anchor 管理与校验

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | FR-NAV-04（锚点维护）；FR-AI-03（生成内容一致性）；§12.1 漂移风险 |
| 优先级 | P0 |
| 前置任务 | T4-05 |
| 可并行 | 无 |

**产出物**

- `packages/ai/src/anchors/{anchor-model.ts,anchor-repo.ts,comment-marker.ts,ast-verify.ts,reassociate.ts}`
- 测试

**实现要点**

1. 三重锚定：AI 生成时声明 anchor + 代码注释标记 `// @everyonecoding:anchor <elementId>` + AST 解析校验。
2. 写入 anchor 时记录 file_path / symbol / start_line / end_line / kind（controller/service/dto/repo/sql/test/route）/ commit_sha（§6.2 code_anchor 表）。
3. 校验：生成后立即用 AST 解析（TS 用 ts-morph）核对声明位置与符号是否真实存在，不一致则标记为 drift。
4. 丢失时提供"重新关联"入口（按元素名与符号相似度给候选）。
5. 代码被外部修改导致行号漂移时，按 symbol + 注释标记重新定位并更新行号。

**验收标准**

- [ ] AI 生成的 anchor 声明能被解析入库，字段与 §6.2 一致
- [ ] AST 校验能识别虚假声明（给出 3 个反例测试）
- [ ] 行号漂移后能按 symbol 与注释标记重定位
- [ ] "重新关联"入口能给出候选列表并一键修复

**▶ AI 执行提示词**

```
任务 T4-06：实现 Code Anchor 管理与校验（packages/ai/src/anchors）。
要求：
1) anchor-model.ts：字段对齐 docs/PRD-EveryoneCoding.md §6.2 code_anchor 表（id/project_id/element_id/page_id/feature_id/file_path/symbol/start_line/end_line/kind/commit_sha），kind 枚举 controller|service|dto|repo|sql|test|route；zod 校验。
2) 三重锚定：① AI 生成输出中的 anchors 声明（T4-04 的 schema）② 代码注释标记 // @everyonecoding:anchor <elementId>（各语言注释前缀适配：#、--、//）③ AST 解析校验（TS/JS 用 ts-morph，Python 用 libcst 或降级正则，Java 用 JavaParser 或降级正则）。
3) comment-marker.ts：把 anchor 标记写入生成代码（按文件语言选择注释风格），并解析已有标记。
4) ast-verify.ts：生成后立即校验——anchor 声明的 symbol 与行号在文件中真实存在且类型匹配，不一致标记 syncState='drift_detected' 并记录原因。
5) reassociate.ts：锚点丢失时按元素规范名与代码符号相似度（编辑距离 + 命名投影匹配）给出候选列表，提供"重新关联"一键修复；代码被外部修改导致行号漂移时按 symbol + 注释标记重新定位并更新行号。
6) 测试：声明解析入库、三类反例的 AST 校验失败（虚假 symbol、错误行号、错误 kind）、行号漂移重定位、候选推荐排序。
验收：测试通过；给出一次"生成 → 锚点入库 → 人为改行号 → 重定位成功"的验证记录。
```

---

**Wave 4 出口检查**：选中"登录按钮"加备注"需校验图形验证码"→ 生成后端代码包含该逻辑（E2E-05）；代码视图无法手动编辑，外部改动被检测；锚点写入并可校验。
