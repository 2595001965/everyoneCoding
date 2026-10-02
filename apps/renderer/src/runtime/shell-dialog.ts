/**
 * 外壳对话框访问器（V2-D01）。
 *
 * 原生文件夹/文件选择是**外壳能力**（`ShellHost.dialog`，Electron 走 ipc/dialog、
 * Tauri 走 Rust 命令、mock 走 dialogQueue），不是域逻辑——所以选择器在渲染层
 * 调用，把选出的路径交给 workspace 域做导入。这样域实现保持零外壳依赖
 * （对比：package 域的 pick* 方法动态 import('electron')，在 Tauri 侧车不可用）。
 *
 * 外壳未装配（纯浏览器/mock 缺省）时返回 null：调用方禁用选择按钮并保留
 * 手动输入框，不得假装选择成功。
 */
import type { DialogApi } from '@ec/shell-api';

export function readShellDialog(): DialogApi | null {
  const shell = (globalThis as { __EC_SHELL__?: { dialog?: DialogApi } }).__EC_SHELL__;
  return shell?.dialog ?? null;
}

/** 选一个目录；取消返回 null（调用方不得因此发起任何域调用） */
export function pickDirectory(title: string): Promise<string | null> {
  const dialog = readShellDialog();
  if (dialog === null) return Promise.resolve(null);
  return dialog.openDirectory({ title });
}

/** 选一个 ZIP 文件；取消返回 null */
export function pickZipFile(title: string): Promise<string | null> {
  const dialog = readShellDialog();
  if (dialog === null) return Promise.resolve(null);
  return dialog
    .openFile({ title, filters: [{ name: 'ZIP 归档', extensions: ['zip'] }] })
    .then((picked) => picked?.[0] ?? null);
}
