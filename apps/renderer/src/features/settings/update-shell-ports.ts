/**
 * 外壳更新端口实现（T10-04 / FR-SET-05 / D-01）——**双形态共用一套**。
 *
 * 设计要点：
 * - `@ec/core` 的 `UpdateService` 需要 `UpdatePorts`，这里用既有的 `ShellHost` 能力拼出来
 *   （`updater` / `fs` / `path` / `process` / `appInfo`），**不新增任何 shell 能力**，
 *   于是 Tauri 与 Electron 无需各写一遍等价逻辑。
 * - 回滚依赖"上一版本安装包留档"：由 NSIS 安装钩子在**每次安装时**把自身安装包复制到
 *   `%LOCALAPPDATA%\EveryoneCoding\updates\backup\`（见 `nsis/installer-hooks.nsh` 与
 *   `build/installer.nsh`）。客户端按版本号在文件名中匹配，找不到就如实返回 null，
 *   由台账判定 `no-backup`（提示手动重装），绝不假装回滚成功。
 * - 还原 = 静默重跑该安装包（NSIS 的 `/S`），随后由外壳重启应用。
 */

import type { ShellHost } from '@ec/shell-api';

import type { UpdatePorts, UpdateRuntimeState } from '@ec/core';

/** 备份目录相对数据目录的位置（与 NSIS 钩子里的固定目录保持一致）。 */
export const UPDATE_BACKUP_SEGMENTS = ['updates', 'backup'] as const;

/** 更新运行时状态落盘文件名（含检查时间、稍后提醒、回滚台账）。 */
export const UPDATE_RUNTIME_FILE = 'update-runtime.json';

export interface UpdateHostOptions {
  shell: ShellHost;
  /**
   * 数据目录。缺省取 `shell.appInfo.getDataDir()`。
   * 显式传入便于测试；也允许外壳把状态放到自定义位置。
   */
  dataDir?: string | undefined;
  /**
   * 备份目录。缺省 `<dataDir>/updates/backup`。
   * 装到别处（如企业统一目录）时由外壳显式指定。
   */
  backupDir?: string | undefined;
  /** 安装包文件名 → 版本号（各形态命名不同，默认两种都认）。 */
  parseVersionFromFile?: ((fileName: string) => string | null) | undefined;
  /** 回滚重装后重启应用；缺省不重启（仅还原文件）。 */
  relaunch?: (() => Promise<void>) | undefined;
  /** 时钟注入（测试可固定）。 */
  now?: (() => number) | undefined;
  /** 在线判定；缺省恒 true（更新检查失败本身会被上游兜住）。 */
  isOnline?: (() => boolean) | undefined;
}

/**
 * 从安装包文件名解析版本号：
 * - Tauri：`EveryoneCoding_0.1.0_x64-setup.exe`
 * - Electron：`EveryoneCoding-0.1.0-x64-setup.exe`
 * 解析不出返回 null（该文件不算候选备份）。
 *
 * 注意**不能**用"裸的 semver 正则"：`EveryoneCoding-0.2.0-x64-setup.exe` 里
 * `0.2.0-x64-setup.exe` 也满足"三段数字 + 可选预发布"，贪婪匹配会把后缀吃进版本号。
 * 因此显式按两种命名约定取定界符（`_…_` / `-…-x64-setup.exe`）。
 */
const INSTALLER_NAME_PATTERNS = [
  /_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)_/,
  /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-x64-setup\.exe$/i,
  /(\d+\.\d+\.\d+)/,
] as const;

export function parseVersionFromInstallerName(fileName: string): string | null {
  for (const pattern of INSTALLER_NAME_PATTERNS) {
    const match = pattern.exec(fileName);
    const version = match?.[1];
    if (version !== undefined) return version;
  }
  return null;
}

export interface ShellUpdateHost {
  ports: UpdatePorts;
  /** 备份目录（供诊断与设置页展示） */
  backupDir: string;
  /** 运行时状态文件路径 */
  runtimeFile: string;
}

/** 用既有外壳能力拼出 `UpdatePorts`（不新增 shell 能力，Tauri/Electron 共用）。 */
export async function createShellUpdatePorts(options: UpdateHostOptions): Promise<ShellUpdateHost> {
  const { shell } = options;
  const dataDir = options.dataDir ?? (await shell.appInfo.getDataDir());
  const backupDir =
    options.backupDir ?? (await shell.path.join(dataDir, ...UPDATE_BACKUP_SEGMENTS));
  const runtimeFile = await shell.path.join(dataDir, UPDATE_RUNTIME_FILE);
  const parse = options.parseVersionFromFile ?? parseVersionFromInstallerName;
  const now = options.now ?? ((): number => Date.now());

  const ports: UpdatePorts = {
    updater: shell.updater,
    now,
    isOnline: options.isOnline ?? ((): boolean => true),

    async backupCurrentVersion(fromVersion: string): Promise<string | null> {
      const exists = await shell.fs.exists(backupDir);
      if (!exists) return null;
      const entries = await shell.fs.readdir(backupDir);
      const candidate = entries
        .filter((entry) => entry.isFile)
        .map((entry) => entry.name)
        .filter((name) => parse(name) === fromVersion)
        .sort()[0];
      if (candidate === undefined) return null;
      return shell.path.join(backupDir, candidate);
    },

    async restoreBackup(backupPath: string): Promise<void> {
      const exists = await shell.fs.exists(backupPath);
      if (!exists) throw new Error(`回滚失败：找不到上一版本安装包 ${backupPath}`);
      // NSIS 静默安装（/S）。安装器会替换正在运行的客户端文件，因此由外壳在调用前
      // 让出（本函数不等待安装完成，也不杀安装进程——杀掉它就等于回滚没发生）。
      await shell.process.spawn(backupPath, ['/S']);
      if (options.relaunch !== undefined) await options.relaunch();
    },

    async currentVersion(): Promise<string> {
      const info = await shell.appInfo.get();
      return info.version;
    },

    async loadRuntime(): Promise<UpdateRuntimeState | null> {
      if (!(await shell.fs.exists(runtimeFile))) return null;
      const raw = await shell.fs.readText(runtimeFile);
      if (raw.trim() === '') return null;
      try {
        return JSON.parse(raw) as UpdateRuntimeState;
      } catch {
        // 坏数据不阻塞启动：交给 UpdateService 归一化为空状态
        return null;
      }
    },

    async saveRuntime(state: UpdateRuntimeState): Promise<void> {
      await shell.fs.writeAtomic(runtimeFile, `${JSON.stringify(state, null, 2)}\n`);
    },
  };

  return { ports, backupDir, runtimeFile };
}
