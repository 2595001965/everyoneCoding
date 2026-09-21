# EveryoneCoding 测试报告（TEST-REPORT）

> 生成：Wave 10 / T10-03（2026-09-13）；2026-09-14 复测并修正门禁脚本；**2026-09-15 环境恢复后补齐 git 实测**。
> 数据来源：`ci/quality-gate.mts`（六核心模块逐模块覆盖率门禁）、全仓 vitest、既有各 Wave 测试。
> 门禁定义：`ci/quality-gate.yml`（lint / typecheck / test / coverage / clippy 五 job，任一失败 = 构建失败）。

## 1. 六核心模块行覆盖率（门禁阈值 ≥70%）

测量方式：`node --experimental-strip-types ci/quality-gate.mts`——逐模块单独跑
`vitest --coverage`（V8 provider），**由 vitest 内建的 `--coverage.thresholds.lines=70` 判定退出码**
（不依赖报告文件解析），并从 text reporter 的汇总行抓取各列供展示。
**逐模块单跑是刻意的**：全仓并行时 V8 覆盖不跨 worker 聚合，分母会失真。

| 模块                                           | 行覆盖率   | 判定                           |
| ---------------------------------------------- | ---------- | ------------------------------ |
| 记忆系统 `packages/memory`                     | 90.78%     | ✅                             |
| 上下文引擎 `packages/ai/src/context`           | 93.68%     | ✅                             |
| Git 封装 `packages/git`                        | **75.71%** | ✅（2026-09-15 实测，见 §1.2） |
| Provider 适配 `packages/ai/src/adapters`       | 74.86%     | ✅                             |
| 统一标识注册表与重命名引擎 `packages/registry` | 85.68%     | ✅                             |
| 归档读写 `packages/package-kit`                | 85.14%     | ✅                             |

本轮补齐（2026-09-13）：`packages/ai/src/adapters` 原 66.8%（`openai/embeddings.ts` 覆盖 0%），
新增 `openai/__tests__/embeddings.test.ts`（11 项：请求体构造 / 响应解析 / 乱序 index
重排 / 空输入 / 404 归类 unsupported-model / 401 / 非法 JSON / 条数不一致 / 传输失败，
全部走本地 mock 服务真实 HTTP），adapters 提升至 74.86%。

### 1.1 门禁脚本本轮修正的三处（2026-09-14）

1. **取错列**：text reporter 的汇总行列序是 `% Stmts | % Branch | % Funcs | % Lines`，
   旧版取第 1 个数字（% Stmts）却当作"行覆盖率"展示。已按列序取第 4 列，展示为「x% 行 / y% 语句」。
2. **每模块超时 10 分钟不够**：本机插桩覆盖率下 `packages/memory` 需 44s、
   `packages/git`（含真实子进程集成测试）需 6 分钟以上。被超时砍掉时 vitest 不打印汇总表，
   旧版会把"没解析到"误报成 `0.00%`（**看起来像覆盖率崩塌，实为环境超时**）。
   已放到 30 分钟，并在输出里明确区分「未取到覆盖率数据（退出码 N / 超时被终止）」与真实百分比，
   同时打印每模块耗时。
3. **`pnpm lint` 一直在红**（与覆盖率无关，但同属门禁）：`perf/run.ts` 有 7 处 `no-console` 警告
   （它是 `.ts`，在 lint 范围内），而 `ci/*.mts` 因 lint 脚本只写 `--ext .ts,.tsx` **完全没被扫到**。
   已给 CLI 脚本（`perf/**`、`ci/**`）加规则豁免（stdout 就是它们的输出界面），
   并把 `--ext` 补上 `.mts`。**根 lint 现在全仓（含 e2e / perf / ci）零 error 零 warning。**

### 1.2 Git 模块覆盖率的环境敏感性

`packages/git` 的覆盖率高度依赖其**真实子进程集成测试** `git-integration.test.ts`
（同一套用例对 cli 与 git2 两个后端各跑一遍完整流程：init → status → add → commit → branch →
merge → stash → 回滚 → 推送 → 冲突解决，单趟含上百次真实 git 调用）。

**2026-09-14 记录的三项实测（当时本机 git 子进程 ≈18s/次，慢 14 倍）**：

1. 把该文件从覆盖率运行里排除后，git 行覆盖率从 75.8%（2026-09-13 记录）掉到 **47.08%（低于阈值）**
   —— 所以**不能**用"排除慢用例"让门禁变绿：它确实贡献了约 29 个百分点的覆盖。
2. 该文件两个用例原超时 180s；本机单趟 >180s → 3 项红（含最后一个一致性断言连带失败）。
3. 放宽到 900s 后**仍然两趟都超时**（各 900012ms），模块总耗时 30m53s。
   用例超时由此改为**环境变量可控、默认 180s**（`EC_GIT_IT_TIMEOUT_MS`）。

