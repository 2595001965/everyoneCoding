# EveryoneCoding 双形态打包、更新与分发（RELEASE）

> 对应 Wave 10 / T10-04，覆盖 D-01（双形态并存）与 FR-SET-05（自动更新）、NFR-P-09（包体体积）、NFR-C-02（系统兼容）。
> 本仓库以 **Apache License 2.0** 开源（见根目录 `LICENSE`）：源码公开发布，安装产物通过更新服务分发。

---

## 1. 版本号与更新通道（单一事实源）

**根 `package.json` 的 `version` 是唯一事实源**，其余五处由脚本生成：

| 位置                                                                    | 用途                    | 由谁写           |
| ----------------------------------------------------------------------- | ----------------------- | ---------------- |
| `package.json`（根）                                                    | 事实源                  | 人工 / `--set`   |
| `apps/desktop-tauri/package.json`                                       | Tauri 侧包版本          | `ci/version.mts` |
| `apps/desktop-electron/package.json`                                    | Electron 侧包版本       | `ci/version.mts` |
| `apps/desktop-tauri/src-tauri/tauri.conf.json`                          | 安装包/更新清单里的版本 | `ci/version.mts` |
| `apps/desktop-tauri/src-tauri/Cargo.toml`（`[package]`）                | Rust crate 版本         | `ci/version.mts` |
| `apps/desktop-electron/electron-builder.yml`（`extraMetadata.version`） | NSIS 产物版本           | `ci/version.mts` |

```bash
pnpm version:check                       # 校验五处一致；漂移则退出码 1（CI 门禁）
pnpm version:sync                        # 按根版本同步五处
node --experimental-strip-types ci/version.mts --set 0.2.0   # 改根版本并同步
```

> **为什么必须脚本化**：`tauri.conf.json` / `Cargo.toml` / `electron-builder.yml` 都不是 npm 生态文件，
> 无法用 workspace 协议共享版本；手改五处必然漂移，双形态就会各自打出不同版本的安装包。
> CI 的 `version-guard` job 在构建前先跑 `pnpm version:check`，漂移直接阻断发版。

**更新通道**：`stable`（仅正式版）与 `beta`（含预发布）。规则见
`packages/core/src/update/update-policy.ts` 的 `isChannelAcceptable()`——stable 渠道**永不接收**
带预发布标识的版本（`1.0.0-beta.1` 不会推给只收稳定版的用户）。通道同时作为更新服务 URL 的一段。

---

## 2. 双形态构建

```bash
pnpm build:renderer     # 两端共用的渲染层产物（apps/renderer/dist）

# 通道一：Tauri 2（Rust + 系统 WebView2）
pnpm build:tauri        # = cd apps/desktop-tauri && tauri build → NSIS + *.nsis.zip(+ .sig)

# 通道二：Electron（Node 主进程 + 内置 Chromium）
pnpm build:electron     # = cd apps/desktop-electron && electron-builder → NSIS
```

CI 定义见 `ci/release.yml`（可移植到 GitLab CE / Gitea Actions）：

```
version-guard ──┬── build-tauri    ──┐
                └── build-electron ──┴── release（合并产物 → 更新清单 + 分发页 + 体积门禁）
```

两个构建 job **并行**，任一形态构建失败不影响另一个形态的产物落盘；但 release 阶段缺任一形态的
安装包 = 发版失败。

**前置条件**

| 形态     | 需要                                                                                       |
| -------- | ------------------------------------------------------------------------------------------ |
| Tauri    | Rust 稳定工具链；`TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`（CI Secret）                    |
| Electron | 无需额外工具链；需允许 electron 二进制下载（`pnpm approve-builds` 或设 `ELECTRON_MIRROR`） |

**体积门禁（NFR-P-09）**：`ci/make-release.mts` 直接量产物并判定
—— Tauri ≤60MB、Electron ≤200MB，超限退出码 1，发版中止。

---

## 3. 更新机制

### 3.1 双形态各自的底层

|        | Tauri 2 版                                                                                   | Electron 版                                        |
| ------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 更新库 | `tauri-plugin-updater`                                                                       | `electron-updater`                                 |
| 完整性 | **minisign 签名**（`latest.json` 的 `signature`）                                            | **sha512**（`latest.yml`）                         |
| 更新包 | `*.nsis.zip`                                                                                 | 安装包本身（`*-setup.exe`）                        |
| 端点   | `…/{channel}/{{target}}/{{arch}}/{{current_version}}`（服务按当前版本决定返回 204 还是清单） | `…/{channel}/`（generic provider 读 `latest.yml`） |

### 3.2 minisign 密钥生成与替换（Tauri）

