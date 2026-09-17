# EveryoneCoding 项目长期约定

## 定位与现状

- Windows 桌面端 AI 全栈开发工作台（Tauri 2 / Electron 双形态）。链路：需求 → 界面 → 技术文档 → 代码。
- 基线 `docs/PRD-EveryoneCoding.md`（v1.3，15 模块 162 条）；`docs/tasks/00~11`（Wave 0~10 **已全部落地**，2026-09-14 收官）。
- 状态（2026-09-15）：六模块门禁全绿、E2E 39 项、全量 2188 项全绿，lint/typecheck 零问题，`pnpm dev:electron` 真机跑通。
- 未闭环仅剩「环境缺失/权限不足」项，见 `docs/ACCEPTANCE-REPORT.md §3/§5`。接手先读 `docs/DEV-SETUP.md` 与最近两天日志。

## 桌面启停脚本（2026-09-15 新增，`scripts/` 目录）

- `start-desktop.bat`：渲染层 5173 → curl 轮询就绪 → Electron（经 `apps/desktop-electron/scripts/dev.mjs`）→
  自检 electron.exe（**计数非 0 后等 3 秒复查**，避免把重启前那批崩溃进程误判成成功），4 步全自动。
  该脚本**故意不清除 `ELECTRON_RUN_AS_NODE`**（理由见下方 Electron 硬规则）。
- `stop-desktop.bat`：窗口标题（EC-Renderer / EC-Electron）→ electron.exe → 占用 5173 的 PID，末尾按端口做确定性校验。
- 全部写死绝对路径，不依赖 PATH 与 pnpm shim，双击即用。
- dev 模式**默认不自动弹 DevTools**（需要时设 `EC_ELECTRON_DEVTOOLS=1`）。DevTools 前端会往控制台吐
  `Unknown VE context: language-mismatch`、`Request Autofill.enable failed` 等 `ERROR:CONSOLE` 告警，
  与应用无关却极易被误判成故障（判据：报文尾部 `source: devtools://...`）。Ctrl+Shift+I 仍可随时打开。
  另：渲染层没起来时主进程会打印 `渲染层加载失败：... ERR_CONNECTION_REFUSED`，不再只给白窗口。
- **铁律：`.bat` 必须 GBK(cp936) + CRLF + 无 BOM**。UTF-8 会让 cmd.exe 解析多字节字符错位。
- 转码只走 `node 规范 CRLF` + `iconv -f UTF-8 -t GBK`（Git Bash 自带 iconv）。
  **禁止**用 Read/Write 工具往返 GBK 文件；**禁止** PowerShell `ReadAllText(UTF8)+WriteAllText(936)`（实测产出满篇 `?`）。
- 验收口径：GBK 解码汉字数与源件一致、`0x3F` 字节为 0、无 U+FFFD。
- `.bat` 延时用 `ping` 不用 `timeout`（stdin 被重定向时报错空转）；不用 `tasklist /V`（触发安全策略拦截）；
  `taskkill /FI "WINDOWTITLE eq ..."` 无匹配也返回 0，不能当成功判据。

## 工程硬规则

- **browser 入口**：`@ec/core` 是双入口包（`exports.browser` → `src/browser.ts`，排除用 `node:zlib` 的 docx/pdf/OCR 解析器）。
  `apps/renderer/vite.config.ts` 的 `@ec/core` alias 必须指 `browser.ts`；`@ec/data`/`memory`/`ai`/`pipeline` 同规则。
  新增包或 Node 侧模块时同步维护 browser 入口。
- **依赖方向**：`core` 不得反向依赖 `@ec/pipeline`（七端常量在 core 侧镜像为 `TARGET_PLATFORM_KEYS`）。
- **跨特性复用**：特性之间禁止直接 import，走 `features/workspace/workspace-events.ts` 事件总线。
- **设计器**：不得依赖 `@ec/memory`（会传递 better-sqlite3 污染浏览器构建），外部能力一律经 `store/ports.ts` 的 `DesignerPorts` 注入；
  文档变更唯一入口 `apply(label, recipe, { coalesceKey })`；选中态/hover 由 `editor-store` 单源持有；
  **DSL 加可序列化字段必须同步改 zod（`dsl/schema.ts`）**，否则保存/加载被静默剥离。
- **Electron**：`dev.mjs` 对 GPU 做**两层兜底** —— ① 启发式（有嵌入宿主特征就直接软件渲染）；
  ② 首轮出现 GPU 崩溃特征则自动带 `--disable-gpu --disable-software-rasterizer --no-sandbox` 重启一次。
  故**调用方不要提前清 `ELECTRON_RUN_AS_NODE`**：它正是"是否嵌入宿主"的判据，提前清掉会让第 ① 层失效；
  dev.mjs 自己会在派生 Electron 子进程时删掉它。构建产物必须 `.cjs`；
  `better-sqlite3` 需 Node 侧与 Electron 侧两套 ABI 共存，勿互相覆盖；路径推导禁用固定层数，用逐级向上探测。
