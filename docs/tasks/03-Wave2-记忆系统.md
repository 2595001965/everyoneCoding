# Wave 2 — 记忆系统（T2-01 ~ T2-07）

> 目标：五层记忆可写可读可检索；AI 对话中能自动抽取长期记忆；反复 debug 能触发问题记忆；设计器 DSL 可精简为分层逻辑结构。
> 本 Wave 是产品差异化核心，优先于设计器完成（设计器的结构精简会调用 T2-06）。

---

## T2-01 五层记忆领域模型与继承覆盖解析

| 项       | 内容                       |
| -------- | -------------------------- |
| 覆盖需求 | FR-MEM-01 ~ FR-MEM-07      |
| 优先级   | P0                         |
| 前置任务 | T0-07、T0-08               |
| 可并行   | 无（T2-02 / T2-03 依赖它） |

**产出物**

- `packages/memory/src/domain/{memory-item.ts,scope.ts,conflict.ts,inheritance.ts}`
- `packages/memory/src/repo/memory-repo.ts`
- `packages/memory/src/service/{project-memory.ts,page-memory.ts,feature-memory.ts,issue-memory.ts}`
- 单元测试

**实现要点**

1. Scope 枚举：`longterm / project / feature / page / issue`；归属字段按 §6.2（project_id/feature_id/page_id/element_id/issue_id）。
2. 通用字段：标题、正文（Markdown）、结构化 JSON、标签、来源类型与来源引用、重要度 1–5、置信度 0–1、置顶、状态、乐观锁版本、时间。
3. 继承覆盖解析 `resolveContext(scopeRef)`：自动携带全部上层记忆，同名/同键冲突下层优先，**返回冲突溯源信息**（哪一层覆盖了哪一层）供 UI 标注。
4. 状态流转：`active / archived / superseded`；问题记忆额外 `unsolved / solved / mitigated`。

**验收标准**

- [ ] 五层模型 CRUD 通过，乐观锁冲突可测
- [ ] 继承解析对「长期 → 项目 → 功能 → 页面 → 元素备注」全链路正确
- [ ] 同键冲突时下层优先，且返回冲突来源（上层条目 id + 字段名）
- [ ] 状态机非法流转被拒绝（如 solved → unsolved 需显式 API）

**▶ AI 执行提示词**

```
任务 T2-01：实现五层记忆领域模型与继承覆盖解析（packages/memory）。
要求：
1) domain/scope.ts：Scope = 'longterm'|'project'|'feature'|'page'|'issue'，定义层级顺序与归属字段约束（longterm 的 project_id 必须为空，page 必须带 project_id 等，写不变量校验）。
2) domain/memory-item.ts：字段对齐 docs/PRD-EveryoneCoding.md §6.2 memory_item 表（id/user_id/scope/各归属 id/title/content/structured/tags/source_type/source_ref/confidence/importance/status/pinned/version/created_at/updated_at/embedding）；提供 zod schema 与不变量断言。
3) domain/inheritance.ts：resolveContext(ref: {projectId, featureId?, pageId?, elementId?}) → 返回按层级排序的记忆条目 + 冲突记录；冲突判定为"同 title 或同 structured 键"，下层覆盖上层，冲突项输出 {winnerId, loserId, layer, field}。
4) domain/conflict.ts：冲突检测与合并策略（keepLocal / takeNew / merge），merge 时 structured 字段深合并、content 段拼接并保留双方来源引用。
5) service/ 四个工厂：项目记忆（技术选型/模块/路由表/数据模型/全局状态/依赖/部署）、页面记忆（骨架/区块/状态机/事件流/接口依赖）、功能记忆（流程/输入输出/边界/接口清单/错误码/验收）、问题记忆（现象/复现/已尝试/结论/关联代码位置 + 状态流转 unsolved→solved|mitigated）。
6) 单测：层级不变量、继承顺序、冲突溯源、状态机非法流转拒绝、乐观锁冲突。
验收：测试通过；输出一份"长期 + 项目 + 功能 + 页面"四层同时命中同键的冲突解析示例。
```

