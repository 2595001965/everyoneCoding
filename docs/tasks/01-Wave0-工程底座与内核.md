# Wave 0 — 工程底座与内核（T0-01 ~ T0-11）

> ⚠️ **许可口径已于 2026-09-17 变更**：本项目现采用 **Apache License 2.0**，根目录已提供
> `LICENSE` 与 `NOTICE`。本篇为 Wave 0 的历史任务卡，文中「闭源 / 不写 LICENSE」等表述
> 系当时口径，已被 `docs/tasks/00-通用上下文与执行约定.md` 的现行约定取代，**请勿据此执行**。
> 为保留执行记录，正文未作改写。

> 目标：双形态客户端能启动空壳、SQLite 迁移可执行、UI 组件库可用、崩溃可恢复。
> 本 Wave 是全部后续工作的地基，**必须先全部完成再进入 Wave 1**。

---

## T0-01 单体仓库与工程初始化

| 项       | 内容                    |
| -------- | ----------------------- |
| 覆盖需求 | §3.2 技术选型；NFR-M-01 |
| 优先级   | P0                      |
| 前置任务 | 无                      |
| 可并行   | 无（后续全部依赖它）    |

**产出物**

- 根目录：`pnpm-workspace.yaml`、`package.json`、`tsconfig.base.json`、`.eslintrc.cjs`、`.prettierrc`、`.editorconfig`、`.gitignore`、`vitest.config.ts`、`.github/workflows/ci.yml`
- 目录骨架：`apps/desktop-tauri`、`apps/desktop-electron`、`apps/renderer`、`packages/{shell-api,core,data,ui,memory,designer,ai,pipeline,git,preview,registry,package-kit,account}`（各含 `package.json`、`tsconfig.json`、`src/index.ts` 占位）
- `docs/DEV-SETUP.md`：本地开发启动说明
- `README.md` 更新：标注闭源、内部仓库占位、安装与开发步骤

**实现要点**

1. pnpm workspace + TypeScript project references；`tsconfig.base.json` 开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
2. ESLint 覆盖 TS/React，规则集与 Prettier 无冲突；CI 跑 `lint + typecheck + test`。
3. 包命名统一 `@ec/*`；每个包导出单一入口 `src/index.ts`，禁止深路径跨包引用。
4. 不写 LICENSE 文件，不写"欢迎贡献/开源"类文案。

**验收标准**

- [ ] `pnpm install && pnpm -r typecheck && pnpm -r test` 在干净环境零错误
- [ ] 13 个 packages + 3 个 apps 目录齐备且类型检查通过
- [ ] CI 配置文件可执行（lint / typecheck / test 三个 job）

**▶ AI 执行提示词**

```
任务 T0-01：初始化 pnpm 单体仓库与全部 packages/apps 骨架。
要求：
1) 按上下文中的目录约定创建全部目录，每个包有 package.json（名称 @ec/<包名>）、tsconfig.json（继承根 base）、src/index.ts 占位导出。
2) 根配置：pnpm-workspace.yaml、tsconfig.base.json（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）、ESLint（TS + React）、Prettier、EditorConfig、Vitest、.gitignore（含 node_modules/dist/target/.ecpkg 等）。
3) GitHub Actions CI：lint / typecheck / test 三个 job，Node 22 + pnpm，带缓存。
4) 编写 docs/DEV-SETUP.md（安装依赖、启动渲染层 dev server、跑测试），并更新 README.md：标注"闭源项目，不接受外部贡献"，克隆地址用内部仓库占位。
5) 不创建 LICENSE 文件，不出现开源许可证与贡献引导文案。
验收：pnpm install 后 pnpm -r typecheck 与 pnpm -r test 零错误；CI 配置语法正确。
```

---

## T0-02 外壳抽象层 Shell API 定义

| 项       | 内容                       |
| -------- | -------------------------- |
| 覆盖需求 | D-01；§3.3；NFR-M-01       |
| 优先级   | P0                         |
| 前置任务 | T0-01                      |
| 可并行   | 无（T0-03 / T0-04 依赖它） |

