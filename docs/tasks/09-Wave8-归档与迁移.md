# Wave 8 — 归档与迁移 `.ecpkg`（T8-01 ~ T8-04）

> 目标：一键导出 / 导入包含全部记忆、文档、项目代码与注册表的自定义归档包，跨设备手动迁移（D-02 / D-05 / D-09：无云存储、无分享链接）。
> 依赖：Wave 2（记忆）、Wave 3（设计 DSL）、Wave 7（registry.json）。

---

## T8-01 `.ecpkg` 包格式、manifest 与版本兼容

| 项       | 内容                                         |
| -------- | -------------------------------------------- |
| 覆盖需求 | FR-PKG-03；FR-PKG-04；NFR-C-04；§14.1；§13.4 |
| 优先级   | P0                                           |
| 前置任务 | T0-08、T0-11                                 |
| 可并行   | 无（T8-02 / T8-03 依赖）                     |

**产出物**

- `packages/package-kit/src/{format/{manifest.ts,layout.ts,version.ts,checksum.ts,signature.ts},reader.ts,writer.ts}`
- 测试（含跨版本兼容矩阵）

**实现要点**

1. 目录结构严格按 PRD §14.1：ZIP 容器（DEFLATE，扩展名 `.ecpkg`），含 `manifest.json`、`signature.sig`（可选）、`memory/`（longterm.jsonl、projects/<id>/project.jsonl、links.json）、`documents/`（index.json + 原始文件）、`projects/<id>/`（meta.json、design/pages、design/components、anchors.json、pipeline/、registry.json、code/）、`attachments/`（内容寻址去重）。
2. `manifest.json` 字段严格按 §14.1 表格：formatVersion、generator、exportedAt、scope、includes/excludes、counts、checksums、encryption、redacted、signature。
3. 完整性校验：逐文件 SHA-256，导入前全量校验，损坏时指出具体文件；可选 Ed25519 签名校验。
4. 版本兼容：`formatVersion` 语义化；低版本客户端遇高版本包提示"需升级"而非静默失败；兼容矩阵覆盖近 3 个格式版本。

**验收标准**

- [ ] 包结构与 manifest 字段与 PRD §14.1 / §13.4 完全一致（结构断言测试）
- [ ] 逐文件 SHA-256 校验可检出人为篡改并指出具体文件
- [ ] 高版本包在低版本客户端上提示"需升级"，不静默失败
- [ ] Ed25519 签名可生成与校验（未配置公钥时跳过）

**▶ AI 执行提示词**

```
任务 T8-01：实现 .ecpkg 包格式、manifest 与版本兼容（packages/package-kit）。
要求：
1) layout.ts：严格实现 docs/PRD-EveryoneCoding.md §14.1 的目录结构（manifest.json、signature.sig、memory/longterm.jsonl、memory/projects/<id>/{project.jsonl,links.json}、documents/{index.json,<docId>/原文件}、projects/<id>/{meta.json,design/pages/*.dsl.json,design/components/*.json,anchors.json,pipeline/,registry.json,code/}、attachments/）。
2) manifest.ts：字段对齐 §14.1 表格与 §13.4 示例——formatVersion(语义化)、generator{app,version,platform}、exportedAt、scope(all|project|selected)、includes[]/excludes[]、counts{projects,memoryItems,documents,pages,codeFiles}、checksums{algorithm,entries}、encryption{none|aes-256-gcm,kdf,iterations}、redacted、signature；zod schema 校验。
3) 容器：ZIP + DEFLATE，扩展名 .ecpkg；**流式读写**（绝不整包入内存），支持 1 万文件工程。
4) checksum.ts：逐文件 SHA-256，导入前全量校验；损坏时列出具体文件清单。
5) signature.ts：可选 Ed25519 签名（用户提供私钥时签名，提供公钥时校验；未配置则跳过）。
6) version.ts：语义化 formatVersion 与兼容策略——高版本包在低版本客户端明确提示"需升级"并给出最低所需版本，禁止静默失败；编写近 3 个版本的兼容矩阵测试。
7) 测试：结构断言、manifest 往返、篡改检出、签名生成与校验、三种版本兼容场景、1 万文件流式读写不爆内存。
验收：测试通过；输出一份真实 manifest 样例。
```

---

## T8-02 导出流水线（范围选择 / 排除 / 脱敏 / 加密）

| 项       | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 覆盖需求 | FR-PKG-01/02/05/06/07/12；NFR-P-08（导出 ≤60s）；E2E-13 部分 |
| 优先级   | P0                                                           |
| 前置任务 | T8-01、T0-11                                                 |
| 可并行   | T8-03                                                        |

**产出物**

- `packages/package-kit/src/export/{export-job.ts,scope-selector.ts,exclude-rules.ts,redactor.ts,encryptor.ts,progress.ts}`
- `apps/renderer/src/features/package/{ExportWizard.tsx,ScopeSelector.tsx,ExportProgress.tsx}`
- 测试