```bash
# 1) 生成密钥对（Tauri CLI 自带）
cd apps/desktop-tauri
pnpm tauri signer generate -w ~/.tauri/everyonecoding.key

# 2) 私钥进 CI Secret（绝不入库）：TAURI_SIGNING_PRIVATE_KEY = 私钥文件内容
#                            TAURI_SIGNING_PRIVATE_KEY_PASSWORD = 口令

# 3) 公钥写进 apps/desktop-tauri/src-tauri/tauri.conf.json 的 plugins.updater.pubkey
#    当前值是占位符 REPLACE_WITH_YOUR_TAURI_UPDATER_PUBLIC_KEY，发版前必须替换
```

> ⚠️ 当前 `tauri.conf.json` 的 `pubkey` 与更新端点域名仍是**占位值**；
> 未替换前**不要对外发版**（更新会因验签失败而全部被拒）。
> `bundle.createUpdaterArtifacts: true` 已开启，构建会同时产出 `.nsis.zip` 与 `.sig`。

### 3.3 更新流程（两形态行为等价，逻辑在 `@ec/core`）

实现在 `packages/core/src/update/`，两个外壳共用同一套决策与台账：

| 文件               | 职责                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| `update-types.ts`  | 版本号解析与语义化比较（含预发布规则）                                  |
| `update-policy.ts` | 静默检查节奏、渠道过滤、稍后提醒、自动下载 —— **纯函数**                |
| `update-ledger.ts` | 回滚台账（`pending-healthy → healthy / rolled-back / rollback-failed`） |
| `update-runner.ts` | `UpdateService`：把上述决策与外壳能力端口串成流程                       |

流程与验收项对应：

1. **启动静默检查** — 距上次检查不足间隔或离线时跳过，**不阻塞启动**（`decideCheck`）。
2. **发现新版本提示** — `remind`，携带更新说明。
3. **增量下载（显示进度）** — `install()` → 外壳 `downloadAndInstall()`，进度经 `onProgress` 推给设置页。
4. **重启后应用** — 阶段 `done` 时界面明确提示"重启后生效"（安装器完成替换，下次启动生效）。
5. **稍后 / 延迟更新** — `deferVersion()` 写冷却截止时间；窗口内不再提示，过期后重新提示；
   `allowDeferred=false` 时忽略延迟状态。切换到更新版本号会立刻重新提示。
6. **失败回滚到上一版本** — 见 §3.4。

### 3.4 更新失败回滚（两形态同口径）

**做了什么**：NSIS 安装钩子在**每次安装时**把自身安装包留档一份：

- Tauri：`apps/desktop-tauri/src-tauri/nsis/installer-hooks.nsh`（`NSIS_HOOK_POSTINSTALL`）
- Electron：`apps/desktop-electron/build/installer.nsh`（`customInstall`）
- 落点（两形态一致）：`%LOCALAPPDATA%\EveryoneCoding\updates\backup\<安装包文件名>`
  —— 文件名自带版本号（`EveryoneCoding_0.1.0_x64-setup.exe`），客户端按版本号精确匹配。

**判定与还原**（`UpdateService` + `UpdateLedger`）：

```
安装前：beginUpdate(from=当前版本, to=新版本, backup=当前版本的留档安装包)
安装后：markInstalled() → stage = pending-healthy
下次启动：recordBoot()
   ├─ 尝试次数 < 上限(2)  → allow（正常启动）
   ├─ 应用跑到可交互     → markHealthy() → 落定，此后不再计数
   └─ 尝试次数 ≥ 上限     → rollback：静默重跑留档安装包（NSIS /S）+ 重启
        ├─ 成功 → rolled-back（设置页显示"已回滚到 x.y.z"）
        └─ 失败 → rollback-failed（设置页要求用户手动重装，**不假装成功**）
没有留档（用户手动安装 / 数据目录被迁走）→ no-backup：如实提示无法自动回滚。
```

门槛默认 **2 次**（首次启动失败一次即回滚），可由 `maxBootAttempts` 调整。

---

## 4. 发布产物与更新清单

```bash
pnpm release:manifest -- \
  --dir release-artifacts \
  --base-url https://update.everyonecoding.com \
  --channel stable \
  --notes "EveryoneCoding v0.1.0"
```

产出四件：

| 文件                    | 用途                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `latest.json`           | Tauri Updater 的**响应体**（`version` / `notes` / `pub_date` / `platforms.windows-x86_64.{signature,url}`） |
| `latest.yml`            | electron-updater 清单（`files[].{url,sha512,size}` + `path`/`sha512`/`releaseDate`）                        |
| `release-manifest.json` | 双形态统一清单：版本、体积、sha512、下载 URL、通道端点、告警项                                              |
| `distribution.html`     | **分发页**：双形态并列下载 + 差异对比表                                                                     |

同时执行体积门禁并在 `release-manifest.json.warnings` 里如实记录缺失项
（缺安装包 / 缺 `.sig` → `latest.json` 的 `signature` 会写成占位符并给出告警）。