**产出物**

- `packages/shell-api/src/types.ts`：`ShellHost` 全部接口定义
- `packages/shell-api/src/index.ts`：工厂 `createShell(kind)`、能力探测、版本协商
- `packages/shell-api/src/mock.ts`：内存 MockShell（供单测与渲染层无外壳开发）
- `packages/shell-api/src/errors.ts`、`packages/shell-api/src/__tests__/*.test.ts`

**实现要点**

1. `ShellHost` 至少覆盖：fs（read/write/**atomicWrite**/stat/readdir/watch/mkdir/remove）、path、dialog、process（spawn/kill/日志流/onExit）、window、secureStore（DPAPI 加密读写删除）、updater、appInfo（版本/平台/形态）、clipboard、openExternal、net（受限 fetch，供 OAuth 与 AI 请求）。
2. 所有方法异步、返回结构化结果，错误统一 `ShellError{ code, message, cause }`。
3. `ShellKind = 'tauri' | 'electron' | 'mock'`；渲染层只依赖接口，禁止 import 任何具体外壳包。
4. 能力探测 `capabilities(): Promise<ShellCapabilities>`，缺能力时降级而非报错。

**验收标准**

- [ ] 接口文件覆盖上述 10 类能力，且原子写是 fs 的一等公民方法
- [ ] MockShell 可通过同一套契约测试
- [ ] 渲染层代码 grep 不到 `electron` 或 `@tauri-apps` 的直接引用

**▶ AI 执行提示词**

```
任务 T0-02：定义外壳抽象层 Shell API（packages/shell-api）。
背景：Tauri 2 与 Electron 双形态并存（D-01），业务逻辑必须零感知外壳差异。
要求：
1) src/types.ts 定义 ShellHost 接口，覆盖：fs（含 atomicWrite 原子写：临时文件+rename）、path、dialog、process（spawn/kill/日志流订阅/onExit）、window、secureStore（DPAPI 加密读写）、updater、appInfo、clipboard、openExternal、net(受限 fetch)。
2) 统一错误类型 ShellError{code,message,cause}；所有方法返回 Promise。
3) src/index.ts 提供 createShell(kind: 'tauri'|'electron'|'mock') 与 capabilities() 能力探测；src/mock.ts 提供内存实现。
4) 编写针对接口的契约测试（对 mock 实现跑），覆盖 fs 原子写、进程日志流、secureStore 加解密失败路径。
验收：接口覆盖 10 类能力；mock 通过契约测试；packages 之外无任何具体外壳依赖。
```

---

## T0-03 Tauri 2 外壳实现

| 项       | 内容                                               |
| -------- | -------------------------------------------------- |
| 覆盖需求 | D-01；§3.3；NFR-C-02（WebView2 引导）；NFR-P-05/09 |
| 优先级   | P0                                                 |
| 前置任务 | T0-02                                              |
| 可并行   | T0-04                                              |

**产出物**

- `apps/desktop-tauri/src-tauri/`：`Cargo.toml`、`tauri.conf.json`、`src/main.rs`、`src/lib.rs`、`src/commands/{fs,process,secure_store,window,updater,net}.rs`
- `apps/desktop-tauri/src/bridge.ts`：把 Rust 命令桥接为 `ShellHost`
- `apps/desktop-tauri/src/webview2-check.ts`：WebView2 缺失引导
- `apps/desktop-tauri/README.md`

**实现要点**

1. 每个命令对应 `ShellHost` 的方法签名，参数/返回用 serde 序列化，命名与接口一致。
2. `secureStore` 用 Windows DPAPI（`CryptProtectData` / `CryptUnprotectData`，按当前用户上下文加密）。
3. 进程管理使用 `std::process` + tokio 读 stdout/stderr，通过 Tauri channel 推事件。
4. `tauri.conf.json` 配置 NSIS 打包目标、updater 端点与公钥占位、窗口初始尺寸与最小尺寸。

**验收标准**

