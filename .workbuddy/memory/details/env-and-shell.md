# 本机命令环境、环境坑与 `.bat` 铁律

> 索引见 `../MEMORY.md §命令与启动`。本文件是被移出 MEMORY.md 的细节，**每会话都该先读**。

## 本机命令环境（每次会话都要用，别重新踩）
- **跑测试/门禁必须让 `node` = nvm v24.20.0**：better-sqlite3 的 Node 侧 `.node` 按 ABI 137 构建，
  托管 v22.22.2 是 ABI 127，用它跑测试满屏 `NODE_MODULE_VERSION ... requires 127`。首选
  `/c/Users/f2595/AppData/Local/Author Software/nvm/installs/v24.20.0/node.exe`
  （`.nodejs` 是会被切走的软链，只作临时手段）。
- **经 pnpm 转发的命令必须把 nvm v24 目录放进 `PATH` 前缀**（只喂 node.exe 绝对路径没用——
  脚本由 pnpm 重新 spawn，子进程里裸 `node` 会解析到 v22.22.2，**看起来像代码坏了**）。
- **bash 缺 PortableGit 的 `/usr/bin`**（`dirname`/`head`/`ls`/`grep`/`wc` not found）：前置
  `/c/Users/f2595/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin`。
  `cargo` 在 `/c/Users/f2595/.cargo/bin`（**Rust 1.98.1 已就位**，check/clippy/test 都能本机跑）。
- **bash 里 corepack 版 `pnpm` shim 调不通**，用真入口：
  `node "C:/Users/f2595/AppData/Local/node/corepack/v1/pnpm/9.15.9/bin/pnpm.cjs" <args>`。
- node 的脚本/参数路径**不要写 `/d/...`**（会变 `D:\d\...`），一律 `D:/code/...`。
- **根脚本 `pnpm build:renderer` 在沙盒里会卡住不返回**；直接 `cd apps/renderer && node
  node_modules/vite/bin/vite.js build`（约 25s，611 modules）。
- **包内单测要在仓库根跑**：根 `vitest.config.ts` 的 include 是
  `{packages,apps}/*/src/**/*.test.{ts,tsx}`，从包目录跑会 "No test files found"（`packages/core` 例外）。
- **同一 message 里对同一文件发多个 `Edit` 会互相覆盖**（实测只有最后一个生效）。改同一文件必须一次一个 Edit。
- 全量并发跑单测时 `@ec/ai` 上下文性能基准会假红（判据见 `docs/TEST-REPORT.md §5.1`），不改预算。
  **根级全量单测最稳的跑法是串行**：`pnpm -r --workspace-concurrency=1 test`。
  **另外 `pnpm -r test` 在第一个失败的包就停**，后面的包根本不跑，只看尾部输出会误判成"全绿"。
- PowerShell 工具在本会话里**不回显 stdout**（exit 0 但无输出），需要输出就用 `>` 落文件再 `Read`。

## 环境坑
- **`cargo test` 首次可能报 `应用程序控制策略已阻止此文件 (os error 4551)`**：Windows SAC 对新编译出的
  二进制有短暂拦截，**重跑即过**（同源：SAC 拦未签名 build script）。
- **`vite build` 可能报 `EPERM ... dist\assets`**：先 `rm -rf apps/renderer/dist` 再重跑即过
  （文件句柄释放有延迟 / 杀软扫描）。
- **D 盘过滤驱动拦 `refs/remotes`**（2026-09-17 定案）：写远端跟踪引用返 0 但文件不存在，
  还删掉 `refs/remotes/origin` 目录 → 长期 `[gone]`。仅 D 盘、仅 `refs/remotes`，不影响 push 本身。
- 需给 `D:\code` 加排除（未做）；git 推送待登记 `~/.ssh/id_ed25519` 公钥到 GitHub。
- Tauri：`sp.crates.io` 不通→改 `index.crates.io`；NSIS 在 `%LOCALAPPDATA%\tauri\NSIS`。
  截 Tauri 窗口用 `PrintWindow(hwnd,dc,2)`。
- **git 用例超时是环境还是代码**：同时量 `git --version` 与 `where.exe git`。健康基线进程创建
  ~0.5s 地板价、`git --version` ≈759ms；退化时可达 26.5s ⇒ `git-integration.test.ts` 与
  `domain-workspace-git.test.ts` 必然假红。**不要改这些测试的超时预算**；
  临时放行用 `--testTimeout=<大值>` 或 `EC_GIT_IT_TIMEOUT_MS`。

## 仓库配置约定
- `.gitignore`：`release/`、安装包扩展名、`.tmp-*`（**只匹配目录**）。
- `.gitattributes` 钉 `*.bat eol=crlf`、`*.gbk -text`。
- 许可 Apache-2.0 且仓库公开，`LICENSE` + `NOTICE` 随产物分发。

## `.bat` 铁律（`scripts/`）
必须 **GBK(cp936) + CRLF + 无 BOM**。转码：`node 规范 CRLF` + `iconv -f UTF-8 -t GBK`。
**禁止** Read/Write 往返 GBK 文件；**禁止** PowerShell `ReadAllText(UTF8)+WriteAllText(936)`（满篇 `?`）。
验收：GBK 汉字数与源件一致、`0x3F` 字节为 0。延时用 `ping`；不用 `tasklist /V`；
`taskkill /FI WINDOWTITLE` 无匹配也返 0，不能当成功判据。
`start-desktop.bat` 故意不清 `ELECTRON_RUN_AS_NODE`；dev 默认不弹 DevTools（`EC_ELECTRON_DEVTOOLS=1` 开启）。

## 命令与启动
`pnpm lint` / `-r typecheck` / `test` / `test:e2e` / `quality-gate` / `perf` / `format:check`；
CI 在 `ci/*.yml`（未接远端）。**push 前快检必须跑 `pnpm lint` + `pnpm format:check` 两条**
（曾因只跑 eslint 漏 prettier 导致 CI Lint job 红）。
启动：`dev:renderer`(5173) / `dev:electron` / `dev:tauri`。出包前必换 `tauri.conf.json` 的 `updater.pubkey`。
**`dev:electron` 与 `dev:tauri` 都不代起渲染层**：必须先另开终端跑 `pnpm dev:renderer`，
否则前端报 `-102 ERR_CONNECTION_REFUSED`。渲染层 `strictPort: true`，端口被占直接失败而非漂移。
（沙盒里跑 vite dev **卡在 "Re-optimizing dependencies"** 不 bind 端口，别在沙盒里验证这条链路。）