**更新服务路由约定**

- Tauri：`{base}/stable/{target}/{arch}/{current_version}` —— 服务比较请求里的
  `current_version` 与最新版本：不新则回 `204 No Content`，有新版本则返回 `latest.json` 内容。
- Electron：`{base}/stable/` —— 静态托管 `latest.yml` 与安装包即可（generic provider）。

---

## 5. 分发与选型建议

> 分发页由 `ci/make-release.mts` 生成（`distribution.html`），下面是同样的内容。

| 对比项                      | **Tauri 2 版（推荐）**                     | **Electron 版**                           |
| --------------------------- | ------------------------------------------ | ----------------------------------------- |
| 安装包预算 / 实测           | ≤60MB                                      | ≤200MB                                    |
| 内存预算（空闲 / 大型项目） | ≤300MB / ≤1.2GB                            | ≤500MB / ≤2GB                             |
| 运行时依赖                  | 系统 **WebView2**（安装器引导安装）        | 内置 Chromium + Node                      |
| 更新机制                    | Tauri Updater（minisign 签名）             | electron-updater（sha512 校验）           |
| 主要优势                    | 包体小、启动快、常驻内存低                 | 生态成熟、原生模块兼容性好                |
| 适合                        | 日常开发、长时间常驻                       | 需要特定原生依赖 / 团队已有 Electron 经验 |
| 功能范围                    | **完全等价**（同一套渲染层与领域包，D-01） | 同左                                      |

**系统要求**

| 项           | 要求                                                                |
| ------------ | ------------------------------------------------------------------- |
| 操作系统     | Windows 10 1809（Build 17763）及以上 / Windows 11                   |
| 架构         | x64（ARM64 为 P2 规划）                                             |
| Tauri 版额外 | WebView2 Runtime（Win11 与较新 Win10 已内置；缺失时安装器引导下载） |
| 磁盘         | 程序 ≤200MB + 本地数据目录（默认 `%LOCALAPPDATA%\EveryoneCoding`）  |
| 网络         | 仅 AI 请求与更新检查需要；**无云端同步**（D-02），离线可用          |

**回滚方法（用户视角）**

1. 自动：新版本启动失败达阈值时，客户端自动重跑留档安装包并回到上一版本，设置页「更新」类目会显示"已回滚到 x.y.z"。
2. 手动：设置页显示"自动回滚未成功"时，到 `%LOCALAPPDATA%\EveryoneCoding\updates\backup\`
   双击上一版本的安装包重装即可（该目录由安装器留档，卸载不清理）。

**更新失败排查**

| 现象                                          | 原因                          | 处理                                                                |
| --------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| 一直提示"已是最新版本"但实际上有新版（Tauri） | `pubkey` 仍是占位符，验签失败 | 替换 `tauri.conf.json` 的 `plugins.updater.pubkey`                  |
| electron-updater 报 `sha512 mismatch`         | 更新包被改 / 上传不完整       | 用 `release-manifest.json` 的 sha512 重新上传                       |
| 设置页提示"没有可用备份，无法自动回滚"        | 留档目录没有当前版本的安装包  | 手动重装上一版本；确认 NSIS 钩子生效（T10-04 后新装的版本才有留档） |

---

## 6. 本机无法验证的部分（如实列出，不粉饰）

| 项                                  | 现状                                                                                                                   | 需要什么                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 两种安装包实际产出与体积实测        | **未产出**：本机无 Rust 工具链，且 Electron 二进制被 pnpm 阻止下载                                                     | 装 Rust + 允许 electron 下载；随后 `pnpm build:tauri` / `pnpm build:electron` + `pnpm release:manifest` |
| Tauri `cargo clippy` 零 warning     | 未跑（无 Rust）                                                                                                        | CI 的 `clippy` job 已配置 `-D warnings`                                                                 |
| minisign 密钥生成与验签             | 未跑（无 Rust CLI）                                                                                                    | `pnpm tauri signer generate`，见 §3.2                                                                   |
| 冷启动 ≤5s、双形态内存占用          | 未测（无安装包）                                                                                                       | 安装后按 `docs/PERF-REPORT.md` §3 的方法测                                                              |
| 实机更新流程（检出→下载→应用→回滚） | 逻辑层已用真实 `UpdateService` + 内存外壳端口跑通（`update-shell-ports.test.ts` 端到端用例），**未在真实安装包上跑过** | 打包后按 §3.4 走一遍崩溃注入                                                                            |
| NSIS 留档钩子的实际生效             | 脚本已就位，未在真实 NSIS 编译中执行过                                                                                 | 首次打包后检查 `%LOCALAPPDATA%\EveryoneCoding\updates\backup\` 是否有留档                               |