- [ ] `pnpm --filter desktop-tauri dev` 能启动窗口并加载渲染层
- [ ] 通过 T0-02 的契约测试（以 Tauri 实现替换 mock 跑同一套用例）
- [ ] DPAPI 写入后同一用户可解密、换用户不可解密
- [ ] WebView2 缺失时给出引导提示而非白屏

**▶ AI 执行提示词**

```
任务 T0-03：实现 Tauri 2 外壳（apps/desktop-tauri），把 packages/shell-api 的 ShellHost 接口落地为 Rust 命令。
要求：
1) Cargo 项目（Tauri 2）+ tauri.conf.json：产品名 EveryoneCoding、NSIS 打包、updater 端点与公钥占位、窗口默认 1440x900 最小 1024x640、禁用 devtools 在生产构建。
2) src/commands/ 分模块实现 fs（含原子写：写 .tmp 后 rename）、path、dialog、process（tokio 读 stdout/stderr 并通过 channel 推送事件）、window、secure_store（Windows DPAPI CryptProtectData/CryptUnprotectData，按当前用户上下文）、updater、appInfo、clipboard、openExternal、net。
3) src/bridge.ts 把 invoke 调用封装成 ShellHost 实现，类型与接口严格一致。
4) WebView2 运行时检测，缺失时展示引导安装界面（不白屏）。
5) 跑通 T0-02 的契约测试（把 mock 替换为 Tauri 实现）。
验收：dev 能启动窗口并加载渲染层；契约测试通过；DPAPI 换用户不可解密；WebView2 缺失有引导。
```

---

## T0-04 Electron 外壳实现

| 项       | 内容                               |
| -------- | ---------------------------------- |
| 覆盖需求 | D-01；§3.3；NFR-P-05/09；FR-SET-05 |
| 优先级   | P0                                 |
| 前置任务 | T0-02                              |
| 可并行   | T0-03                              |

**产出物**

- `apps/desktop-electron/src/main/{index.ts,ipc/{fs,process,secure_store,window,updater,net}.ts}`
- `apps/desktop-electron/src/preload/index.ts`（contextBridge 暴露白名单 API）
- `apps/desktop-electron/electron-builder.yml`（NSIS + electron-updater）
- `apps/desktop-electron/src/bridge.ts`

**实现要点**

1. 主进程 `sandbox: true`、`nodeIntegration: false`、`contextIsolation: true`；preload 仅暴露必要通道。
2. `secureStore` 用 `safeStorage`（底层 DPAPI）+ 文件系统持久化。
3. IPC 通道命名与 `ShellHost` 方法一一对应，参数校验在 preload 层做。
4. electron-builder 配置 NSIS、publish 通道、与 Tauri 版共用同一版本号。

**验收标准**

- [ ] `pnpm --filter desktop-electron dev` 能启动并加载渲染层
- [ ] 通过 T0-02 契约测试
- [ ] preload 未暴露任何 Node 全局对象到渲染层（安全审计脚本可验证）
- [ ] electron-builder 能产出 NSIS 安装包（允许 updater 端点为占位）

**▶ AI 执行提示词**

```
任务 T0-04：实现 Electron 外壳（apps/desktop-electron），把 ShellHost 接口落地为主进程 IPC。
要求：
1) 主进程 index.ts 创建 BrowserWindow：sandbox true、nodeIntegration false、contextIsolation true；preload 用 contextBridge 只暴露与 ShellHost 方法一一对应的白名单通道，并在 preload 做参数校验。
2) ipc/ 分模块实现 fs（原子写 .tmp+rename）、path、dialog、process（child_process spawn + stdout/stderr 事件转发 + kill）、window、secure_store（electron safeStorage，底层 DPAPI）、updater（electron-updater）、appInfo、clipboard、openExternal、net。
3) src/bridge.ts 封装为 ShellHost 实现，类型严格一致。
4) electron-builder.yml：NSIS 目标、publish 配置占位、与 Tauri 版共用版本号（从根 package.json 读取）。
5) 跑通 T0-02 契约测试。
验收：dev 能启动并加载渲染层；契约测试通过；渲染层拿不到任何 Node 全局；builder 配置可解析。
```

---