---

## T2-02 记忆中心 UI

| 项       | 内容                                                 |
| -------- | ---------------------------------------------------- |
| 覆盖需求 | FR-MEM-21；FR-MEM-06（冲突来源标注）；FR-ACC-06 无关 |
| 优先级   | P0                                                   |
| 前置任务 | T2-01、T0-06                                         |
| 可并行   | T2-03                                                |

**产出物**

- `apps/renderer/src/features/memory/{MemoryCenter.tsx,MemoryTree.tsx,MemoryList.tsx,MemoryEditor.tsx,ConflictBadge.tsx,BatchActions.tsx,ChangeLogPanel.tsx}`
- 组件测试

**实现要点**

1. 分层树（长期/项目/功能/页面/问题）+ 标签筛选 + 搜索 + 重要度排序 + 置顶分组。
2. Markdown 编辑与预览双栏；结构化 JSON 提供表单化编辑（骨架、状态、事件、接口依赖）。
3. 冲突条目显示来源徽标「已覆盖：长期记忆 · 命名规范」，点击可展开被覆盖内容。
4. 批量操作：导出 / 删除 / 移动层级；删除走二次确认与回收（可撤销）。
5. 变更日志面板：展示自动写入来源对话片段与时间，点击跳转原始对话（跳转目标先留占位接口）。

**验收标准**

- [ ] 五个层级可在同一棵树中浏览，切换项目正确过滤
- [ ] Markdown 编辑与预览即时同步；结构化字段表单编辑可保存
- [ ] 冲突徽标正确显示并可展开查看被覆盖内容
- [ ] 批量删除有二次确认且可撤销

**▶ AI 执行提示词**

```
任务 T2-02：实现记忆中心 UI（apps/renderer/src/features/memory）。
要求：
1) MemoryTree：分层展示长期/项目/功能/页面/问题五层，支持展开折叠、按标签筛选、搜索（调用 T2-03 检索接口，未完成前先用本地过滤）、重要度排序、置顶分组。
2) MemoryList + MemoryEditor：列表与编辑双栏；编辑支持 Markdown（编辑/预览切换）与结构化 JSON 的表单化编辑（页面记忆的 skeleton/state/events/apiDeps，功能记忆的 flow/apis/errors/edgeCases）。
3) ConflictBadge：当条目被下层覆盖或覆盖了上层时显示徽标「已覆盖：<层级>·<标题>」，点击展开被覆盖内容与差异。
4) BatchActions：批量导出（JSON/Markdown）、批量删除（二次确认 + 可撤销）、批量移动层级（带冲突提示）。
5) ChangeLogPanel：展示自动写入的变更日志（来源对话片段 + 时间），点击跳转原始对话（先留 onJumpToConversation 回调占位）。
6) 用 @ec/ui 组件，不引外部 UI 框架；所有删除类操作二次确认。
7) 组件测试（Testing Library）：树渲染、编辑保存、冲突徽标展开、批量删除确认与撤销。
验收：测试通过；手工确认五层数据均可浏览与编辑。
```

---

## T2-03 双路召回检索（FTS5 + 向量 + RRF）

| 项       | 内容                                  |
| -------- | ------------------------------------- |
| 覆盖需求 | FR-MEM-20；NFR-P-03（1000 条 ≤200ms） |
| 优先级   | P1                                    |
| 前置任务 | T2-01、T0-07                          |
| 可并行   | T2-02                                 |

**产出物**

- `packages/memory/src/search/{fts-search.ts,vector-search.ts,hybrid.ts,rrf.ts,embedder.ts}`
- `packages/memory/src/search/__tests__/*`（含性能基准）

**实现要点**

1. FTS5 关键词检索（中文需分词预处理：二元切分或简单词典），返回 bm25 分数。
2. 向量检索走 sqlite-vec；embedding 通过 AI 网关的 embedding 用途（若用户未配置则**优雅降级为纯关键词检索**并提示）。
3. RRF 融合：`score = Σ 1/(k + rank_i)`，k 默认 60；支持权重调整。
4. 检索范围可按 scope / 项目 / 标签过滤；结果返回高亮片段与命中来源（关键词 or 语义）。

