# EveryoneCoding 性能基准报告（PERF-REPORT）

> 生成：Wave 10 / T10-02（2026-09-13）。数据来源分两类：
> ① **可复现基准**：`pnpm perf`（`perf/run.ts`）一键运行，测量用例即各包测试套件中的基准用例，与 CI 同源；
> ② **历史实测**：各 Wave 交付时在测试内 `process.stdout.write` 留下的实测值（引用出处）。
> 未在本机可测的指标（冷启动/内存/包体——需真实外壳与安装包）如实标注，不编造数据。

## 0. 机器配置与口径

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows 11（x64） |
| Node（测试运行时） | v24.20.0 |
| 测试框架 | Vitest 2.1.9（node 环境；UI/渲染层 jsdom） |
| 测量口径 | ① 各基准用例自带计时（毫秒）；② Windows 上 Vitest 全量并行会抢占 CPU，涉及绝对毫秒断言的用例（registry 索引）已按"固定工作量纯计算探针"归一化 |
| 局限 | jsdom 测不了真实帧率——拖拽类指标用「单帧几何计算 ms（对照 16.6ms 预算）+ 交互增量重渲染节点数」替代（Wave 3 确立口径）；冷启动 / 内存 / 安装包体积需真实外壳与打包产物，本机无 Rust 工具链、Electron 二进制未下载，列为待真实环境项 |

## 1. 九项 NFR-P 指标对照表

| 指标 | 预算 | 实测 | 达标 | 出处 / 测量方法 |
| --- | --- | --- | --- | --- |
| NFR-P-01 冷启动到可交互 | ≤5s | **待真实外壳**（见 §3） | ⏳ | 需双形态安装包实机启动；当前无 Rust 工具链（Tauri）且 Electron 二进制未下载 |
| NFR-P-02 500 元素拖拽 | ≥50FPS | 单帧几何 0.26ms（吸附计算，预算 16.6ms ≈ 60FPS 上限的 1/64）；500 元素首屏渲染 500 节点、交互增量 2 节点 | ✅（jsdom 口径） | Wave 3 备注；`packages/designer/src/canvas/__tests__/benchmark.test.tsx` |
| NFR-P-03 记忆检索（1000 条） | ≤200ms | 冷 7ms / 热 5ms（本次复测）；语义路退化提示 sqlite-vec 缺失时关键词路兜底 | ✅ | `packages/memory/src/search/__tests__/benchmark.test.ts`（Wave 2 实测冷 21ms/热 11ms） |
| NFR-P-04 上下文组装 | ≤300ms | 冷启动 5.9ms / 热 p95 5.9ms（1000 条记忆场景，jsdom/node 口径，不含网络与 tokenizer 精确计数） | ✅ | Wave 4 备注；`packages/ai/src/context/__tests__/` |
| NFR-P-05 内存占用（Tauri ≤300MB/1.2GB；Electron ≤500MB/2GB） | 双形态分别达标 | **待真实外壳**（见 §3）；容器层已实测流式读写 RSS 增长 77MB（1 万条目 500MB 数据，阈值 350MB）——"整包入内存"的实现会爆，流式实现已就位 | ⏳（部分证据） | Wave 8 备注；`packages/package-kit/src/__tests__/performance.test.ts` |
| NFR-P-06 重命名影响面（1 万行） | ≤1.5s | 207.8ms（3 次采样取最小值，空载）→ 按机器吞吐归一化 185.1ms；全量套件并行时原始 1584~2778ms，归一化后 475.64ms 仍远低于预算 | ✅ | Wave 7 备注；`packages/registry/src/__tests__/occurrence.test.ts`（含探针归一化方法） |
| NFR-P-07 重命名事务（≤200 处） | ≤5s | 2.4~11.7ms（200 处代码变更事务执行，含 1 处 Code Anchor 同步） | ✅ | Wave 7 备注；`packages/registry/src/__tests__/rename-transaction.test.ts` |
| NFR-P-08 `.ecpkg` 导出（1 万文件） | ≤60s | 8906ms（1 万 × 30KB，归档 2.0MB） | ✅ | Wave 8 备注；`packages/package-kit/src/__tests__/export-performance.test.ts` |
| NFR-P-08 `.ecpkg` 导入 | ≤90s | 读回 + 全量 SHA-256 校验 5216ms（1 万条目 × 50KB = 500MB 原始数据） | ✅ | Wave 8 备注；同上 |
| NFR-P-09 包体（Tauri ≤60MB / Electron ≤200MB） | 双形态分别达标 | **待安装包产出**（见 §3）：本机无 Rust 工具链、Electron 二进制被 pnpm 阻止下载；渲染层产物已实测（vite build 580 modules） | ⏳ | T10-04 配置就绪后实机复测 |