**2026-09-15 环境恢复，实测补齐（结论：达标）**：

本机进程速度恢复正常（`git --version` 1.3s、`node -e` 1.5s，此前 18s/13s）：

- `git-integration.test.ts` 单独跑：**3/3 通过，152s**（CLI 后端 77s + git2 回退后端 75s）。
- 按门禁原始口径（同参数复现 `ci/quality-gate.mts` 的调用）跑 `packages/git` 全模块覆盖率：
  **56 项全绿（155s），行覆盖 75.71%** —— 与 2026-09-13 记录的 75.8% 相互印证。
  覆盖率明细：src 层 79.74%（其中 `merge-service` 55%、`remote-service` 41% 为最薄两处，
  均已有真实集成路径触达），backend 层 66.83%（`git2-backend` 41.92% 为绑定不可用时的回退分支为主）。
- **处置**：超时环境变量 `EC_GIT_IT_TIMEOUT_MS` 与默认 180s 保留（正常机器单趟数秒~数十秒，
  180s 足以暴露真实卡死）；`docs/ACCEPTANCE-REPORT.md` L-03（进程慢导致用例易超时）随环境恢复解除。

**2026-09-20 第二次复现与确诊（结论：环境性，非代码问题；未改动任何超时预算）**：

T12-01 收尾跑全量单测时，以下两个文件共 8 项红（其余 2411 项全绿）：

| 文件                                                     | 红项 | 该文件的超时口径               |
| -------------------------------------------------------- | ---- | ------------------------------ |
| `apps/desktop-electron/.../domain-workspace-git.test.ts` | 5    | 用根 `vitest.config.ts` 的 15s |
| `packages/git/src/__tests__/git-integration.test.ts`     | 3    | `EC_GIT_IT_TIMEOUT_MS ?? 180s` |

**决定性实验（用于区分「进程创建慢」与「git 慢」，比只量 `git --version` 更有判别力）**：

| 被测量                                | 退化期间实测 | 恢复后实测 |
| ------------------------------------- | ------------ | ---------- |
| `spawn where.exe git`（极简原生进程） | —            | **501ms**  |
| `spawn node -e 0`（极简原生进程）     | —            | **503ms**  |
| `spawn git --version`                 | **26489ms**  | **759ms**  |
| `spawn git --version`（精简 env）     | —            | 861ms      |

结论：本机**进程创建本身**就有 ~0.5s 地板价，git 只在上面多约 260ms。
退化期间 `git --version` 的 26.5s 说明**进程创建被系统层拖慢约 50 倍**（实时杀毒扫描/过滤驱动一类），
与 git、与本仓代码都无关；`@ec/git` 侧已核对**无冗余子进程**（`probe()` 只在建客户端时跑一次，
`status()` 单次 spawn，后端探测结果被 ESM 模块缓存），不存在"每次操作多起几个进程"的可优化项。

**恢复后按默认超时复跑（未加任何 `--testTimeout` 覆盖）**：

- `domain-workspace-git.test.ts`：**9/9 通过，46.2s**（单例 2.3s ~ 8.3s，最慢例仍留 1.8x 余量）。
- `git-integration.test.ts`：**3/3 通过，184.9s**（CLI 后端 106.0s + git2 回退后端 78.7s）。
- 两者合计 **12/12**。

**处置口径**：**不改这两个文件的超时预算**（放宽预算只会掩盖真实卡死；`domain-workspace-git` 的
15s 与 `git-integration` 的 180s 都属"够暴露卡死"的量级）。再次遇到这两个文件红时，按以下顺序自证：

1. 量 `git --version` **与** `where.exe git` 的单次耗时（只需前者会说"git 慢"，两者一起才能判定
   是"进程创建慢"）；
2. 若 `where.exe` 也在秒级且两个文件未引用本次改动的模块 → 判定环境性；
3. 需立即出绿时用 `--testTimeout=<大值>` 或 `EC_GIT_IT_TIMEOUT_MS` **临时**放行，不要把值写回源码；
4. 治本手段是把仓库目录与 `git.exe` / `node.exe` 加入杀毒实时扫描白名单（需管理员权限）。

## 2. 破坏性操作撤销路径清单（集成测试 100% 覆盖）

任务卡要求的八类路径逐条核对，每条都能指到具体测试文件：