**实现要点**

1. 全量 / 单项目 / 自定义勾选（记忆层级、文档、代码、流水线产物、锚点、附件）；勾选状态可保存为"导出方案"供复用。
2. 排除规则：默认排除 `node_modules` / `dist` / `target` / `.git` / 构建缓存，支持项目级 `.ecignore` 自定义；默认规则下包体积较工程目录下降 ≥60%。
3. 脱敏：API Key、Token、密码、数据库连接串默认剔除或占位；导出包全文检索不得出现明文密钥；可显式关闭脱敏（需二次确认）。
4. 加密：口令 + AES-256-GCM（PBKDF2 派生，迭代 210000），口令不写入包内；口令错误时明确提示，不产生半解密数据。
5. 可视化：实时进度、对象计数、错误清单与重试；1 万文件导出 ≤60s。

**验收标准**

- [ ] 三种范围导出均可用，导出方案可保存复用
- [ ] 默认排除规则下体积下降 ≥60%（给出实测数据）
- [ ] 脱敏后包内全文检索无明文密钥（脚本验证）
- [ ] 加密导出可用，错误口令明确提示且不产生半解密数据
- [ ] 1 万文件导出 ≤60s；中断可重试，失败有清单

**▶ AI 执行提示词**

```
任务 T8-02：实现 .ecpkg 导出流水线（packages/package-kit/src/export + 渲染层）。
要求：
1) scope-selector.ts + ExportWizard：范围 全部 / 单项目 / 自定义勾选（记忆层级、文档、代码、流水线产物、锚点、附件）；勾选状态可保存为命名"导出方案"并复用。
2) exclude-rules.ts：默认排除 node_modules、dist、target、.git、构建缓存（*.log 等），支持项目级 .ecignore（gitignore 语法）；输出排除统计（排除文件数与体积），目标：默认规则下包体积较工程目录下降 ≥60%，给出实测数据。
3) redactor.ts：默认剔除或占位 API Key、Token、密码、数据库连接串（复用 packages/core 的 redaction 规则并扩展到包内文件扫描）；导出后做一次自检——遍历包内文本检索常见密钥模式，命中即告警；可在设置中显式关闭脱敏但需二次确认。
4) encryptor.ts：口令 + AES-256-GCM（PBKDF2-SHA256，迭代 210000），口令绝不写入包内；解密口令错误时明确提示且不产生半解密数据（先校验认证标签再落盘）。
5) progress.ts + ExportProgress：实时进度（阶段 + 已处理/总数 + 当前文件）、对象计数、错误清单与重试按钮；全部 UI 操作，无命令行（FR-PKG-12）。
6) 性能：1 万文件工程导出 ≤60s，流式读写不整包入内存，输出实测数据。
7) 测试：三种范围、排除规则与体积下降率、脱敏自检、加密往返与错误口令、进度事件、1 万文件性能与中断重试。
验收：测试通过；输出实测体积与耗时数据；包内密钥自检零命中。
```

---

## T8-03 导入流水线（校验 / 五种模式 / 冲突合并）

| 项       | 内容                               |
| -------- | ---------------------------------- |
| 覆盖需求 | FR-PKG-04/08/09/12；E2E-13；E2E-14 |
| 优先级   | P0                                 |
| 前置任务 | T8-01                              |
| 可并行   | T8-02                              |

**产出物**

- `packages/package-kit/src/import/{import-job.ts,verifier.ts,mode-selector.ts,conflict-resolver.ts}`
- `apps/renderer/src/features/package/{ImportWizard.tsx,ConflictResolver.tsx,ImportReport.tsx}`
- 测试

**实现要点**

1. 导入前：格式版本校验 → 完整性校验（逐文件 SHA-256）→ 可选签名校验 → 解密（如加密）→ 差异预览。
2. 五种导入模式：① 完整恢复 ② 合并（按 id + `updatedAt` 解决冲突）③ 仅记忆 ④ 仅文档 ⑤ 仅代码。
3. 冲突解决 UI：逐条可选「保留本地 / 采用包内 / 两者都保留」，支持按类型批量决策；**冲突条目默认不自动覆盖，必须用户决策**。
4. 导入报告：新增 / 冲突 / 无变化 / 缺失四类统计，可导出报告。
5. 复用 T2-07 的合并能力（避免重复实现）。

**验收标准**

- [ ] E2E-13：干净环境导入后项目可打开、可预览、可继续生成，且包内无明文密钥
- [ ] E2E-14：冲突项全部列出且默认不覆盖，逐条决策后结果符合预期
- [ ] 五种模式行为正确（各一个集成测试）
- [ ] 校验失败（篡改/版本过高/口令错）给出明确原因，不产生半导入状态

**▶ AI 执行提示词**

