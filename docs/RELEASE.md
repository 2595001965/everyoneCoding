# EveryoneCoding 双形态打包、更新与分发（RELEASE）

> 对应 Wave 10 / T10-04，覆盖 D-01（双形态并存）与 FR-SET-05（自动更新）、NFR-P-09（包体体积）、NFR-C-02（系统兼容）。
> 本仓库以 **Apache License 2.0** 开源（见根目录 `LICENSE`）：源码公开发布，安装产物经本仓库 GitHub Releases 分发。

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

**更新通道**：`stable`（仅正式版）与 `beta`（含预发布）。客户端规则见
`packages/core/src/update/update-policy.ts` 的 `isChannelAcceptable()`——stable 渠道**永不接收**
带预发布标识的版本。发布侧：beta 发成 GitHub **prerelease**，而两种客户端的默认更新源都只读
"latest release"（不含 prerelease），stable 用户天然收不到。

---

## 2. 双形态构建

```bash
pnpm build:renderer     # 两端共用的渲染层产物（apps/renderer/dist）

# 通道一：Tauri 2（Rust + 系统 WebView2）——需要签名私钥（§3.2）
pnpm build:tauri        # → EveryoneCoding_<v>_x64-setup.exe + .exe.sig

# 通道二：Electron（Node 主进程 + 内置 Chromium）
pnpm build:electron     # → EveryoneCoding-<v>-x64-setup.exe + .exe.blockmap（--publish never，打包绝不自动上传）
```

CI 定义见 `ci/release.yml`：

```
version-guard ──┬── build-tauri    ──┐
                └── build-electron ──┴── release（合并产物 → 清单 + 体积/签名门禁 → GitHub Release）
```

**前置条件**

| 形态     | 需要                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| Tauri    | Rust 稳定工具链（MSVC 官方；本机无管理员时可用 `apps/desktop-tauri/scripts/setup-rust-tauri-gnu.ps1`）；签名私钥 |
| Electron | 允许 electron 二进制下载；代码签名证书可选（§3.2）                                                               |

**体积门禁（NFR-P-09）**：`ci/make-release.mts` 直接量产物 —— Tauri ≤60MB、Electron ≤200MB，超限退出码 1。
本机实测见 §6.1。

---

## 3. 更新机制

### 3.1 双形态各自的底层

|            | Tauri 2 版                                                                          | Electron 版                                                          |
| ---------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 更新库     | `tauri-plugin-updater` 2.11（`commands/updater.rs`）                                | `electron-updater` 6.8 `NsisUpdater`（`main/updater/`）              |
| 完整性     | **minisign 签名**（`latest.json` 的 `signature`，公钥在 conf 里）                   | **sha512**（`latest.yml`）+ 配了证书时的 **Authenticode 发布者校验** |
| 更新包     | 安装包本身 `*-setup.exe`（整包下载，流式进度）                                      | 安装包本身 `*-setup.exe`，**blockmap 差分**（只拉变化的块）          |
| 默认更新源 | `https://github.com/2595001965/everyoneCoding/releases/latest/download/latest.json` | GitHub provider：同仓库最新 release 的 `latest.yml`                  |
| 运行时覆盖 | `EC_UPDATE_URL=<…/latest.json>`（**公钥不可覆盖**；正式包仍只允许 https）           | `EC_UPDATE_URL=<目录 URL>`（generic provider）                       |
| 安装方式   | NSIS 被动模式 `/P /R`（显示进度、装完重启）                                         | NSIS 静默 `/S --force-run`（装完重启）                               |

**`EC_UPDATE_URL` 必须设成用户 / 系统环境变量**（企业内网镜像场景）：两种 NSIS 安装器装完都是经
Shell 以当前用户身份重新拉起应用的，只设在启动进程上的环境变量**传不到重启后的新版本**（实测）。