## T0-05 渲染层应用骨架

| 项       | 内容                                             |
| -------- | ------------------------------------------------ |
| 覆盖需求 | §3.3；NFR-C-03（高分屏）；NFR-P-01（冷启动 ≤5s） |
| 优先级   | P0                                               |
| 前置任务 | T0-01、T0-02（可用 mock 外壳）                   |
| 可并行   | T0-06                                            |

**产出物**

- `apps/renderer/`：Vite 配置、`src/main.tsx`、`src/App.tsx`、`src/router.tsx`
- `src/layout/{AppShell,LeftNav,MainArea,RightPanel,StatusBar,TitleBar}.tsx`
- `src/store/{useAppStore,useProjectStore,useUiStore}.ts`
- `src/theme/{tokens.css,theme-provider.tsx}`、`src/i18n/{index.ts,zh-CN.ts,en-US.ts}`
- `src/error-boundary.tsx`

**实现要点**

1. 通过 `createShell()` 注入外壳，启动时按 `appInfo.kind` 选择实现；mock 可在无外壳下开发。
2. Zustand store 分域：app（会话/设置）、project（当前项目）、ui（面板布局/主题）；持久化只落 ui 与设置。
3. 主题浅色/深色/跟随系统，高分屏使用 `devicePixelRatio` 与 CSS 变量，禁用位图缩放。
4. 布局为可拖拽分栏：左导航 / 主区 / 右侧面板 / 底部状态栏。

**验收标准**

- [ ] 用 mock 外壳可 `pnpm --filter renderer dev` 启动完整骨架
- [ ] 主题切换即时生效；150% / 200% 缩放下无模糊错位
- [ ] 路由可切换到占位页面（工作台/设计器/记忆/Git/预览/设置）
- [ ] 冷启动到可交互 ≤ 5s（在 dev 与 preview 构建下各测一次并记录数据）

**▶ AI 执行提示词**

```
任务 T0-05：搭建 React 渲染层应用骨架（apps/renderer）。
要求：
1) Vite + React 18 + TS strict；通过 createShell() 注入外壳（当前用 mock 实现即可，后续替换），启动后打印外壳 kind 与 capabilities。
2) 主布局 AppShell：顶部 TitleBar、左侧导航、中部主区、右侧可折叠面板、底部状态栏；分栏可拖拽调整大小。
3) Zustand 分三个 store：app / project / ui，持久化仅 ui 与设置项；接入 Immer。
4) 主题：设计令牌写进 CSS 变量，支持浅色/深色/跟随系统；高分屏（150%/200%）用 devicePixelRatio 处理，禁用位图缩放导致模糊。
5) i18n：zh-CN / en-US 两份资源，简体中文为默认；react-router 配置占位路由（工作台/设计器/记忆/Git/预览/设置）。
6) ErrorBoundary 捕获渲染异常并展示错误详情与"复制日志"。
验收：mock 外壳下 dev 可启动；主题切换与缩放无异常；六个占位路由可达；记录一次冷启动耗时。
```

---

## T0-06 UI 组件库与设计令牌

| 项       | 内容                                         |
| -------- | -------------------------------------------- |
| 覆盖需求 | NFR-U-01；§3.2（前端框架）；D-10（文案中文） |
| 优先级   | P0                                           |
| 前置任务 | T0-01                                        |
| 可并行   | T0-05                                        |

**产出物**

- `packages/ui/src/tokens/{color,spacing,radius,typography,shadow,z-index}.ts` + `tokens.css`
- `packages/ui/src/components/`：Button、IconButton、Input、Textarea、Select、Checkbox、Radio、Switch、Modal、Drawer、Tooltip、Popover、Menu、Tabs、Tree、Table、List、SplitPane、Resizable、Progress、Spinner、EmptyState、Toast、CommandPalette、ContextMenu、Badge、Tag、Breadcrumb、SearchInput
- `packages/ui/src/hooks/{useHotkeys,useResizeObserver,useVirtualList,useDisclosure}.ts`
- Storybook 或 docs 站点（二选一，用于组件自检）+ 单元测试

