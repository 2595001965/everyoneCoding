/**
 * 版本号单一事实源（T10-04 / D-01）。
 *
 * 双形态（Tauri 2 + Electron）必须共用同一版本号与同一更新通道——手改五处
 * 迟早漂移，于是把**根 package.json 的 `version` 定为唯一事实源**，其余位置
 * 一律由本脚本生成。
 *
 * 用法：
 *   node --experimental-strip-types ci/version.mts            # 同步到所有位置
 *   node --experimental-strip-types ci/version.mts --check    # 校验是否一致（CI 门禁用，不一致退出码 1）
 *   node --experimental-strip-types ci/version.mts --set 0.2.0  # 改根版本并同步
 *   node --experimental-strip-types ci/version.mts --print    # 只打印当前版本
 *
 * 为什么要脚本而不是 workspace 协议：Tauri 的 `tauri.conf.json` 与 Cargo.toml
 * 不是 npm 生态文件，Electron 的 electron-builder 也从自己的配置读版本，
 * 只有"生成 + 校验"能把五处锁在一起。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 由根版本派生的位置（顺序即写入顺序）。 */
const MIRRORS: Array<{
  label: string;
  file: string;
  read: (raw: string) => string | null;
  write: (raw: string, version: string) => string;
}> = [
  {
    label: 'apps/desktop-tauri/package.json',
    file: 'apps/desktop-tauri/package.json',
    read: (raw) => (JSON.parse(raw) as { version?: string }).version ?? null,
    write: (raw, version) => writeJsonVersion(raw, version),
  },
  {
    label: 'apps/desktop-electron/package.json',
    file: 'apps/desktop-electron/package.json',
    read: (raw) => (JSON.parse(raw) as { version?: string }).version ?? null,
    write: (raw, version) => writeJsonVersion(raw, version),
  },
  {
    label: 'apps/desktop-tauri/src-tauri/tauri.conf.json',
    file: 'apps/desktop-tauri/src-tauri/tauri.conf.json',
    read: (raw) => (JSON.parse(raw) as { version?: string }).version ?? null,
    write: (raw, version) => writeJsonVersion(raw, version),
  },
  {
    label: 'apps/desktop-tauri/src-tauri/Cargo.toml',
    file: 'apps/desktop-tauri/src-tauri/Cargo.toml',
    read: (raw) => matchTomlVersion(raw),
    write: (raw, version) => writeTomlVersion(raw, version),
  },
  {
    label: 'apps/desktop-electron/electron-builder.yml (extraMetadata.version)',
    file: 'apps/desktop-electron/electron-builder.yml',
    read: (raw) => matchYamlVersion(raw),
    write: (raw, version) => writeYamlVersion(raw, version),
  },
];

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readRootVersion(): string {
  const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
  const version = (JSON.parse(raw) as { version?: string }).version;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`根 package.json 的 version 非法或缺失：${String(version)}`);
  }
  return version;
}

/** 重写 JSON 里的 version，保持 2 空格缩进与末尾换行（与仓库既有风格一致）。 */
function writeJsonVersion(raw: string, version: string): string {
  const data = JSON.parse(raw) as Record<string, unknown>;
  data['version'] = version;
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** 只改 `[package]` 段下的 version，绝不碰依赖的 `version = "2"`。 */
function writeTomlVersion(raw: string, version: string): string {
  const lines = raw.split('\n');
  let inPackage = false;
  let replaced = false;
  const out = lines.map((line) => {
    const section = /^\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      inPackage = section[1] === 'package';
      return line;
    }
    if (inPackage && /^version\s*=/.test(line)) {
      replaced = true;
      return `version = "${version}"`;
    }
    return line;
  });
  if (!replaced) throw new Error('Cargo.toml 的 [package] 段没有找到 version 字段');
  return out.join('\n');
}

function matchTomlVersion(raw: string): string | null {
  const lines = raw.split('\n');
  let inPackage = false;
  for (const line of lines) {
    const section = /^\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      inPackage = section[1] === 'package';
      continue;
    }
    if (inPackage) {
      const match = /^version\s*=\s*"([^"]+)"/.exec(line);
      if (match) return match[1] ?? null;
    }
  }
  return null;
}

/** electron-builder.yml 里 `extraMetadata:` 段下的 `version: x.y.z`。 */
function writeYamlVersion(raw: string, version: string): string {
  const lines = raw.split('\n');
  let inside = false;
  let replaced = false;
  const out = lines.map((line) => {
    if (/^extraMetadata:\s*$/.test(line)) {
      inside = true;
      return line;
    }
    if (!inside) return line;
    // YAML 没有段结束标记：缩进回到 0 即离开该段
    if (/^\S/.test(line)) {
      inside = false;
      return line;
    }
    const match = /^(\s+)version:\s*\S+\s*$/.exec(line);
    if (match) {
      replaced = true;
      return `${match[1]}version: ${version}`;
    }
    return line;
  });
  if (!replaced) throw new Error('electron-builder.yml 的 extraMetadata 段没有找到 version 字段');
  return out.join('\n');
}

function matchYamlVersion(raw: string): string | null {
  const lines = raw.split('\n');
  let inside = false;
  for (const line of lines) {
    if (/^extraMetadata:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (inside) {
      if (/^\S/.test(line)) {
        inside = false;
        continue;
      }
      const match = /^\s+version:\s*(\S+)\s*$/.exec(line);
      if (match) return match[1] ?? null;
    }
  }
  return null;
}

interface MirrorResult {
  label: string;
  current: string | null;
  ok: boolean;
}

function syncAll(version: string, checkOnly: boolean): MirrorResult[] {
  return MIRRORS.map((mirror) => {
    const file = path.join(repoRoot, mirror.file);
    const raw = fs.readFileSync(file, 'utf8');
    const current = mirror.read(raw);
    const ok = current === version;
    if (!ok && !checkOnly) {
      fs.writeFileSync(file, mirror.write(raw, version), 'utf8');
    }
    return { label: mirror.label, current, ok };
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const printOnly = args.includes('--print');
  const setIndex = args.indexOf('--set');
  const explicit = setIndex >= 0 ? args[setIndex + 1] : undefined;

  if (explicit !== undefined) {
    if (!VERSION_RE.test(explicit)) {
      throw new Error(`--set 的版本号不合法：${explicit}（期望形如 0.2.0 或 1.0.0-beta.1）`);
    }
    if (checkOnly) throw new Error('--set 与 --check 不能同时使用');
    const rootFile = path.join(repoRoot, 'package.json');
    fs.writeFileSync(rootFile, writeJsonVersion(fs.readFileSync(rootFile, 'utf8'), explicit), 'utf8');
    console.log(`根 package.json 版本已设为 ${explicit}`);
  }

  const version = readRootVersion();
  if (printOnly) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const results = syncAll(version, checkOnly);
  console.log(`${checkOnly ? '校验' : '同步'}版本号（单一事实源：根 package.json = ${version}）\n`);
  let allOk = true;
  for (const result of results) {
    if (!result.ok) allOk = false;
    const mark = result.ok ? 'OK  ' : checkOnly ? 'DRIFT' : 'WROTE';
    console.log(`  ${mark}  ${result.current ?? '(缺失)'} -> ${version}  ${result.label}`);
  }
  console.log('');
  if (checkOnly && !allOk) {
    console.error('版本号存在漂移：请运行 `node --experimental-strip-types ci/version.mts` 同步后再提交');
    process.exit(1);
  }
  console.log(checkOnly ? '版本号一致' : `版本号已统一为 ${version}`);
}

main();
