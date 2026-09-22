# 双形态与受控侧车（T13-01）详细记录

> 索引见 `../MEMORY.md §双形态与侧车`。本文件是被移出 MEMORY.md 的细节（前者限 3000 字符）。

- **业务运行时只有一份**：全在 Node 侧（15 域 + AI 栈 + `@ec/*` + better-sqlite3）。
  Tauri 经**受控侧车**承载，**绝不迁进 Rust**（= 重写第二遍必然漂移）。
  前提：全仓只有 2 个文件 `import 'electron'`（`main/index.ts`、`preload/index.ts`），域模块全部依赖注入。
- 装配单一入口：`apps/desktop-electron/src/main/runtime/bootstrap.ts` 的 `createHeadlessRuntime()`，
  Electron 与侧车共用。**改域装配只改这里。**
- 侧车入口 `src/sidecar/index.ts`；产物 `dist/sidecar/everyone-coding-sidecar.cjs` + `sidecar-manifest.json` +
  `migrations/`（`scripts/build-sidecar.mjs` 产出，`better-sqlite3` 必须 external）。
- **协议 NDJSON over stdin/stdout**，判别字段 `t`：hello/welcome/ready/req/res/evt/host/hostres/bye。
  op/capability/event 名两侧逐字一致（Rust 单测有硬编码比对）；字段名一律 camelCase
  （`secureStore`/`syncDomains`/`dataDir`）——写成 snake_case 会让侧车永远认为 DPAPI 不可用。
  协议主版本两处校验：清单（启动前）+ 握手（运行时）；不等直接拒绝服务（不做"尽力而为"）。
- **DPAPI 由宿主（Rust）提供**：侧车经 `secure.encrypt`/`secure.decrypt` 回传执行，复用
  `secure_store.rs` 同一份实现。故 `SafeStorageLike` 的 `encryptString/decryptString` 放宽为
  `Buffer | Promise<Buffer>`（Electron 同步、侧车异步），下游三处存储只多一个 `await`，落盘布局两形态一致。
- **侧车 stdout 只能是协议帧**：入口先把 console 全改道 stderr（领域代码里有 console.info）。
  `.eslintrc.cjs` 为 `src/sidecar/index.ts` 单独放行 `no-console`。
- **退出必须收尾**：Rust 在 `RunEvent::Exit` 先发协议 `shutdown`（侧车自己杀掉预览后端），
  超时才 `taskkill /T /F` 整棵进程树。侧车侧 `stdin` 结束即自退（否则孤儿进程占 WAL 锁与工程目录）。
- **`invokeSync` 在 Tauri 不存在**：渲染层无同步 IPC 原语。用异步伪装同步会读到上一拍数据（伪造），
  故 memory/pipeline 的同步签名端口**如实不注入**（页面保留引导）。两域本身走异步口可用（记为 L-10）。
- 能力协商：`ShellCapabilities` 新增可选 `reasons`（缺能力的真实原因），`negotiate()` 回
  `degradedReasons`（"缺什么"+"为什么缺"）。`ai`/`domain` 不得写死，取 `sidecar_status` 的真实结果。
- 路径安全五道关（`validate_sidecar_dir`）：目录无 `..` → 清单可解析且 runtime/协议匹配 →
  入口名无分隔符与 `..` → 入口规范化后仍在目录内 → 文件名与清单逐字一致。
- 仍未闭环（外部条件，非代码缺口）：Tauri 安装包需 MSVC linker（本机无管理员权限）；
  侧车随包分发（`bundle.resources` + ABI 137 同代 `node.exe`，记为 L-11）；Tauri 实机 GUI 冒烟。