**验收标准**

- [ ] 1000 条记忆下双路召回端到端 ≤ 200ms（附基准数据）
- [ ] sqlite-vec 或 embedding 不可用时自动降级为关键词检索，不报错、不阻塞
- [ ] RRF 融合排序稳定，同一查询多次结果一致
- [ ] 结果带高亮片段与命中来源标注

**▶ AI 执行提示词**

```
任务 T2-03：实现双路召回检索（packages/memory/src/search）。
要求：
1) fts-search.ts：基于 FTS5 虚表做关键词检索，中文需预处理（实现简单的二元切分 bigram 作为兜底，允许后续替换更好分词）；返回 id 列表与 bm25 分数、高亮片段。
2) embedder.ts：通过 packages/ai 网关的 embedding 用途生成向量；Provider 不支持 embedding 或未配置时返回 unavailable 标记，上层据此降级，绝不抛错阻塞。
3) vector-search.ts：基于 sqlite-vec 做近邻检索（cosine），返回 id 列表与距离；扩展不可用时返回 unavailable。
4) hybrid.ts + rrf.ts：RRF 融合 score = Σ w_i/(k + rank_i)，k=60，权重可配；支持 scope/项目/标签过滤；结果返回 {id, score, matchedBy: 'keyword'|'semantic'|'both', snippet}。
5) 性能：1000 条样本数据下端到端 ≤ 200ms，编写 benchmark 脚本输出实测数据（冷/热各一次）。
6) 单测：中文分词查询、降级路径（vec 不可用、embedding 不可用）、RRF 稳定性、过滤条件生效。
验收：测试通过；benchmark 输出 ≤200ms 的实测数据；降级路径下检索仍可用。
```

---

## T2-04 长期记忆自动抽取与写入策略

| 项       | 内容                  |
| -------- | --------------------- |
| 覆盖需求 | FR-MEM-08 ~ FR-MEM-12 |
| 优先级   | P0                    |
| 前置任务 | T2-01、T1-05          |
| 可并行   | 无                    |

**产出物**

- `packages/memory/src/auto/{extractor.ts,signal-strength.ts,write-policy.ts,conflict-card-source.ts,change-log.ts}`
- `apps/renderer/src/features/memory/{AutoWriteToast.tsx,ConflictCard.tsx}`
- 单元测试与集成测试

**实现要点**

1. 抽取由**一次轻量模型调用**在后台异步完成，不阻塞主对话；失败静默重试 1 次后丢弃。
2. 识别类别：技术栈、命名规范、目录结构、UI 风格、语言、禁止/强制事项、交付习惯。
3. 信号强度：同一偏好出现 ≥2 次，或含明确指令词（"以后都…""不要…""统一用…"）→ 提升置信度；分三档 低 <0.5 / 中 0.5–0.8 / 高 >0.8。
4. 写入策略三档：① 静默自动写（仅高置信）② 自动写入 + Toast 可撤销（**默认**）③ 仅建议需确认；设置页可全局切换。
5. 冲突处理：新记忆与已有冲突时弹对比卡（采用新 / 保留旧 / 合并）；长期记忆上限 500 条触发归档提示。
6. 变更日志：记录来源对话片段与时间，可跳转原始对话。

**验收标准**

- [ ] 主对话不受抽取影响（抽取耗时不计入主流程响应）
- [ ] 含"以后都…"的语句被识别且置信度 ≥0.8
- [ ] 默认策略下自动写入并出现可撤销 Toast，撤销后条目消失
- [ ] 冲突卡片三选项行为正确；合并结果保留双方来源引用
- [ ] 抽取模型调用失败重试 1 次后静默丢弃，主流程无感

**▶ AI 执行提示词**