**增量下载只在 Electron 形态有**：`tauri-plugin-updater` 不支持差分，Tauri 包本身只有 ~8MB，整包下载。
Electron 差分的前提是本机有"当前版本安装包"：electron-builder 的 NSIS 安装时会把自身存为
`%LOCALAPPDATA%\@ecdesktop-electron-updater\installer.exe`；旧版 `.blockmap` 从上一个 release 取。
拿不到任一样时 electron-updater 自动回退整包（日志与面板文案如实写明）。实测 4MB 包改 64KB 时只下载 76KB。

两个 Electron 专门处理（都有测试）：

- 差分用**单区间请求**：多区间请求时 electron-updater 不报进度，面板会停在 0%；
- **停滞看门狗**：60s 无任何进度即取消并报网络错误——实测连接在传输中途被掐断时，
  electron-updater 的管道既不报错也不结束，会永远挂住。

### 3.2 签名密钥（私钥绝不入库）

**Tauri minisign（必需）**

- 公钥已写入 `apps/desktop-tauri/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`（key id `46cf733cc8c4250d`）。
- 私钥于 2026-09-30 在开发机生成，位于 `%USERPROFILE%\.tauri\everyonecoding-updater.key`，
  口令在同目录 `everyonecoding-updater.key.password`。**必须**：
  1. 把两者存进 CI Secret：`TAURI_SIGNING_PRIVATE_KEY`（文件内容）/ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；
  2. 离线备份（密码管理器 / 保险柜）后，按团队策略删除开发机上的副本。
     **私钥丢失 = 已装客户端再也收不到更新**（只能让用户手动重装带新公钥的版本）。
- 轮换：`pnpm --filter @ec/desktop-tauri exec tauri signer generate -w <路径> -p <口令>` →
  替换 conf 里的 pubkey 发一个过渡版（仍用旧私钥签）→ 之后的版本改用新私钥。
- 本地打包：`TAURI_SIGNING_PRIVATE_KEY="$(cat …key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat …password)" pnpm build:tauri`。

**Windows 代码签名（Electron 可选、强烈建议）**

- CI Secret `WIN_CSC_LINK`（.pfx 的 base64）/ `WIN_CSC_KEY_PASSWORD`。electron-builder 读到即签名，
  并把证书发布者写进 `app-update.yml` 的 `publisherName`——此后客户端会拒绝发布者不符的更新包
  （`ERR_UPDATER_INVALID_SIGNATURE`，本机已用真实 Authenticode 校验测过拒绝路径）。
- 未配置时产出未签名包：可以更新（sha512 兜底），但 SmartScreen 会拦首次安装。
- Tauri 安装包同样可以 Authenticode 签名（`bundle.windows.certificateThumbprint` / `signCommand`），当前未配置。

### 3.3 更新流程（两形态行为等价，编排在 `@ec/core`）