**实现要点**

1. 组件 API 稳定、受控/非受控都支持；全部支持键盘导航与 ARIA 属性。
2. 不引第三方 UI 框架（MUI/antd 等），自建以保证与画布样式隔离。
3. 显示文案全中文，标识符与 CSS 类名英文。
4. Tree / Table / List 必须虚拟化（后续 Git 历史 1000 条、100 项目网格要达标）。

**验收标准**

- [ ] 28 个组件全部有基础交互测试与键盘可达性测试
- [ ] 主题切换后全部组件配色正确（浅色优先，本 IDE 主题为浅色）
- [ ] 虚拟化列表在 1 万条数据下滚动无卡顿（给出帧率记录）

**▶ AI 执行提示词**

```
任务 T0-06：实现设计令牌与基础 UI 组件库（packages/ui）。
要求：
1) tokens 目录定义颜色（浅色为默认）、间距、圆角、字号、阴影、层级，并导出为 CSS 变量与 TS 常量两份。
2) 自建组件（不引 MUI/antd）：Button、IconButton、Input、Textarea、Select、Checkbox、Radio、Switch、Modal、Drawer、Tooltip、Popover、Menu、Tabs、Tree、Table、List、SplitPane、Resizable、Progress、Spinner、EmptyState、Toast、CommandPalette、ContextMenu、Badge、Tag、Breadcrumb、SearchInput。
3) 全部组件支持键盘导航与 ARIA；受控/非受控双模式；显示文案中文、类名与标识符英文。
4) hooks：useHotkeys、useResizeObserver、useVirtualList、useDisclosure。
5) Tree/Table/List 必须虚拟化；提供 1 万条数据的滚动测试。
6) 每个组件至少一个交互单测 + 一个键盘可达性测试。
验收：组件齐全且测试通过；主题切换配色正确；虚拟化列表 1 万条滚动流畅（附帧率数据）。
```

---

## T0-07 SQLite 存储层与迁移框架

| 项       | 内容                                                |
| -------- | --------------------------------------------------- |
| 覆盖需求 | §3.2（本地存储）；NFR-P-03（检索 ≤200ms）；NFR-S-01 |
| 优先级   | P0                                                  |
| 前置任务 | T0-02                                               |
| 可并行   | T0-06、T0-08（DDL 由本任务消费）                    |

**产出物**

- `packages/data/src/{client.ts,migrator.ts,repository.ts,unit-of-work.ts}`
- `packages/data/src/ext/{fts5.ts,sqlite-vec.ts}`：扩展加载与可用性检测
- `packages/data/migrations/*.sql`（由 T0-08 提供，本任务负责 runner）
- `packages/data/src/__tests__/*`

**实现要点**

1. 通过 Shell API 拿数据目录，连接单例 + WAL 模式 + busy_timeout；所有写操作走事务。
2. 迁移框架：版本表 `schema_migrations`、按序执行、失败回滚、幂等；提供 `up`/`down`/`status`。
3. FTS5 与 sqlite-vec 扩展加载失败时降级（FTS5 缺失则关键词检索退化为 LIKE 并告警）。
4. 提供通用 Repository 基类（CRUD + 乐观锁 version + 软删除）。

**验收标准**

- [ ] 迁移可重复执行且幂等；中途失败不留半截 schema
- [ ] WAL 开启，写事务有超时与重试
- [ ] 扩展不可用时不崩溃、降级并给出明确告警
- [ ] Repository 乐观锁冲突测试通过

**▶ AI 执行提示词**

```
任务 T0-07：实现 SQLite 存储层与迁移框架（packages/data）。
要求：
1) 通过 Shell API 获取数据目录，创建单例连接：开启 WAL、设置 busy_timeout、foreign_keys ON。
2) 迁移框架：schema_migrations 表记录版本；支持 up/down/status；按序执行、单迁移事务化、失败即回滚、可重复执行（幂等）；迁移文件放 migrations/*.sql，命名 0001_xxx.sql。
3) 扩展加载：FTS5 与 sqlite-vec 分别检测可用性，缺失时降级（FTS5 缺失退化为 LIKE 并告警，vec 缺失则关闭语义检索），不得崩溃。
4) Repository 基类：CRUD + version 乐观锁（冲突抛 ConflictError）+ created_at/updated_at 自动维护；UnitOfWork 支持多 repository 同一事务。
5) 单元测试：迁移幂等、失败回滚、乐观锁冲突、降级路径。
验收：上述测试全通过；给出一次 1 万行批量插入的耗时数据。
```