```
任务 T8-03：实现 .ecpkg 导入流水线（packages/package-kit/src/import + 渲染层）。
要求：
1) verifier.ts：导入前依次做 格式版本校验（过高提示需升级）→ 逐文件 SHA-256 完整性校验（损坏列出具体文件）→ 可选 Ed25519 签名校验 → 解密（如加密，先校验认证标签）；任一步失败给出明确原因并中止，**绝不产生半导入状态**。
2) mode-selector.ts：五种模式——完整恢复（覆盖同名项目）/ 合并（按对象 id + updatedAt 解决冲突）/ 仅记忆 / 仅文档 / 仅代码；每种模式给出影响预览（将新增/覆盖/跳过多少对象）。
3) conflict-resolver.ts：**复用 packages/memory/src/io/merge-preview.ts 的合并能力**（T2-07），扩展到文档、设计 DSL、注册表对象；输出四类差异 {added, conflicted, unchanged, missing}。
4) ConflictResolver.tsx：逐条决策「保留本地 / 采用包内 / 两者都保留」（后者生成新 id），支持按对象类型批量决策；**冲突条目默认不自动覆盖，必须用户决策**（E2E-14）。
5) ImportReport：导入后展示四类统计与失败清单（可导出报告），提供"重试失败项"。
6) 全流程 UI 操作、实时进度、无命令行（FR-PKG-12）。
7) 测试：五种模式各一个集成测试、篡改检出、版本过高提示、口令错误、冲突默认不覆盖、批量决策、报告统计。
验收：测试通过；E2E-13 与 E2E-14 手工走通（含干净环境验证）。
```

---

## T8-04 导入自愈、增量与定时备份

| 项       | 内容                             |
| -------- | -------------------------------- |
| 覆盖需求 | FR-PKG-10；FR-PKG-11；FR-PKG-13  |
| 优先级   | P1（自愈）/ P2（增量、定时备份） |
| 前置任务 | T8-03                            |
| 可并行   | 无                               |

**产出物**

- `packages/package-kit/src/{healing/{anchor-relocator.ts,link-fixer.ts,attachment-checker.ts,healing-report.ts},incremental.ts,backup/{scheduler.ts,snapshot-manager.ts}}`
- `apps/renderer/src/features/package/{HealingReport.tsx,BackupSettings.tsx}`
- 测试

**实现要点**

1. 导入后自愈：重定位代码锚点（路径/行号变化，按 symbol + 注释标记重定位，成功率 ≥90%）、修复文档与记忆的失效链接、列出缺失附件；自愈报告可导出。
2. 增量导出/导入：基于 `updatedAt` 游标，仅导出变更对象；增量包体积与变更量成正比。
3. 定时本地备份：按日/周生成 `.ecpkg` 快照到指定目录，支持保留份数与自动清理；可通过备份快照一键回滚工作区。
4. 定时备份走客户端内调度（不依赖系统任务计划程序，避免权限与黑名单问题）。

**验收标准**

- [ ] 锚点重定位成功率 ≥90%（构造 20 个漂移锚点统计）
- [ ] 失效链接修复与缺失附件清单正确
- [ ] 增量包体积与变更量成正比（对比全量包体积）
- [ ] 定时备份可按日/周生成、保留份数生效、过期自动清理、可从快照一键回滚

**▶ AI 执行提示词**

```
任务 T8-04：实现导入自愈、增量导出与定时本地备份（packages/package-kit）。
要求：
1) healing/anchor-relocator.ts：导入后重定位 Code Anchor（路径或行号已变化时使用 symbol + // @everyonecoding:anchor 注释标记重新定位，复用 packages/ai/src/anchors/reassociate 的能力），目标成功率 ≥90%，构造 20 个漂移锚点做统计。
2) healing/link-fixer.ts：修复文档与记忆之间的失效链接（目标 id 变化时按名称+内容相似度重建），无法修复的列入报告。
3) healing/attachment-checker.ts：列出缺失附件（按内容寻址哈希校验），提供"从本地其他位置补齐"入口。
4) healing-report.ts + HealingReport.tsx：自愈报告可查看与导出（含成功/失败/跳过三类与建议操作）。
5) incremental.ts：基于 updatedAt 游标的增量导出/导入，仅处理上次游标之后变更的对象；对比全量包给出体积对比数据。
6) backup/scheduler.ts + snapshot-manager.ts：按日/周生成 .ecpkg 快照到用户指定目录，支持保留份数与自动清理（超出份数删除最旧）；支持从快照一键回滚工作区（回滚前自动备份当前状态）；调度在客户端内实现（定时器 + 启动时补偿执行），**不依赖系统任务计划程序**。
7) 测试：20 个漂移锚点重定位成功率、失效链接修复、缺失附件清单、增量体积对比、定时备份生成与清理、快照回滚。
验收：测试通过；输出锚点重定位成功率与增量体积对比数据。
```

---

**Wave 8 出口检查**：E2E-13（全量导出→干净环境导入→项目可用、锚点重定位 ≥90%、包内无明文密钥）与 E2E-14（冲突默认不覆盖、逐条决策）通过。