| #   | 破坏性操作         | 撤销路径                                                   | 覆盖测试                                                                                                                     |
| --- | ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | 项目删除           | 回收站 → 恢复（30 天保留期 + 超期清理）                    | `packages/core/src/project/__tests__/project-service.test.ts`                                                                |
| 2   | 流水线回退         | 回退到上一阶段（二次确认 + 下游 stale 标记）               | `packages/pipeline/src/__tests__/pipeline-machine.test.ts`（E2E-03 组件层：`apps/renderer/src/features/pipeline/__tests__`） |
| 3   | 文档版本切换       | doc_version 历史版本恢复                                   | `packages/core/src/docs/__tests__/doc-service.test.ts`                                                                       |
| 4   | 代码补丁应用       | 写入事务失败整体回滚（快照）+ 外部改动拒绝                 | `packages/ai/src/write/__tests__`（apply 事务 + external-change-watcher）                                                    |
| 5   | Git reset / revert | reset / revert + 冲突解决                                  | `packages/git/src/__tests__/git-integration.test.ts`（真实临时仓库，双后端同套用例）                                         |
| 6   | 重命名事务回滚     | 逆序 revert 全部执行器（含位置漂移硬失败）                 | `packages/registry/src/__tests__/rename-transaction.test.ts`                                                                 |
| 7   | 数据库迁移回滚     | 迁移三段式（-- up / -- down）幂等回滚                      | `packages/data/src/__tests__/migrator.test.ts`                                                                               |
| 8   | 导入覆盖回滚       | 冲突默认不覆盖（keepLocal）+ keepBoth + 一键回滚先自动快照 | `packages/package-kit/src/__tests__/import-conflict-resolver.test.ts`、`backup.test.ts`                                      |

**八类全部有集成测试覆盖，无缺口。**

## 3. 静态检查门禁

| 检查                            | 状态                               | 命令                                                                                                                                                  |
| ------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript strict 零 error      | ✅（17 个工程 + `e2e/`）           | `pnpm typecheck` + `tsc -p e2e/tsconfig.json`                                                                                                         |
| ESLint 零 error 零 warning      | ✅（含 e2e / perf / ci 的 `.mts`） | `pnpm lint`（`--max-warnings 0`，`--ext .ts,.tsx,.mts`）                                                                                              |
| Tauri `cargo clippy` 零 warning | ⏳ 待 Rust 工具链                  | 本机无 Rust；CI 配置已写 `-D warnings`（warning 即失败），装好工具链后 `cd apps/desktop-tauri/src-tauri && cargo clippy --all-targets -- -D warnings` |
| Electron 主进程 ESLint          | ✅（含在全仓 lint 内）             | `pnpm lint`（`apps/desktop-electron/src/**` 在 include 范围）                                                                                         |

## 4. CI 门禁配置

定义于 `ci/quality-gate.yml`，五 job：

1. **lint**：ESLint `--max-warnings 0`（`--ext .ts,.tsx,.mts`）
2. **typecheck**：`pnpm -r typecheck`（TS strict 全家桶）+ `tsc -p e2e/tsconfig.json`
3. **test**：全仓 vitest + `e2e`（`pnpm test:e2e`）
4. **coverage**：`ci/quality-gate.mts` 逐模块阈值校验，任一 <70% 退出码 1
5. **clippy**：Tauri Rust 侧 `cargo clippy --all-targets -- -D warnings`

任一 job 失败 = 构建失败（D-01：双形态均需达标——Electron 侧由 1/2/3/4 覆盖，
Tauri Rust 侧由 5 覆盖；渲染层与包为两形态共用代码，天然双形态同测）。

> 本仓库为公开仓库（Apache-2.0，尚未接入远端 CI 平台），此 yml 为**可执行门禁定义**，
> 接入内部 CI（GitLab CE / Gitea Actions 兼容语法）时直接使用或按平台改写。
> 本地等价复现命令：
> `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm quality-gate`。

## 5. 全仓测试基线

- 2026-09-13 Wave 9 基线：**204 文件 / 2049 项全绿**（当日本机 git 集成 3 项与 watcher 1 项通过）。
- 2026-09-14 Wave 10 复测：
  - **E2E 验收套件：`e2e/` 10 文件 / 39 项全绿**（`pnpm test:e2e`，总 241s，其中 E2E-07 占 224s）。
  - **埋点事件：21 项绿，关键路径覆盖 40/40 = 100%**（`telemetry-coverage.test.ts` 内打印）。
  - **用量 / 预算 / 用量面板：27 项绿**（`usage-report` 8 + `budget-alert` 9 + `usage-components` 10）。
  - **工作台（含新增 Onboarding）：35 项绿**（`features/workspace`）。
  - **渲染层 `vite build`：589 modules 通过**（Wave 9 基线 571 —— 增量即 usage 特性与 Onboarding）。
  - **根 lint：零 error 零 warning**（此前 `perf/**` 与 `ci/*.mts` 未被有效覆盖，见 §1.1）。
- 2026-09-15 环境恢复复测：
  - **git 集成：3/3 通过（152s）**；git 模块门禁口径覆盖率 **75.71% 达标**（见 §1.2）。
