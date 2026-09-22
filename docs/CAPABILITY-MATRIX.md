# EveryoneCoding 双形态能力矩阵（CAPABILITY-MATRIX）

> 对应 D-01「Tauri 2 与 Electron 双形态并存，功能层通过外壳抽象隔离，**两版功能等价**」。
> 本文件是**唯一的能力事实源**：每一条都指向代码里的判据，不靠人记。
> 关联：`docs/ACCEPTANCE-REPORT.md`（验收证据）、`docs/RELEASE.md`（打包分发）、
> `docs/DEV-SETUP.md`（工具链前置）。

---

## 0. 怎么自己拿到最新答案（别读文档，去问程序）

三条命令，任选：

```bash
# ① 渲染层视角：外壳能力 + 缺失原因（ShellCapabilities.reasons）
#    在应用内打开 DevTools 执行：
await (await window.__EC_SHELL__).capabilities()      # 端口注入后可直接取

# ② 域装配视角：15 个域逐个可用性与原因
await (await window.__EC_SHELL__).domain.describe()

# ③ Tauri 形态的侧车诊断（Rust 命令）：就绪状态 + 产物/Node 位置 + 协议版本
```

第 ③ 条在 Tauri 形态下对应 `sidecar_status` 命令；它同时返回侧车入口与 Node 运行时的
实际路径，是排"侧车起不来"的第一现场。

**纪律**：任何能力为 `false` 时都必须带**真实原因**（`ShellCapabilities.reasons` /
`DomainDescriptor.reason`）。不带原因的 `false` 视为缺陷——用户无从判断是"还没做"、
"这台机器缺东西"还是"自己关掉了"。

---

## 1. 外壳级能力

| 能力           | Electron | Tauri 2 | Tauri 实现落点                                          | 说明                                                      |
| -------------- | -------- | ------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `fs`           | ✅       | ✅      | `commands/fs.rs`                                        | 含原子写（临时文件 → fsync → rename）                     |
| `watch`        | ✅       | ✅      | `commands/fs.rs` 轮询线程 + Channel                     | 轮询而非 `fs.watch`：见 `commands/fs.rs` 文件头           |
| `process`      | ✅       | ✅      | `commands/process.rs`                                   | 通用子进程端口（渲染层直连）                              |
| `dialog`       | ✅       | ✅      | `commands/dialog.rs`（tauri-plugin-dialog）             |                                                           |
| `window`       | ✅       | ✅      | `commands/window.rs`                                    |                                                           |
| `secureStore`  | ✅       | ✅      | `commands/secure_store.rs`（DPAPI，当前用户上下文）     | 磁盘上只有密文；不可用时**拒绝**而不是落明文              |
| `updater`      | ✅       | ✅      | `commands/updater.rs`（tauri-plugin-updater，minisign） | 需先替换 `tauri.conf.json` 的 `pubkey`（见 RELEASE §3.2） |
| `net`          | ✅       | ✅      | `commands/net.rs`（host 白名单）                        | 白名单外一律 `NET_BLOCKED`                                |
| `clipboard`    | ✅       | ✅      | `commands/clipboard.rs`                                 |                                                           |
| `openExternal` | ✅       | ✅      | `commands/external.rs`                                  | 仅放行 http/https/mailto（防 cmd 注入）                   |
| `ai`           | ✅       | ✅      | **侧车**（`@ec/ai` 真实栈）→ `commands/ai.rs` 搬运      | 见 §3                                                     |
| `domain`       | ✅       | ✅      | **侧车**（15 个域运行时）→ `commands/domain.rs` 搬运    | 见 §2                                                     |

---

## 2. 领域端口（15 个域）

两形态**共用同一份领域实现**：Electron 直接跑在 Node 主进程里；Tauri 把同一份代码放进
**受控侧车**（`apps/desktop-electron/src/sidecar/`），由 Rust 负责生命周期与协议搬运。

