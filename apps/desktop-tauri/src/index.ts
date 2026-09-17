/**
 * @ec/desktop-tauri 入口：对外导出 Tauri 2 外壳桥接层与 WebView2 探测能力。
 *
 * 渲染层只需 `import { createTauriShell } from '@ec/desktop-tauri'`，
 * 或在应用启动处依赖本模块副作用完成 `registerShellFactory('tauri', ...)`。
 */

export * from './bridge';
export * from './webview2-check';