```
任务 T2-04：实现长期记忆自动抽取与写入策略（packages/memory/src/auto + 渲染层交互）。
要求：
1) extractor.ts：在一次用户-AI 交互结束后，异步发起一次**轻量模型**调用（通过 packages/ai 网关的 memory-extract 用途），从对话/需求变更/纠正反馈/设计修改中抽取稳定偏好信号；识别类别覆盖技术栈、命名规范、目录结构、UI 风格、语言、禁止/强制事项、交付习惯；输出结构化候选 {title, content, category, signalCount, hasImperative}。
2) 不阻塞主对话：抽取与主流程解耦（事件驱动 + 队列），失败静默重试 1 次后丢弃并记录 warn 日志，绝不向用户报错。
3) signal-strength.ts：同一偏好出现 ≥2 次或含明确指令词（"以后都""不要""统一用""禁止""必须"）时提升置信度；输出三档 低<0.5 / 中0.5-0.8 / 高>0.8。
4) write-policy.ts：三档策略 ① 静默自动写（仅高置信）② 自动写入 + Toast 通知可撤销（默认）③ 仅建议需用户确认；策略从设置读取，可全局切换；撤销后条目进入 archived 且可恢复。
5) 冲突处理：与已有长期记忆同 title/同义时生成 ConflictCard（采用新 / 保留旧 / 合并），合并走 T2-01 的 conflict.merge；长期记忆总量上限默认 500 条，触达时提示归档。
6) change-log.ts：每次自动写入记录来源对话 id、片段、时间与策略档位；UI 可跳转原始对话（回调占位）。
7) 渲染层：AutoWriteToast（含"撤销"按钮，5s 后自动消失）与 ConflictCard 组件。
8) 测试：抽取不阻塞主流程（断言主流程耗时不受影响）、指令词识别、三档策略行为、撤销、冲突三选项、失败静默重试。
验收：测试通过；手工验证一次"以后都用 TypeScript"能自动生成高置信长期记忆并出现在记忆中心。
```

---

## T2-05 Debug 循环检测与问题记忆

| 项       | 内容                          |
| -------- | ----------------------------- |
| 覆盖需求 | FR-MEM-13 ~ FR-MEM-16；E2E-09 |
| 优先级   | P0                            |
| 前置任务 | T2-01、T0-09                  |
| 可并行   | 无                            |

**产出物**

- `packages/memory/src/debug-loop/{detector.ts,window-queue.ts,prompt-card-source.ts,draft-builder.ts}`
- `apps/renderer/src/features/memory/{IssuePromptCard.tsx,IssueMemoryDraft.tsx}`
- 单元测试

**实现要点**

1. 滚动窗口（默认 10 分钟）事件队列：生成 / 运行 / 报错 / 用户否定反馈。
2. 命中阈值：窗口内 ≥3 次「生成—运行—报错/不满意」循环，或同一错误连续 ≥2 次；**全部本地检测**，无服务端。
3. 非模态提示卡：「检测到正在反复调试「XX」，是否建立专门的问题记忆？」+【立即建立】【稍后】【不再提示此项】；不得打断输入焦点；"稍后"后 30 分钟内不再提示。
4. 一键建立：自动汇总错误信息、尝试过的方案、相关代码片段与 commit，生成草稿并关联页面/元素/功能。
5. 建立后自动进入该上下文，记忆中心以「进行中问题」高亮；解决后提示标记已解决并沉淀结论。

**验收标准**

- [ ] E2E-09：连续 3 次生成同一元素报错 → 提示卡出现 → 一键建立成功
- [ ] 提示卡非模态，不夺焦点；"稍后"30 分钟静默；"不再提示"对当前项持久生效
- [ ] 草稿自动带错误信息、尝试方案、关联页面/元素/commit
- [ ] 建立后该问题记忆进入后续 AI 上下文（与 T4-02 联调时验证）

**▶ AI 执行提示词**