---

## T0-08 全量数据库 DDL 与种子数据

| 项       | 内容                                 |
| -------- | ------------------------------------ |
| 覆盖需求 | §6.2 全部表；FR-MEM-07；E2E 数据基础 |
| 优先级   | P0                                   |
| 前置任务 | T0-01                                |
| 可并行   | 无（T0-07 消费其产出）               |

**产出物**

- `packages/data/migrations/0001_init.sql`：全部核心表与索引
- `packages/data/migrations/0002_fts.sql`：FTS5 虚表与触发器
- `packages/data/src/schema.ts`：表结构对应的 TS 类型与 zod schema
- `packages/data/src/seed.ts`：开发用种子数据（1 用户 / 2 项目 / 若干记忆）

**实现要点**

1. 表至少包含：`user`、`workspace`、`project`、`feature`、`page`、`element`、`note`、`document`、`memory_doc_link`、`memory_item`、`code_anchor`、`pipeline_run`、`stage_artifact`、`provider`、`model`、`usage_record`、`registry_entry`、`occurrence`、`rename_event`、`package_job`、`setting`、`secure_ref`。
2. 字段严格对齐 PRD §6.2（memory_item、element、code_anchor、pipeline_run、registry_entry、occurrence、rename_event、package_job 八张表逐字段对齐）。
3. 索引：按查询主路径建（project_id、scope+project_id、element_id、registry_id、file_path 等）；FTS5 虚表覆盖 memory_item 的 title/content。
4. 所有主键用 ULID 字符串；时间字段 Unix ms INTEGER。

**验收标准**

- [ ] PRD §6.2 八张核心表字段逐项可对照，无遗漏
- [ ] 迁移执行后外键与索引齐全，`PRAGMA foreign_key_check` 无错误
- [ ] zod schema 与 SQL 字段一一对应，类型测试通过
- [ ] 种子数据可一键生成并清除

**▶ AI 执行提示词**

```
任务 T0-08：编写全量数据库 DDL、FTS5 虚表与 TS schema（packages/data）。
要求：
1) migrations/0001_init.sql 建表：user、workspace、project、feature、page、element、note、document、memory_doc_link、memory_item、code_anchor、pipeline_run、stage_artifact、provider、model、usage_record、registry_entry、occurrence、rename_event、package_job、setting、secure_ref。
2) 必须与 docs/PRD-EveryoneCoding.md §6.2 逐字段对齐的八张表：memory_item、element、code_anchor、pipeline_run/stage_artifact、registry_entry、occurrence、rename_event、package_job。主键 ULID 字符串，时间用 Unix ms INTEGER，JSON 字段用 TEXT。
3) migrations/0002_fts.sql：为 memory_item(title, content) 建 FTS5 虚表与同步触发器；为向量检索预留 vec0 虚表（T0-07 检测可用后启用）。
4) src/schema.ts：每张表对应 TS interface + zod schema，字段与 SQL 一一对应，写类型测试断言字段集合一致。
5) src/seed.ts：一键生成/清除开发种子数据（1 用户、2 项目、若干五层记忆、1 条需求文档）。
验收：迁移执行后 PRAGMA foreign_key_check 无错误；类型测试通过；种子数据可生成可清除。
```

---

## T0-09 应用内核：事件总线 / 命令系统 / 撤销重做 / 崩溃恢复

| 项       | 内容                                                |
| -------- | --------------------------------------------------- |
| 覆盖需求 | §3.1 应用内核；FR-SET-08；NFR-R-01（丢失窗口 ≤30s） |
| 优先级   | P0                                                  |
| 前置任务 | T0-05、T0-07                                        |
| 可并行   | 无                                                  |