```text
Electron:  渲染层 → preload → ipcMain → domain-runtime（Node 主进程）
Tauri:     渲染层 → invoke  → Rust   → NDJSON → 侧车（同一个 domain-runtime）
```

| 域           | Electron | Tauri | 备注                                                                 |
| ------------ | -------- | ----- | -------------------------------------------------------------------- |
| `workspace`  | ✅       | ✅    | 19 个方法全通（含从 Git 导入的三阶段进度事件）                       |
| `docs`       | ✅       | ✅    | 20 个方法全通                                                        |
| `auth`       | ✅       | ✅    | **前置**：须宿主 DPAPI 可用，否则整个域不装配并给出原因              |
| `settings`   | ✅       | ✅    | 16 个方法全通                                                        |
| `memory`     | ✅       | ✅    | 异步口全通；**同步签名端口见 §2.1**                                  |
| `pipeline`   | ✅       | ✅    | 同上                                                                 |
| `git`        | ✅       | ✅    | 凭据类方法前置同 `auth`；AI 类方法前置同 §3                          |
| `preview`    | ✅       | ✅    | 后端托管经受控进程端口，`cwd` 必须落在工程根内（否则 `PATH_ESCAPE`） |
| `rename`     | ✅       | ✅    |                                                                      |
| `package`    | ✅       | ✅    | 归档 / 备份 / 快照；`.ecpkg` 平坦布局与命名规范两形态一致            |
| `usage`      | ✅       | ✅    | 预算变更即时回灌运行中的网关                                         |
| `ai-context` | ✅       | ✅    | 四源组装（memory / notes / documents / code）                        |
| `code`       | ✅       | ✅    | 写入只有一条路：`plan → preview → apply`                             |
| `nav`        | ✅       | ✅    | 跳转 / 反查 / 关系图                                                 |
| `designer`   | ✅       | ✅    | PageDSL；`createPage` 走 `@ec/designer/dsl` 的 `createEmptyPage`     |

### 2.1 唯一的结构性差异：同步签名端口（memory / pipeline）

`MemoryApi` 与 `PipelineApi` 是**同步签名**端口，消费方在 `advance()` 之后**立刻同步**
读 `snapshot()`。Electron 用 `ipcRenderer.sendSync` 承载（`ec:domain:invokeSync`）。

**Tauri 形态不提供该能力**，且这是如实的选择而非缺口：

1. Tauri 的渲染层**没有同步 IPC 原语**（`invoke` 只有异步形态）；
2. 用异步往返假装同步 = 写入后立刻读会拿到**上一拍**的数据，属于伪造状态；
3. 在 JS 侧维护一份"同步镜像"同样是把非权威副本当权威用。

因此渲染层的行为是：**这两个端口不注入**，对应页面保留如实的装配引导
（`production-ports.ts` 的 `createDomainSyncCaller` 在宿主持有 `invokeSync` 时才注入）。
两个域本身在 Tauri 下**完全可用**，走的是异步 `domain.invoke`。

> 换句话说：受影响的是「记忆中心 / 流水线页的**同步调用方式**」，不是这两个域的功能。

---

## 3. AI 侧能力

AI 栈**不在 Rust 里重写**：它随侧车一起跑，Rust 只提供服务：

| 能力                             | 状态 | 落点 / 前置                                                                                                       |
| -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| Provider 增删改查 / 排序         | ✅   | `@ec/ai` 的 control 层；`ai.invoke` 的 32 个方法白名单                                                            |
| Model 列表 / 能力矩阵 / 手动补充 | ✅   | 同上                                                                                                              |
| **DPAPI 安全存储**（Key 落盘）   | ✅   | 侧车经宿主能力 `secure.encrypt` / `secure.decrypt` 用 **Rust 侧同一份 DPAPI**；不可用时 AI 栈整体不装配并给出原因 |
| 流式生成                         | ✅   | `ai.stream.start` + 侧车事件总线（`op = "ai.stream"`），按 `requestId` 分流                                       |
| usage / budget                   | ✅   | 预算两端共用 `setting.usage_budget` 落点；`setBudget` 落库并经 `onBudgetChanged` 即时回灌网关                     |
| 远程配置（D-06 用户自配）        | ✅   | `remoteSource` 系列方法                                                                                           |
| WritePipeline                    | ✅   | `code.plan / apply` + 已登记的 `code:write-plan` 域事件                                                           |