- **e2e 是独立工程**：`e2e/vitest.config.ts` 必须设 `root`，否则扫全仓测试文件批量假红；
  改包导出名要 grep `e2e/`；交付前须 `tsc -p e2e/tsconfig.json` + lint（vitest 不做类型检查）。
- **测试口径**：性能一律用「毫秒 + DOM 行数」或「单帧几何 ms + 重渲染节点数」，禁止在 jsdom 里报帧率。
- 通用：pnpm workspace，包名 `@ec/*`，跨包只走单一入口、禁止深路径导入；TS strict 全家桶；
  渲染层只 import `@ec/shell-api`，禁止直接 import `@tauri-apps/*` 或 `electron`；
  迁移文件格式 `-- migration: <名>` + `-- up` + `-- down`（事务化、幂等）；
  组件名与标识符用英文/拼音，显示文案保留中文。

## 质量门禁与命令

- `pnpm lint` / `pnpm -r typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm quality-gate` / `pnpm perf` /
  `pnpm version:check` / `pnpm release:manifest`；CI 定义在 `ci/*.yml`（未接远端）。
- 启动：`pnpm dev:renderer`（5173，mock 外壳）/ `pnpm dev:electron`（真窗口）/ `pnpm dev:tauri`（本机权限不足）。
- 发布前必做：替换 `tauri.conf.json` 的 `plugins.updater.pubkey` 与更新端点，否则更新验签全失败。

## 未闭环项

- **Tauri 受权限阻塞**：账号 `f2595` 无管理员权限且不在 Administrators 组，装不了 MSVC linker；没有 linker 时装 Rust 也无用。
  需主人以管理员身份跑 `apps/desktop-tauri/scripts/setup-rust-tauri.ps1`，再 `cargo check` → `clippy -D warnings` → `pnpm build:tauri`。
- 设计器真实端口装配、docx/pdf 真实文件覆盖面、图片 OCR 接入待补；`.quarantine/` 待主人手动清理。
- 仓库已 `git init`（2026-09-17），首次提交 `addec09`（1175 文件 / 6.45 MB），远端
  `git@github.com:2595001965/everyoneCoding.git`。**推送仍待主人把 ed25519 公钥登记到 GitHub**
  （`~/.ssh/id_ed25519`，无口令短语）。登记后 `ssh -T git@github.com` 应回 `Hi 2595001965!`，
  再 `git push -u origin main`；若报 non-fast-forward（远端有初始提交），用 `git pull --rebase origin main`。

## 开源与保密（2026-09-17 口径变更，与此前相反）

- **主人已决定开源，仓库 `2595001965/everyoneCoding` 为公开仓库**（主人 2026-09-17 当场确认）。
  此决定**推翻了 2026-09-14 之前的"闭源、All Rights Reserved、不写 LICENSE、不写贡献引导"约定**，
  后续新增文档/注释/打包配置**不必再回避开源与贡献表述**。
- **⚠️ 仓库内许可口径尚未统一，六处自相矛盾（待主人定许可后一次性收敛）**：
  `README.md` 声明 Fair Core License (FCL)；根及各包 `package.json` 为 `"license": "UNLICENSED"` 且写「闭源项目」；
  `services/account/README.md` 与 `openapi.yaml` 为 `All Rights Reserved`；
  `docs/DEV-SETUP.md`、`docs/RELEASE.md`、`ci/*.yml`、`ci/make-release.mts`、`docs/tasks/00|01` 一律「内部闭源」。
  **且全仓无 LICENSE 文件**——公开仓库无 LICENSE 时默认 All Rights Reserved，与"开源"意图直接冲突。
  未擅自改动：选许可证是主人的法律决定。
- 公开仓库前敏感信息核查已做（2026-09-17，结论干净）：全仓无真实 API key、私钥、口令或主机 IP；
  命中的 `sk-live-abcdef*`、`example.com` 邮箱、`127.0.0.1` 均为测试夹具。
- `.gitignore` 已收口：`release/`（electron-builder 输出，内含 180 MB exe，超 GitHub 100 MB 单文件硬限）、
  安装包扩展名、`.tmp-*`、`*.log`。**注意 `.tmp-*/` 只匹配目录**，文件形式必须另写 `.tmp-*`。
- `.gitattributes` 已钉 `*.bat text eol=crlf` + `*.gbk -text`：系统级 `core.autocrlf=true`，
  不钉住会有改写 GBK 批处理脚本行尾/编码的风险。
