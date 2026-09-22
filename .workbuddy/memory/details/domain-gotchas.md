# 领域口径踩坑记录（表结构 / 枚举 / 快照 / 附件 / 检测）

> 索引见 `../MEMORY.md §领域口径`。本文件是被移出 MEMORY.md 的细节。

- **`ArtifactStore` 产物平坦布局 + 阶段前缀**：`<projectId>/pipeline/s1-<前缀>-v<n>.md`，无阶段子目录。
- **pipeline 合法序列**：`startStage → submitForReview → confirm`（`confirm` 不接受 `running`）；
  `advance(from,to)` 要求 `from` 已 confirmed 且相邻。同步/异步口都能分发到同一实现
  （异步 router 会回落到 syncHandlers），但 `syncRouter` 拒绝异步方法。
- **`designer.createPage` 必须用 `@ec/designer/dsl` 的 `createEmptyPage`**：漏
  `projectId`/`viewport`/`apiDeps`/`notes`/`anchors` 或 `state` 写成 `states` 时，文件落盘成功、
  `listPages` 也列得出，但渲染层 zod 校验必失败 ⇒ 新建项目打开设计器直接报错。
  合法性唯一判据是 `deserializePageDsl(JSON.stringify(envelope))`。`condensePage(dsl)` 收 PageDsl 本体。
- **`element`/`feature` 行必须登记**：`code_anchor.element_id`、`memory_item.feature_id` 是外键，
  缺行只在特定数据形状下报 `FOREIGN KEY constraint failed`。
- **`memory_item` 必填列**：`user_id`/`scope`/`title`/`content`/`source_type`/`created_at`/`updated_at`
  全 NOT NULL（直写 SQL 最易漏 `source_type`）。`id` 不能只用时间戳（同毫秒撞唯一约束）。
- **`note` 表两套枚举禁止互转**：`note_type`（六类）vs `note.kind`（design|note|comment）；
  正文存 `content`，富文本/清单/代码/历史进 `payload_json`。领域规则只在 `@ec/designer/notes`。
- **外部改动检测不采信 `fs.watch` 的 filename**（Windows 常报目录名且重复上报）：事件只当触发器 +
  250ms 合并 + 「路径→size/mtime」索引比对；自身写入在**写入前**抑制（含 `.ec-tmp` 临时路径）。
- **上下文"空块不伪装"**：每块 `content` 非空 ⟺ `items` 非空；空项目组装时只有 `instruction` 有内容，
  其余块必须带 `skipped`。`ContextPanel`/`CodeView` 的生产挂载页是 `/code`（`pages/CodePage.tsx`）。
- **代码写入只有一条路**：`WritePipeline` 的 `plan → preview → apply`；`requestRework` 返回 `void`，
  计划走**已登记**的域事件 `code:write-plan`。
- **`setting` 表真实列是 `value_json`/`value_text`，`user_id` NOT NULL**（迁移 0001，**没有 `value` 列**）。
  一律走 `domain/setting-store.ts` 的 `createSettingStore`。直写 `SELECT value FROM setting` 会在用户
  真点按钮时才炸 `no such column: value`。`UNIQUE(user_id, key)` 下 upsert 不能用 key 单独做冲突目标。
- **预算必须两端共用一份落点**：面板写 `setting.usage_budget`，AI 栈经 `readPersistedBudget` 注入
  `BudgetGuard`（`ai/runtime.ts`），且 `usage.setBudget` 要经 `onBudgetChanged` **即时回灌运行中的网关**。
  只写库不回灌 ⇒ 改了预算要等重启才生效。
- **遥测清除必须三层**：内存队列 + 文件缓冲（`telemetry-buffer.json`）+ 数据库记录。事件一律经
  `buildEvent()`（内含白名单断言），夹带提示词/代码/Key 会**抛错**而非静默上传。
  生产调用点统一走 `domain/telemetry-runtime.ts`（默认关闭）。
- **附件内容寻址**：`<projectDir>/attachments/<sha256>.<ext>`（平坦）。导入时按"哪个项目的文档
  `content_ref` 引用了该文件名"定位归属；无法判定落 `__attachments__` 暂存，**绝不丢内容**。
- **备份快照命名规范**：`ec-backup-<yyyymmdd-hhmmss>-<ms>-<scheduled|manual|pre-restore>.ecpkg`；
  `pruneSnapshots` 只删匹配该规范的文件。回滚顺序固定：先 `pre-restore` 快照再全量导入。
  调度在客户端内（`BackupScheduler` + 启动补偿），**不依赖系统任务计划程序**。
- **快照域名不能直接当文件名**：领域名是自由字符串（`pipeline:<projectId>`），Windows 上 `:` 是
  NTFS 备用数据流 —— 写/读/exists 全"成功"但 `readdir` 永远列不出 ⇒ 脏快照检测静默失效、
  Windows 上崩溃恢复整体失灵（POSIX 复现不出）。`CrashRecovery.snapshotPath` 已替换非
  `[A-Za-z0-9._-]` 为 `_`；逻辑域名仍存信封 `domain`。
- **篡改检出测试要精确落在 ZIP 压缩数据区**：`.ecpkg` 是 ZIP(DEFLATE)，按局部文件头 `PK\x03\x04`
  解析 `nameLen(26)/extraLen(28)/compSize(18)` 得 `dataStart`，在 `dataStart` 翻字节。
  翻"文件中段"或固定小偏移会落进中央目录/局部头被忽略 ⇒ **假阴性**。
- **测试 `afterAll` 清理要容错**：Windows 上 SQLite 句柄回收有延迟，`rmSync` 会 EPERM；
  先 `runtime.dispose()` 再 try/catch（`domain-workspace-git.test.ts` 的 `cleanupTempDir` 即此）。
