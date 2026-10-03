# V2-D08 实机证据（Electron）

日期：2026-10-03。运行的是仓库 Electron 桌面壳，不是浏览器 mock。为避免接触用户数据，启动时将 `EC_ELECTRON_USER_DATA_DIR` 指向仓库下临时隔离目录；renderer 由本地 Vite 提供。

## Memory / Pipeline 页面

- [Electron Memory 页面](./electron-memory-page.png)：页脚显示“外壳: electron”；真实 memory RPC 返回 0 条数据的空态。
- [Electron Pipeline 页面](./electron-pipeline-page.png)：页脚显示“外壳: electron”；显示“未打开项目”，说明 `PipelineApi` 已注入，当前隔离库尚无打开的项目。

两张截图由运行中的 Electron BrowserWindow 的 CDP `Page.captureScreenshot` 捕获。`/memory` 和 `/pipeline` 均在真实 Electron renderer 内导航；没有用浏览器标签或 mock bridge。

## 三个同时打开的 Agent 原生窗口

从 Electron preload `window.openAgentWindow` bridge 同时发出三次窗口创建调用。三个目标各自是独立 BrowserWindow / renderer，绑定同一隔离项目 `01M3ZEZA12AN5XR0H7R3CM0P2M`，session 分别为 `d08-evidence-session-1`、`-2`、`-3`，共用该 Electron 进程装配的 code domain 与 AgentCoordinator。

| 窗口 | Chromium target | 页面截图 |
| --- | --- | --- |
| 1 | `0D8924AF9502FE412DBD5949DBF7347E` | [窗口 1](./electron-agent-window-01.png) |
| 2 | `0C962F29E290580837B6D63EA40CD2AB` | [窗口 2](./electron-agent-window-02.png) |
| 3 | `C4DF108B9A78BBCBABE4BA0B24315483` | [窗口 3](./electron-agent-window-03.png) |

三个页面同时回显“此会话还没有任务。协调器游标：0”，并显示 `外壳: electron`。因此这证明了三个真实 Electron 原生窗口与独立会话页面同时存在、并能读取共享协调器快照；它**不证明三项 Agent 执行任务并发**。隔离配置的 AI readiness 是 `ready=false`、`providers=0`，为避免模型费用没有提交真实生成任务。

## 未验范围

- 本机 `cargo` / `rustc` 不可用，Tauri Rust 编译、Tauri 页面截图及 Tauri 原生窗口未验。
- 三个 Electron 窗口在无 AI Provider 时只验证窗口并发与协调器快照读取；任务运行重叠、跨窗取消/重连与关闭后继续仍未验。
- 安装包未构建。已单独运行 sidecar staging 和 staged Node / SQLite smoke；这不等同于 Tauri bundle 实测。