## 2. 本次 `pnpm perf` 复测数据

执行：`node --experimental-strip-types perf/run.ts`（2026-09-13，win32/x64，Node v24.20.0）。
原始输出归档于 `perf/last-run.md`。

| 基准 | 结果 | 提取耗时（本次实测） |
| --- | --- | --- |
| NFR-P-03 记忆检索 | PASS | 冷 7ms / 热 5ms |
| NFR-P-04 上下文组装 | PASS | 5.9ms（Wave 4 口径：冷/热 p95） |
| NFR-P-06 索引 + 影响面 | PASS | 3 次采样 230.06 / 200.47 / 211.17ms，取最小 200.47ms；机器吞吐探针 13.48~14.65ms，**归一化 297.43ms**（预算 1500ms） |
| NFR-P-07 重命名事务 | PASS | **2.58ms**（200 处代码变更执行；外部计时 2.76ms） |
| NFR-P-08 导出 1 万文件 | PASS | **7950ms**（归档 2.0MB，codeFiles=10000，预算 60s） |
| NFR-P-08 容器读写 + 校验 | PASS | 写 9.9s / 读+校验 5.2s / RSS +77MB（Wave 8 实测，预算 RSS ≤350MB） |
| NFR-P-02 画布 500 元素 | PASS | 首屏重渲染 500 节点；单选/加选/hover 增量均 2 节点；单帧吸附几何 0.26ms（Wave 3 实测） |

## 3. 未达标 / 待真实环境项与整改计划

| 项 | 现状 | 整改计划 |
| --- | --- | --- |
| NFR-P-01 冷启动 ≤5s | 无真实外壳实测 | 装好 Rust 工具链后 `cargo tauri build` 产出安装包，实机测冷启动（外壳加载 + SQLite 迁移 + 首屏渲染）；已具备的条件：迁移全套（0001~0005）在内存库实测毫秒级 |
| NFR-P-05 双形态内存 | 仅容器层 RSS 证据 | 安装包产出后用 Process Explorer / 任务管理器分别测 Tauri（WebView2 进程组）与 Electron（主+渲染+GPU 进程组）的空闲/大型项目两组数字 |
| NFR-P-09 包体 ≤60MB / ≤200MB | 打包配置（T10-04）就绪但未产出 | Tauri：`cargo tauri build` 后量 NSIS 产物；Electron：`electron-builder`（NSIS）后量；配置已按最小化裁剪（Tauri 无 Node 运行时；Electron asar + normal 压缩） |
| sqlite-vec 语义检索路 | 本机未装扩展，检索退化为关键词路（如实上报，不静默） | 部署真机时安装 sqlite-vec 扩展，`detectVec` 自动启用双路召回（Wave 2 已留运行时幂等建表） |

## 4. 优化手段落点（对应任务卡第 3 条）

- **虚拟列表**：`@ec/ui` List/Table/useVirtualList（1000 条 → 25 行 DOM，Wave 6 实测 87.3ms）；工作台网格用分页窗口 + `loading="lazy"` + 骨架屏（100 项目首屏 116.2ms，Wave 9）。
- **拖拽层隔离**：设计器 `useMemo` 自顶向下构建元素树 + 叶子 childrenContent 常量引用 + 根节点不做 memo 短路（Wave 3 修复记录），500 元素交互增量重渲染 2 节点。
- **SQLite 查询优化**：`usage-repo` 等热点查询走聚合 SQL（COUNT/SUM 一次往返）；重命名索引构建的分组与匹配在纯计算层完成。
- **流式 IO**：`.ecpkg` ZIP 写入 1MB 分块泵入 deflate、压缩块即写即落盘、读取端 central directory 常驻内存 + 条目级流式解压（Wave 8），1 万条目 500MB 数据 RSS 增长 77MB。
- **增量计算**：记忆写入 `WindowQueue` 过期清理、`.ecpkg` 增量包体积 = 全量的 4.0%（Wave 8）、undo 走 Immer patch 增量（100 次快照 23.6KB，较全量省 357KB，Wave 3）。
- **缓存**：上下文组装热路径 p95 5.9ms（Wave 4）；仪表盘聚合 20.8ms 含缓存（Wave 9）。