| 文件                                                        | 职责                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/core/src/update/update-policy.ts`                 | 静默检查节奏、渠道过滤、稍后提醒、自动下载 —— 纯函数                             |
| `packages/core/src/update/update-ledger.ts`                 | 回滚台账（`pending-healthy → healthy / rolling-back → rolled-back …`）           |
| `packages/core/src/update/update-runner.ts`                 | `UpdateService`：下载 → 落盘台账 → 安装重启；启动核对与回滚                      |
| `packages/core/src/update/update-errors.ts`                 | 失败归类：`offline / network / signature / integrity / not-configured / install` |
| `apps/renderer/src/runtime/update-runtime.ts`               | 装配到真实外壳，注入 `__EC_UPDATE__`（设置页「更新」类目）                       |
| `apps/renderer/src/features/settings/update-shell-ports.ts` | 外壳端口：留档定位、静默重装、状态落盘                                           |

外壳契约（`@ec/shell-api` 的 `UpdaterApi`）拆成三步：`check()` / `download()`（下载 + 校验，不安装）/
`installAndRestart()`。**拆开的原因**：安装器会结束当前进程（Tauri 插件直接 `exit(0)`），
"待确认"台账必须在那之前落盘，否则新版本启动即崩时无从回滚——旧实现正是在安装之后才写台账。

1. **启动**：首屏之前 `bootstrap({ skipCheck: true })`——先按实际运行版本核对上一轮收尾，再计一次启动、判定是否回滚；
   首屏之后才发起网络检查（离线 / 慢网不拖首屏）。联网恢复（`online` 事件）时补查一次。
2. **发现新版本**：面板显示版本与更新说明；「稍后提醒」写冷却截止时间。
3. **下载**：进度（Electron 另说明差分实际下载量）实时推到面板；失败按类别给出一句话 + 可展开的原始原因，**台账不动**。
   开了「自动下载」时只下载到 `ready`，由用户点「重启并更新」，绝不在用户工作时强行重启。
4. **安装并重启**：定位留档 → 台账记 `pending-healthy` 并落盘 → 交给安装器；安装器拉不起来则记 `install-failed`，当前版本照常可用。
5. **新版本启动**：稳定运行 15s 后 `markHealthy()` 落定。重启后仍是旧版本（安装器被取消）→ 核对为 `install-failed`，不计崩溃。
6. **离线**：系统报离线时不检查、不下载，面板提示且禁用按钮；网络错误与离线分开归类。

### 3.4 更新失败回滚（两形态同口径）

**留档**：NSIS 钩子在每次安装后把自身以**规范文件名**复制到固定目录（两形态分目录，互不顶替）：

| 形态     | 钩子                                                    | 留档                                                                              |
| -------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Tauri    | `apps/desktop-tauri/src-tauri/nsis/installer-hooks.nsh` | `%LOCALAPPDATA%\EveryoneCoding-updates\tauri\EveryoneCoding_<v>_x64-setup.exe`    |
| Electron | `apps/desktop-electron/build/installer.nsh`             | `%LOCALAPPDATA%\EveryoneCoding-updates\electron\EveryoneCoding-<v>-x64-setup.exe` |

目录由外壳经 `AppInfo.updateBackupDir` 报给渲染层。为什么这样定：
① Tauri 经 updater 安装时安装包是临时目录里的随机名，沿用原名就匹配不到版本；
② `%LOCALAPPDATA%\EveryoneCoding` 正是 Tauri 当前用户安装的默认安装目录；
③ 两形态同版本号的安装包放一起时按版本匹配会拿错形态。
（此前 `build/installer.nsh` 被 `.gitignore` 的 `build/` 规则吞掉、从未入库，Electron 打包会直接失败——已反选入库。）

**判定与还原**：

```
安装前：定位 fromVersion 的留档 → 台账 pending-healthy（落盘）→ 安装器重启
新版启动：reconcile（运行的仍是 fromVersion ⇒ install-failed）→ recordBoot
   ├─ 次数 < 2 → 放行；稳定运行后 markHealthy → healthy
   └─ 次数 ≥ 2 → 台账 rolling-back（落盘）→ 静默重跑留档安装包（Tauri /S /R，Electron /S --force-run）