**产出物**

- `packages/core/src/{event-bus.ts,command-registry.ts,undo-manager.ts,persist-middleware.ts,crash-recovery.ts,logger.ts}`
- `packages/core/src/commands/`：命令注册与快捷键绑定基础设施
- 单元测试

**实现要点**

1. 事件总线 typed（`EventMap` 声明式），支持 once/off/通配符订阅，异步事件串行化。
2. 命令系统：每个可视化操作抽象为命令（id、标题、快捷键、是否可撤销、execute），支持启用/禁用条件与命令面板检索。
3. 撤销重做基于 Zundo + Immer，按 store 域隔离；命令执行写入 undo 栈。
4. 崩溃恢复：未保存状态每 20s 快照到磁盘（≤30s 丢失窗口），启动时检测脏快照并提示恢复。

**验收标准**

- [ ] 事件总线类型安全，通配符与 once 行为正确
- [ ] 命令可注册、可绑定快捷键、可按条件禁用
- [ ] undo/redo 覆盖设计器与记忆编辑两类 store
- [ ] 模拟强杀进程后重启可恢复到 ≤30s 前的状态

**▶ AI 执行提示词**

```
任务 T0-09：实现应用内核 packages/core。
要求：
1) event-bus.ts：类型化事件总线（EventMap 声明式），支持 on/once/off/通配符订阅，异步监听串行执行，异常不中断其他监听。
2) command-registry.ts：命令模型 {id, title, group, shortcut, isUndoable, isEnabled(ctx), execute(ctx)}；支持批量注册、按 id 执行、快捷键解析（Ctrl/Ctrl+Shift/Alt 组合）、命令面板检索（按标题与分组模糊匹配）。
3) undo-manager.ts：基于 Zundo + Immer，按 store 域隔离多个 undo 栈，支持栈合并（连续同类操作合并为一步）与上限裁剪。
4) crash-recovery.ts：对标记为可恢复的 store 每 20s 写一次快照（原子写），启动时检测未完成快照并弹窗询问是否恢复，恢复窗口 ≤30s。
5) logger.ts：分级（debug/info/warn/error）、结构化输出、自动脱敏（Key/Token/手机号/邮箱）、文件轮转。
6) 单测覆盖：总线通配符与异常隔离、命令快捷键冲突检测、undo 合并、崩溃恢复模拟（写入后模拟强杀再启动）。
验收：上述测试通过；给出崩溃恢复实测时间。
```

---

## T0-10 设置、密钥环与日志脱敏

| 项       | 内容                                                   |
| -------- | ------------------------------------------------------ |
| 覆盖需求 | FR-MDL-09；FR-ACC-07；FR-SET-01/06；NFR-S-01；NFR-S-04 |
| 优先级   | P0                                                     |
| 前置任务 | T0-02、T0-07、T0-09                                    |
| 可并行   | 无                                                     |

**产出物**

- `packages/core/src/{settings.ts,secure-store.ts,redaction.ts,telemetry.ts}`
- `packages/core/src/settings-schema.ts`（zod schema + 默认值 + 迁移）
- 单元测试与脱敏样例测试

**实现要点**

1. Setting 分层：全局 / 项目级；zod schema 定义、默认值、版本迁移；修改即时生效（不重启）。
2. secure-store 封装 ShellHost.secureStore，按用途命名空间（ai-key / oauth-token / git-credential），永不落地明文。
3. 脱敏规则统一在 redaction.ts：API Key、Bearer、密码、连接串、手机号、邮箱；日志输出与导出文件共用。
4. 遥测默认关闭，需显式授权；AI 请求内容默认不上传。

**验收标准**

- [ ] 设置项修改即时生效，非法值被 zod 拦截
- [ ] 密钥写入后磁盘文件中检索不到明文
- [ ] 日志中出现的 Key/Token/邮箱/手机号 100% 被脱敏（提供 20 条样例测试）
- [ ] 遥测未授权时零上报（网络 mock 断言）

