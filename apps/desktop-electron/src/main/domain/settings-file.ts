import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_GLOBAL_SETTINGS, migrateSettings, type GlobalSettings } from '@ec/core';

/**
 * `settings.json` 的读取与工作区路径解析。
 *
 * 为什么单独一个文件：settings 域（写设置）与 workspace / docs 域（要按工作区根目录定位工程目录）
 * 都要读同一份文件。放在这里避免各自实现一份，也避免 workspace 反向依赖 settings 域的路由。
 */

export const SETTINGS_FILE = 'settings.json';
export const SQLITE_FILE = 'everyonecoding.sqlite';

export function settingsFilePath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILE);
}

/** 读取全局设置；文件缺失或损坏时退回默认值（与 settings-schema 的迁移口径一致） */
export function readGlobalSettings(dataDir: string): GlobalSettings {
  const file = settingsFilePath(dataDir);
  try {
    if (!existsSync(file)) return DEFAULT_GLOBAL_SETTINGS;
    return migrateSettings(JSON.parse(readFileSync(file, 'utf8')) as unknown).global;
  } catch {
    return DEFAULT_GLOBAL_SETTINGS;
  }
}

/** 工作区根目录：用户已配置则用配置，否则用默认根 */
export function resolveWorkspaceRoot(dataDir: string, defaultWorkspaceRoot: string): string {
  return readGlobalSettings(dataDir).workspaceRoot || defaultWorkspaceRoot;
}

/** 工程目录根（`<workspaceRoot>/projects`，与 `@ec/core` 的 WorkspaceLayout 约定一致） */
export function resolveProjectsDir(dataDir: string, defaultWorkspaceRoot: string): string {
  return join(resolveWorkspaceRoot(dataDir, defaultWorkspaceRoot), 'projects');
}

export function sqliteFilePath(dataDir: string): string {
  return join(dataDir, SQLITE_FILE);
}