下次启动：reconcile —— 运行的是 fromVersion ⇒ rolled-back；仍是 toVersion ⇒ rollback-failed（面板要求手动重装）
没有留档 → no-backup：如实提示无法自动回滚。
```

回滚结果一律由**下一次启动按实际版本**判定——安装器会结束当前进程，"事后再写已回滚"可能永远写不进去。

留档安装包经 `powershell Start-Process` **独立**拉起，而不是外壳的 `process.spawn`：外壳 spawn 的子进程
随应用退出被一并清理，而安装器第一件事就是请应用退出——应用退出时顺手杀掉安装器，回滚永远完成不了
（真实安装包演练中实测踩到）。

Tauri 钩子另有 `NSIS_HOOK_PREINSTALL`：覆盖文件前等主程序 exe 可写（最多 30 秒）。实测应用进程消失后
exe 仍被锁约 5 秒，被动安装器恰好在这段时间写文件，会停在"无法打开要写入的文件"的重试对话框上。

---

## 4. 发布产物与更新清单

```bash
pnpm release:manifest -- --dir release-artifacts --strict --notes "EveryoneCoding v0.2.0"
#   --base-url 缺省 https://github.com/2595001965/everyoneCoding/releases/download/v<版本>
#   --version   缺省根 package.json；本地演练用 --base-url http://127.0.0.1:<端口>
```

发布目录是**扁平**的，原样作为 GitHub Release 附件，或原样挂到任意静态服务器：

| 文件                                          | 用途                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `EveryoneCoding_<v>_x64-setup.exe(.sig)`      | Tauri 安装包 = 更新包 + minisign 签名                              |
| `EveryoneCoding-<v>-x64-setup.exe(.blockmap)` | Electron 安装包 = 更新包 + 差分块表                                |
| `latest.json`                                 | Tauri 静态端点（`windows-x86_64-nsis` 与 `windows-x86_64` 两个键） |
| `latest.yml`                                  | electron-updater 清单（sha512 / size）                             |
| `release-manifest.json`                       | 双形态统一清单：体积、sha512、URL、**签名校验结论**、告警与问题    |
| `distribution.html`                           | 分发页（双形态并列下载 + 差异对比）                                |

**门禁**（任一不过退出码 1）：体积（NFR-P-09）；`.sig` 必须能用 `tauri.conf.json` 的公钥验过
（`ci/minisign.mts`，与客户端同格式，已对真实 Tauri 签名交叉验证）——签错的包客户端会全部拒装，
在发布前拦下；`--strict` 下两种安装包 / `.sig` / `.blockmap` 缺一不可。产物按版本号精确选取
（发布目录会累积历史版本）。

---

## 5. 分发与排查

| 对比项                      | **Tauri 2 版（推荐）**                     | **Electron 版**                        |
| --------------------------- | ------------------------------------------ | -------------------------------------- |
| 安装包预算 / 本机实测       | ≤60MB / 见 §6.1                            | ≤200MB / 见 §6.1                       |
| 内存预算（空闲 / 大型项目） | ≤300MB / ≤1.2GB                            | ≤500MB / ≤2GB                          |
| 运行时依赖                  | 系统 **WebView2**（安装器引导安装）        | 内置 Chromium + Node                   |
| 更新机制                    | minisign 签名、整包                        | sha512（+Authenticode）、blockmap 差分 |
| 功能范围                    | **完全等价**（同一套渲染层与领域包，D-01） | 同左                                   |

**系统要求**：Windows 10 1809+ / Windows 11，x64；Tauri 版需 WebView2；网络仅 AI 请求与更新检查需要（D-02）。

**回滚（用户视角）**：自动回滚后设置页「更新」显示"已回滚到 x.y.z"；显示"自动回滚未成功"时，
到 §3.4 表里的留档目录双击上一版本安装包重装（卸载不清理该目录）。

**更新失败排查**（面板里的"失败详情"即原始原因）

| 面板提示 / 现象              | 原因                                                     | 处理                                                                      |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| 更新包签名校验失败（Tauri）  | 签名私钥与 conf 公钥不配套 / 包被改                      | 发布前 `make-release` 会拦；已发出则重新签名上传                          |
| 更新包校验不一致（Electron） | 半包 / 上传不完整 / 被改（sha512 不符）                  | 用 `release-manifest.json` 的 sha512 核对后重传                           |
| 发布者校验失败（Electron）   | 证书换了发布者名                                         | 过渡版里保留旧 publisherName（electron-builder `win.publisherName` 数组） |
| 无法连接更新服务或下载中断   | 源不可达 / 5xx / 连接被掐断（看门狗 60s）                | 检查网络与 GitHub 可达性；企业内网用 `EC_UPDATE_URL` 指向镜像             |
| 未配置更新源或更新公钥       | 开发期未打包、未设 `EC_UPDATE_URL`；或正式包配了 http 源 | 正常现象 / 改用 https                                                     |
| 没有可用备份，无法自动回滚   | 留档目录没有当前版本（手动删了 / 钩子前的旧安装）        | 手动重装上一版本                                                          |

---

## 6. 本机验证与本机无法完成的步骤

### 6.1 本机实测（2026-09-30）

**产物**（`ci/make-release.mts --strict` 实跑通过：体积门禁 + 真实 `.sig` 用仓库公钥验签通过）

| 产物                                                                         | 体积     | 预算   | 备注                                                     |
| ---------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------- |
| `EveryoneCoding_0.1.x_x64-setup.exe`                                         | 8.41 MB  | ≤60MB  | Tauri NSIS，minisign 签名（key `46cf733cc8c4250d`）      |
| `EveryoneCoding-0.1.x-x64-setup.exe`                                         | 82.94 MB | ≤200MB | Electron NSIS + `.blockmap`，未做 Authenticode（无证书） |
| `latest.json` / `latest.yml` / `release-manifest.json` / `distribution.html` | —        | —      | 由 make-release 生成                                     |

**自动化测试**

| 范围                                 | 用例                                                                                                                                                                             | 结果        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `@ec/core` 更新编排 / 台账 / 归类    | `packages/core/src/update/__tests__/*`：下载阶段验签失败 / 半包 / 网络中断台账不动；安装器失败；重启仍旧版；回滚落定与失败                                                       | 62 / 62     |
| Electron × **真实 electron-updater** | `apps/desktop-electron/src/main/updater/__tests__/electron-updater-host.test.ts`：本机 HTTP 源上的差分下载、整包回退、半包、中途断连、篡改、Authenticode 签名拒绝、源不可达、5xx | 11 / 11     |
| 渲染层装配 / 面板 / 外壳端口         | `apps/renderer/src/features/settings/__tests__/update-*.test.*`                                                                                                                  | 44 / 44     |
| 发布产物 / minisign / 更新源         | `e2e/update/e2e-25-release-artifacts.test.ts`（`pnpm test:e2e`）                                                                                                                 | 12 / 12     |
| 回归（core / shell-api / 三个 app）  | `vitest run packages/core packages/shell-api apps/desktop-electron apps/desktop-tauri apps/renderer`                                                                             | 1173 / 1173 |

另：`pnpm -r typecheck`、`pnpm lint`（0 warning）、`cargo clippy --all-targets -D warnings` 均通过。

**真实安装包演练**（§6.2 的脚本，0.1.0 → 0.1.1，本地静态源；两种形态各 5 个场景）

| 场景      | Electron                                                     | Tauri                                                      |
| --------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| happy     | ✅ 检查→差分下载→sha512→静默安装→重启，新版 allow 并落定健康 | ✅ 检查→下载→minisign→被动安装→重启，新版 allow 并落定健康 |
| rollback  | ✅ 新版两次未落定 → 重跑留档 0.1.0 → 启动确认 rolled-back    | ✅ 同左                                                    |
| signature | ✅ 每个区间被篡改 → integrity，未安装                        | ✅ latest.json 给错签名 → signature，未安装                |
| truncate  | ✅ 服务器上是半包 → integrity，未安装                        | ✅ 半包 → signature（验签失败），未安装                    |
| network   | ✅ 源不可达 → check-failed/network                           | ✅ 同左                                                    |

演练中实测踩出并已修掉的问题（都属于"只有真实安装包才会暴露"）：

1. 回滚安装包被应用退出时的子进程清理一并杀掉 → 改为 `Start-Process` 独立拉起（§3.4）；
2. Tauri：插件 `on_before_exit` 钩子里 `block_on` panic，IPC 断开后前端改走 postMessage **重发同一命令**，
   第二次拿不到待装包 → 改为在命令里 `.await` 收尾侧车、`spawn_blocking` 跑安装；
3. Tauri：应用退出后主程序 exe 仍被锁 ~5 秒，被动安装器写文件失败停在"重试"对话框 → NSIS
   `NSIS_HOOK_PREINSTALL` 等待 exe 可写（最多 30 秒）；
4. 两种安装器都经 Shell 以当前用户重新拉起应用，进程级环境变量传不到重启后的新版本（§3.1）；
5. 两形态同版本号留档混放会拿错形态的安装包 → 分目录 + 只认本形态命名；
6. 本机 GNU+Zig 工具链出的 Tauri 包缺 `WebView2Loader.dll`（MSVC 官方构建不涉及，§6.2）。

### 6.2 本地静态源演练（真实安装包，旧版 → 新版）

```bash
# 1) 双形态各打两个版本（Tauri 用"演练构建"：临时合并 http 放行，正式配置不含它）
node --experimental-strip-types ci/version.mts --set 0.1.0   # 然后 build:electron / build:tauri（见下）
node --experimental-strip-types ci/version.mts --set 0.1.1   # 再打一遍
#    Tauri 演练构建：pnpm --filter @ec/desktop-tauri exec tauri build --ci \
#      --config '{"plugins":{"updater":{"dangerousInsecureTransportProtocol":true}}}'
#    本机若用的是 GNU + Zig 非官方工具链（setup-rust-tauri-gnu.ps1），还必须把 WebView2Loader.dll 打进包：
#    GNU 目标动态加载它（MSVC 静态链接，不需要），NSIS 不会自动带上，装好的程序启动即报
#    0xC0000135（STATUS_DLL_NOT_FOUND）。做法：把 target/release/WebView2Loader.dll 复制到
#    src-tauri/target/e2e/（已被 .gitignore 忽略），再在 --config 里合并
#      "bundle":{"resources":{"../../../LICENSE":"LICENSE","../../../NOTICE":"NOTICE","target/e2e/WebView2Loader.dll":"WebView2Loader.dll"}}
#    （resources 只认相对 src-tauri 的路径，写 C:/ 绝对路径会被当成相对路径拼坏）
#    把四个安装包（及 .sig / .blockmap）放进同一个 artifacts 目录；最后 --set 回原版本，
#    并 git checkout Cargo.lock（构建会把 crate 版本写进锁文件）、prettier 格式化 tauri.conf.json
#    （version.mts 重写该文件时不保留 prettier 格式）
# 2) 演练
node --experimental-strip-types e2e/update/run-installed-update.mts --artifacts <artifacts> --old 0.1.0 --new 0.1.1
```

脚本对每种形态、每个场景：卸载 → 静默安装旧版（`/D=` 装到临时目录）→ 用 `ci/update-feed-server.mts`
起本地更新源（可注入半包 / 篡改 / 5xx）→ 写演练指令 `update-e2e.json` 并以 `EC_UPDATE_URL` 启动旧版 →
以应用自己写的 `update-e2e.log` 判定。演练指令只在数据目录里有该文件时生效，一次性执行。

### 6.3 本机无法完成、必须在发布环境做的步骤

| 步骤                                   | 为什么本机做不了                                                  | 怎么做                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 私钥进 CI Secret 并离线备份            | 需要仓库管理员权限与团队的密钥保管流程                            | §3.2；完成后删除开发机副本                                                                             |
| Windows 代码签名证书                   | 需要向 CA 购买（EV/OV），本机没有证书                             | 配 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`；签名后首发一版，确认 `app-update.yml` 出现 `publisherName` |
| 用 MSVC 官方工具链出 Tauri 正式包      | 本机无管理员装不了 MSVC 生成工具，用的是 GNU + Zig 非官方组合     | CI 的 `build-tauri`（`dtolnay/rust-toolchain@stable` 默认 MSVC）                                       |
| 发布到 GitHub Releases、验证线上更新源 | 需要推送 tag 与 `GITHUB_TOKEN`；首个 release 发布前线上端点是 404 | 推 `v<版本>` tag 触发 `ci/release.yml`；发布后用上一版客户端实测检查更新                               |
| 线上 https 端点的 Tauri 正式包更新     | 本地演练用 http 回环，必须"演练构建"放行；正式包只认 https        | 发两个连续正式版后，用旧版客户端走一遍（面板「检查更新」→「立即更新」）                                |
| Electron 首次跨版本差分（线上）        | 依赖上一个 release 里的 `.blockmap`，第一个 release 没有前任      | 从第二个 release 起，面板进度文案应出现"差分下载：仅需 …"                                              |
| 冷启动 ≤5s、内存占用                   | 与更新无关，另见 `docs/PERF-REPORT.md` §3                         | 按 PERF-REPORT 方法测                                                                                  |