**▶ AI 执行提示词**

```
任务 T0-10：实现设置、密钥环与日志脱敏（packages/core）。
要求：
1) settings.ts + settings-schema.ts：zod 定义全局/项目两级设置（语言、主题、AI 默认 Provider、写入策略、Git 提交规范、快捷键、数据目录）；带版本号与迁移函数；修改即时生效（订阅即刷新，无需重启）。
2) secure-store.ts：封装 ShellHost.secureStore，按命名空间 ai-key / oauth-token / git-credential 存取；提供 exists/delete/list（只返回 key 名不返回值）；任何异常不泄漏明文到日志。
3) redaction.ts：统一脱敏规则，覆盖 API Key（sk- 及常见前缀）、Bearer token、password 字段、数据库连接串、手机号、邮箱（保留首尾各 1 位）；提供 mask() 与 maskObject()。
4) telemetry.ts：默认关闭，需用户显式授权；AI 请求内容默认不上传；未授权时零网络调用。
5) 单测：设置迁移、secure-store 异常路径、20 条脱敏样例断言、遥测未授权零上报（用 mock net 断言）。
验收：测试通过；在生成的日志文件中全文检索确认无明文密钥。
```

---

## T0-11 原子写、文件服务与工程目录约定

| 项       | 内容                                               |
| -------- | -------------------------------------------------- |
| 覆盖需求 | NFR-R-02（临时文件+原子替换）；FR-SET-03；NFR-R-03 |
| 优先级   | P0                                                 |
| 前置任务 | T0-02                                              |
| 可并行   | 无                                                 |

**产出物**

- `packages/core/src/{file-service.ts,path-guard.ts,gitignore-templates.ts,workspace-layout.ts}`
- 单元测试（含断电模拟）

**实现要点**

1. file-service 统一封装：写入临时文件 → fsync → rename 替换；大文件流式写；读文件带缓存失效。
2. path-guard：所有路径必须在工作区根目录内，拒绝 `..` 逃逸与符号链接穿越。
3. workspace-layout 定义工程目录结构（`<workspace>/projects/<id>/{design,docs,pipeline,code,meta}`），提供创建/校验/迁移。
4. gitignore 模板按技术栈（Node / Python / Java / Go / Flutter / HarmonyOS-ArkTS）生成。

**验收标准**

- [ ] 写入过程中断（模拟抛错/杀进程）不产生半截文件
- [ ] 路径逃逸尝试全部被拒绝并抛错
- [ ] 工作区目录结构可创建、可校验、缺失时自动修复
- [ ] 5 套 gitignore 模板均可生成，HarmonyOS-ArkTS 模板覆盖 .hvigor / oh-modules / build 产物

**▶ AI 执行提示词**

```
任务 T0-11：实现原子写文件服务与工程目录约定（packages/core）。
要求：
1) file-service.ts：所有写操作走"写 .tmp → fsync → rename 替换"；提供 writeAtomic / writeStream / readText / readJson / exists / remove / list；同一文件并发写用互斥队列串行化。
2) path-guard.ts：resolveInWorkspace(root, target)，拒绝 .. 逃逸、绝对路径穿越、符号链接指向外部；违规抛 PathEscapeError。
3) workspace-layout.ts：定义 <workspace>/projects/<projectId>/{design,docs,pipeline,code,meta}；提供 create / validate / repair；工作区根目录可配置（FR-SET-03）并支持迁移。
4) gitignore-templates.ts：Node / Python / Java / Go / Flutter / HarmonyOS-ArkTS（排除 .hvigor、oh_modules、build、**/src/main/resources/base 里生成的缓存）六套模板，可组合生成 .gitignore。
5) 单测：写入中途抛异常不产生目标文件（模拟断电）、并发写串行化、路径逃逸被拒、目录 repair 修复缺失、模板生成。
验收：测试全通过；给出一份工作区目录结构示例。
```

---

**Wave 0 出口检查**：双形态客户端可启动空壳；SQLite 迁移与种子数据可执行；UI 组件库可用；模拟强杀可恢复；日志无明文密钥。