- 2026-09-20 T12-02 复测（只补端口与页面，未动任何超时/性能预算）：
  - 根级全量：**239 文件 / 2444 项，2443 通过、1 红**——红项是 `@ec/ai` 上下文性能基准
    （NFR-P-04，p95 338.56ms > 300ms）。**已判定为并发争用的环境性假红**，处置与判据见 §5.1。
  - 本轮新增：`domain-content-ports.test.ts` 17/17、`code-page.test.tsx` 5/5、
    `notes-entry-purity.test.ts` 3/3；`pnpm lint` / `pnpm -r typecheck` 零问题；
    `apps/renderer` 的 `vite build` 4.23s 通过。
- 2026-09-21 T12-03 复测（Electron 流水线生产运行时；同样**未动任何超时 / 性能预算**）：
  - **新增主进程集成测试** `apps/desktop-electron/src/main/__tests__/pipeline-production.test.ts`：**5/5 绿**
    （真实 SQLite + 真实工程目录 + 真实域运行时，只把 AI 网关换成按系统角色分派的假实现）。
  - **新增 E2E** `e2e/domain/e2e-22-pipeline-production.test.ts`：**2/2 绿**；E2E 套件由 10 文件 / 39 项
    增至 **11 文件 / 41 项全绿**（15.3s）。
  - **根 lint**：零 error 零 warning。**全仓 typecheck**：17/17 工程 `Done`，零错误。
  - **受影响包回归**：`@ec/pipeline` 82/82、`@ec/core` 240/240、渲染层 `features/pipeline` 15/15。
  - **根级全量单测**：串行（`-r --workspace-concurrency=1`）全绿；并发全量跑仍复现 §5.1 的
    `@ec/ai` 上下文基准假红（本轮实测 p95 **327.74ms** > 300ms），成因与处置同 §5.1。
  - **顺带修掉两处真实缺陷**（详见 `docs/ACCEPTANCE-REPORT.md §2.9.3`）：
    ① `@ec/core` 的 `CrashRecovery` 把领域名直接当文件名，而流水线领域名是 `pipeline:<projectId>`——
    Windows 上 `:` 是 NTFS 备用数据流，写/读/exists 全都"成功"但 `readdir` 列不出，脏快照检测静默失效、
    **崩溃恢复在主平台上整体失灵**（POSIX 与 `MockShell` 都复现不出，故既有 18 项单测全绿也没兜住）。
    现落盘名只保留 `[A-Za-z0-9._-]`、其余转 `_`，逻辑域名仍存信封 `domain`；
    `undo-crash-logger.test.ts` 补 1 项回归（19/19）。
    ② `MultiPlatformGenerator.parseFiles` 的裸 JSON 兜底正则缺捕获组（`jsonMatch[1]` 恒为 `undefined`），
    模型不带围栏回 JSON 时产物被整包丢弃。

### 5.1 上下文性能基准的环境敏感性（2026-09-20）

**现象**：`packages/ai/src/context/__tests__/context-engine.test.ts` 的「1000 条记忆下组装
≤300ms」在**根级全量并发**时红（实测 p95 338.56ms），单独跑则余量极大。

**决定性对照**（同一台机、同一份代码、同一命令，只改并发度）：

| 运行方式                                    | 冷启动  | 热 p50  | 热 p95       |
| ------------------------------------------- | ------- | ------- | ------------ |
| 只跑该测试文件（第 1 次）                   | 7.43ms  | 4.86ms  | **6.95ms**   |
| 只跑该测试文件（第 2 次）                   | 6.41ms  | 6.09ms  | **7.99ms**   |
| 只跑 `@ec/ai` 包内 301 项                   | 27.02ms | 19.04ms | **40.11ms**  |
| 根级全量 2444 项（含 196s 的真实 git 集成） | —       | —       | **338.56ms** |

单独运行时余量约 **40 倍**；全量并发时劣化约 **48 倍**。该基准的端口是内存夹具，
不含任何 IO —— 劣化只可能来自 CPU/进程争用（全量运行里同时有
`git-integration.test.ts` 在反复 spawn 真实 `git.exe`）。

**处置口径（与 §1.2 同一套纪律）**：

1. **不改测试里的 300ms 断言**，也不加 `skip`：放宽预算会把真实的性能回归一起放过去；
2. 需要一份可信的基准数据时，**单独跑该文件**（`vitest run src/context/__tests__/context-engine.test.ts`），
   或认读它在全量运行里打印的 `[T4-02 基准]` 行并注明并发度；
3. 若全量运行再次出现红，先做上表那种"只改并发度"的对照，再判断是否为本仓回归；
4. 治本仍是把 `git.exe` / `node.exe` 与仓库目录加入杀毒实时扫描白名单（需管理员权限）。