```
任务 T2-05：实现 Debug 循环检测与问题记忆（packages/memory/src/debug-loop + 渲染层）。
要求：
1) window-queue.ts：维护滚动时间窗（默认 10min，可配）的事件队列，事件类型 generate / run / error / negative-feedback，带 target（pageId/elementId/featureId）与 errorSignature（错误信息归一化后的指纹）。
2) detector.ts：本地检测（无任何服务端调用），命中条件为窗口内同一 target ≥3 次「生成-运行-报错/不满意」循环，或同一 errorSignature 连续 ≥2 次；输出 DetectionResult{target, cycles, errorSignatures, suggestedTitle}。
3) prompt-card-source.ts：触发后发事件，UI 展示**非模态**提示卡（不夺焦点、可关闭）：「检测到正在反复调试「XX」，是否建立专门的问题记忆？」+【立即建立】【稍后】【不再提示此项】；稍后 = 30 分钟内不再提示；不再提示 = 对该 target 持久化忽略（存设置）。
4) draft-builder.ts：确认后自动汇总错误信息、尝试过的方案（来自对话）、相关代码片段、最近 commit sha，生成问题记忆草稿（scope=issue，状态 unsolved），并关联 page/element/feature 与 Git commit。
5) 问题记忆建立后：在记忆中心以「进行中问题」高亮；提供标记 solved / mitigated 的入口，标记 solved 时提示"沉淀结论到长期/项目记忆"（可选归档）。
6) 渲染层组件 IssuePromptCard、IssueMemoryDraft（草稿可编辑后保存）。
7) 单测：窗口过期、阈值命中与未命中、稍后静默期、忽略持久化、草稿字段完整性（含 commit 与关联）。
验收：测试通过；E2E-09（连续 3 次生成同一元素报错触发提示卡并可一键建立）手工走通。
```

---

## T2-06 结构精简器（Structure Condenser）与分层沉淀

| 项       | 内容                                       |
| -------- | ------------------------------------------ |
| 覆盖需求 | FR-MEM-17 ~ FR-MEM-19；FR-DSG-12           |
| 优先级   | P0                                         |
| 前置任务 | T2-01（可先做纯 DSL 侧，设计器完成后联调） |
| 可并行   | 无                                         |

**产出物**

- `packages/memory/src/condenser/{condenser.ts,rules.ts,diff.ts,layer-dispatch.ts,token-estimator.ts}`
- `packages/memory/src/condenser/__tests__/*`（含保真度抽样测试）
- `apps/renderer/src/features/designer/StructurePreview.tsx`（摘要预览与手动编辑）

**实现要点**

1. 输入 PageDSL（结构见 PRD §M3），输出逻辑结构摘要：组件树（去样式）、状态、事件流、数据流、接口依赖。
2. 分层归档：页面级（骨架/区块/状态/事件）→ 页面记忆；项目级（模块/路由总表/全局数据模型）→ 项目记忆；功能级（流程/接口/规则）→ 功能记忆；层级归属由 `featureRef` 与页面归属自动推导，支持手动调整。
3. 增量更新：设计稿修改后仅重算受影响子树，保留变更 diff，页面记忆可查看最近 5 次结构变更。
4. 保真度：单页面摘要 ≤ 2k tokens；保留组件类型、层级、绑定字段、事件目标、接口依赖，去纯样式细节；抽查 AI 仅凭摘要能复现 ≥90% 结构。
5. 预览 UI：可查看、可手动编辑、显示 token 估算。

**验收标准**

- [ ] 单页面摘要 ≤ 2k tokens（用 20 元素登录页实测并附数据）
- [ ] 分层归属自动推导正确，手动调整后覆盖
- [ ] 修改单个元素后仅重算该子树，diff 仅含该子树变更
- [ ] 保真度抽样：把摘要喂给模型复现结构，与原始结构对比 ≥90% 匹配（写脚本评估）

**▶ AI 执行提示词**