**无能力时必须 negotiate 为 false 并给出理由**（本轮的硬要求）：

- `ShellCapabilities.ai` / `.domain` 由 `sidecar_status` 的**真实装配结果**决定，
  不再写死；缺失原因经新增的 `ShellCapabilities.reasons` 回传渲染层；
- AI 未装配时 `ai.invoke` 回结构化 `NOT_SUPPORTED` + 原因；
  `ai.stream` **补发 `error` + `done`**（只回 `accepted:false` 会让界面永远转圈）。

---

## 4. 仍受外部工具链 / 环境限制的功能（如实列出，不粉饰）

| 项                                     | 现状                                                                                                                                           | 需要什么                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Tauri 安装包产出与体积实测             | **未产出**：`cargo check / clippy / test` 已可跑（Rust 1.98.1 就位），但 Tauri 官方只支持 MSVC linker，本机无管理员权限装 C++ 生成工具（L-09） | 管理员身份装 MSVC C++ 生成工具（`scripts/setup-rust-tauri.ps1`），再 `pnpm build:tauri`                                    |
| 侧车随包分发（发行形态）               | **未做**：开发期侧车用系统 PATH 上的 `node`；发行包需把 `node.exe` + `dist/sidecar/**` 一起打进 resources                                      | 在 `tauri.conf.json` 的 `bundle.resources` 增加侧车产物与 `node.exe`；侧车目录放 `node.exe` 即被优先采用（`resolve_node`） |
| 侧车与 Node 的 ABI 绑定                | 未实测发行形态：`better-sqlite3` 的 Node 侧绑定按 **Node 24 / ABI 137** 构建；随包分发的 `node.exe` 必须是同一 ABI 大版本                      | 分发 Node ≥24（或按分发版本重建绑定，`prepare:native`）                                                                    |
| Tauri 实机 GUI 冒烟（窗口 / 首屏）     | **未执行**：本机为无人值守会话，无真实桌面交互                                                                                                 | 需一次人工走查：启动 → 建项目 → 打开设计器 → 预览                                                                          |
| 冷启动 ≤5s / 双形态内存（NFR-P-01/05） | **未实测**：需安装包 + 真实桌面会话                                                                                                            | 见 `docs/PERF-REPORT.md §3`                                                                                                |
| 真机 OAuth / 邮箱链接验证              | **未执行**：需真实第三方应用凭据与服务端邮件投递能力                                                                                           | 见 `docs/E2E-CHECKLIST.md M-02`；邮箱验证需扩展 `services/account`                                                         |
| 真机多端代码编译（Flutter / hvigor）   | **未执行**：本机无三套工具链                                                                                                                   | 见 `docs/E2E-CHECKLIST.md M-04`                                                                                            |

> 判定口径与验收报告一致：这些属于「环境缺失导致未能执行」，与「功能未实现」是两件事。

---

## 5. 自助复核命令

```bash
export PATH="/c/Users/f2595/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/f2595/.cargo/bin:$PATH"
cd /d/code/program/everyoneCoding

# 侧车产物（Tauri 形态的业务运行时）
node apps/desktop-electron/scripts/build-sidecar.mjs

# Rust 门禁
cd apps/desktop-tauri/src-tauri
cargo check
cargo clippy --all-targets -- -D warnings
cargo test            # 含对真实侧车进程的活体握手用例

# 侧车与四域端到端（Node 侧）
cd /d/code/program/everyoneCoding
"$NODE24" node_modules/vitest/vitest.mjs run apps/desktop-electron/src/sidecar
"$NODE24" node_modules/vitest/vitest.mjs run apps/desktop-tauri
```
