/**
 * path 能力说明（设计决策）：
 *
 * ShellHost.PathApi 是同步纯计算契约，走 IPC（同步 sendSync）会引入跨进程开销与
 * 事件循环阻塞风险，因此 path 能力统一在渲染层本地实现：
 * - 共享语义实现：packages/shell-api 的 createPathApi(sep)（Mock / Tauri / Electron 三侧一致）
 * - 本文件保留 node:path 工具函数，供主进程内部（如 secure_store 路径拼接）复用
 */
import path from 'node:path';

/** 判断 child 是否位于 parent 目录之内（含自身） */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export { path };