```
任务 T2-06：实现结构精简器 Structure Condenser 与分层沉淀（packages/memory/src/condenser）。
要求：
1) 输入 PageDSL（字段见 docs/PRD-EveryoneCoding.md M3 的 PageDSL / ElementNode 定义），输出逻辑结构摘要 JSON：{skeleton, blocks, state, events, dataFlow, apiDeps}；去除纯样式与装饰属性，保留组件类型、层级关系、绑定字段、事件目标、接口依赖。
2) rules.ts：精简规则可配置（保留字段清单、样式剥离白名单、深度上限、文本截断长度）。
3) layer-dispatch.ts：按层级归档——页面一级（骨架/区块/状态/事件）→ 页面记忆；项目一级（模块划分/路由总表/全局数据模型）→ 项目记忆；功能一级（流程/接口/规则）→ 功能记忆；层级归属由元素的 featureRef 与页面归属自动推导，支持手动覆盖（存 layerOverride）。
4) diff.ts：增量更新——比较新旧 DSL 定位变更子树，仅重算受影响子树，产出结构化 diff；页面记忆保留最近 5 次结构变更记录。
5) token-estimator.ts：摘要 token 估算，单页面目标 ≤ 2k tokens，超限时按优先级进一步裁剪并标记 truncated。
6) StructurePreview 组件：摘要可预览、可手动编辑、显示 token 估算与最近变更。
7) 测试：20 元素登录页实测 token ≤2k；改一个元素后 diff 只含该子树；分层归属推导与手动覆盖；保真度评估脚本（把摘要交给模型复现结构，与原始结构比对，输出匹配率，目标 ≥90%）。
验收：测试通过；附 token 实测数据与保真度匹配率报告。
```

---

## T2-07 记忆导入导出（JSON / Markdown）

| 项       | 内容                       |
| -------- | -------------------------- |
| 覆盖需求 | FR-MEM-22                  |
| 优先级   | P2                         |
| 前置任务 | T2-01                      |
| 可并行   | 与 Wave 2 其他任务均可并行 |

**产出物**

- `packages/memory/src/io/{export-json.ts,export-markdown.ts,import.ts,merge-preview.ts}`
- UI：记忆中心「导入 / 导出」入口与冲突合并预览

**实现要点**

1. 导出：JSON（全字段）与 Markdown（按层级分文件、保留 front-matter 元信息）两种格式。
2. 导入：解析后与本地按 `id + updatedAt` 比对，产出差异预览（新增 / 冲突 / 无变化 / 缺失）。
3. 冲突逐条决策：保留本地 / 采用导入 / 两者都保留（后者生成新 id）。
4. 与 M14 `.ecpkg` 共用冲突合并逻辑（把 merge 能力下沉，供 T8-03 复用）。

**验收标准**

- [ ] 导出 JSON 可无损重新导入
- [ ] Markdown 导出保留标题层级、标签、来源引用
- [ ] 导入冲突预览四类差异齐全，默认不覆盖
- [ ] 合并逻辑可被 T8-03 直接复用（导出为独立函数）

**▶ AI 执行提示词**

```
任务 T2-07：实现记忆导入导出（packages/memory/src/io）。
要求：
1) export-json.ts：导出全字段 JSON（含 structured、tags、source_ref、confidence、importance），可导出为 JSONL 便于大批量。
2) export-markdown.ts：按层级分文件导出，每个条目一个 .md，front-matter 保留 id/scope/tags/importance/confidence/source/updatedAt，正文为 Markdown 内容，structured 以折叠 JSON 块附在文末。
3) import.ts：解析 JSON/JSONL/Markdown，按 id + updatedAt 与本地比对，产出差异预览 {added, conflicted, unchanged, missing}。
4) merge-preview.ts：冲突解决器，逐条决策 keepLocal / takeImported / keepBoth（keepBoth 时生成新 id 并保留双方），支持按类型批量决策；**把该函数设计为可复用**，后续 T8-03 .ecpkg 导入直接调用。
5) UI：记忆中心「导入 / 导出」入口，展示冲突合并预览弹窗。
6) 测试：JSON 往返无损、Markdown front-matter 解析、四类差异分类、keepBoth 生成新 id、批量决策。
验收：测试通过；导出的 JSON 重新导入后条目数一致。
```

---

**Wave 2 出口检查**：五层记忆可增删改查与检索；对 AI 说"以后都用 TypeScript"会自动生成长期记忆并可撤销；连续 3 次生成报错能触发问题记忆；设计器 DSL 可精简为 ≤2k tokens 的分层摘要。
