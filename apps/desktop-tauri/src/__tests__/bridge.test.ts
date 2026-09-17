/**
 * Tauri 外壳桥接层契约测试。
 *
 * 通过 `vi.mock('@tauri-apps/api/core')` 伪造 `invoke` 与 `Channel`，
 * 复用 `@ec/shell-api` 的 `runShellContract` 契约套件，确保 TS 桥接层与 Rust 命令契约一致。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTauriShell } from '../bridge';
import { type ContractHarness, runShellContract } from '@ec/shell-api';

// 进程事件线（与 bridge.ts 的 ProcessEventWire 对应）。
interface ProcessEventWire {
  kind: 'stdout' | 'stderr' | 'exit';
  data?: string;
  code?: number | null;
  signal?: string | null;
}

const SEP = '\\';

// 全部伪造状态集中在 hoisted 闭包，供 vi.mock 工厂与测试共享。
const { fakeInvoke, MockChannel } = vi.hoisted(() => {
  // 伪造信道：与真实 Channel 在桥接层侧行为一致（onmessage 可赋值、可被推送）。
  // 必须放在 hoisted 闭包内：vi.mock 工厂会在模块求值前执行，引用外部 class 会触发 TDZ。
  class MockChannel<T = unknown> {
    id = Math.floor(Math.random() * 1e9);
    onmessage: ((message: T) => void) | null = null;
  }

  type FsNode = { isDir: boolean; content: string };
  const fs = new Map<string, FsNode>();
  const secure = new Map<string, string>();
  let clipboard = '';
  let windowSize = { width: 1024, height: 640 };
  const dataDir = 'C:\\Users\\tester\\AppData\\Roaming\\EveryoneCoding';

  const isDir = (p: string): boolean => fs.get(p)?.isDir === true;

  const reject = (code: string, message: string): Promise<never> =>
    Promise.reject(new Error(JSON.stringify({ code, message })));

  async function fakeInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    switch (cmd) {
      case 'fs_mkdir':
        fs.set(args.path as string, { isDir: true, content: '' });
        return undefined;
      case 'fs_write_atomic': {
        const p = args.path as string;
        if (isDir(p)) return reject('INVALID_ARGUMENT', '目标是目录');
        const data = (args.data as number[] | undefined) ?? [];
        const content = String.fromCharCode(...data);
        fs.set(p, { isDir: false, content });
        return undefined;
      }
      case 'fs_read_text': {
        const node = fs.get(args.path as string);
        if (!node || node.isDir) return reject('NOT_FOUND', '文件不存在');
        return node.content;
      }
      case 'fs_read_binary': {
        const node = fs.get(args.path as string);
        if (!node || node.isDir) return reject('NOT_FOUND', '文件不存在');
        return Array.from(Buffer.from(node.content, 'utf8'));
      }
      case 'fs_stat': {
        const node = fs.get(args.path as string);
        if (!node) return null;
        return {
          path: args.path,
          size: node.content.length,
          isFile: !node.isDir,
          isDirectory: node.isDir,
          mtimeMs: 0,
          ctimeMs: 0,
          readonly: false,
        };
      }
      case 'fs_readdir': {
        const dir = args.path as string;
        const prefix = `${dir}${SEP}`;
        const entries: Array<{ name: string; path: string; isFile: boolean; isDirectory: boolean }> = [];
        for (const key of fs.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (rest.includes(SEP)) continue;
          const node = fs.get(key);
          if (!node) continue;
          entries.push({
            name: rest,
            path: key,
            isFile: !node.isDir,
            isDirectory: node.isDir,
          });
        }
        return entries;
      }
      case 'fs_exists':
        return fs.has(args.path as string);
      case 'fs_remove': {
        const p = args.path as string;
        fs.delete(p);
        for (const key of [...fs.keys()]) {
          if (key.startsWith(`${p}${SEP}`)) fs.delete(key);
        }
        return undefined;
      }
      case 'fs_copy': {
        const src = fs.get(args.source as string);
        if (src) fs.set(args.target as string, { ...src });
        return undefined;
      }
      case 'fs_rename': {
        const src = fs.get(args.source as string);
        if (src) {
          fs.delete(args.source as string);
          fs.set(args.target as string, { ...src });
        }
        return undefined;
      }
      case 'fs_watch':
        return `watch-${Math.random().toString(36).slice(2)}`;
      case 'fs_unwatch':
        return undefined;
      case 'process_spawn': {
        const ch = args.channel as unknown as MockChannel<ProcessEventWire> | undefined;
        const id = `fake-${Math.random().toString(36).slice(2)}`;
        setTimeout(() => {
          if (ch && ch.onmessage) {
            ch.onmessage({ kind: 'stdout', data: 'ec-contract\n' });
            ch.onmessage({ kind: 'exit', code: 0, signal: null });
          }
        }, 0);
        return { id, pid: 1234 };
      }
      case 'process_write':
      case 'process_kill':
      case 'process_kill_all':
        return undefined;
      case 'process_list':
        return [];
      case 'secure_store_set':
        secure.set(`${args.namespace as string}:${args.key as string}`, args.value as string);
        return undefined;
      case 'secure_store_get':
        return secure.get(`${args.namespace as string}:${args.key as string}`) ?? null;
      case 'secure_store_delete':
        secure.delete(`${args.namespace as string}:${args.key as string}`);
        return undefined;
      case 'secure_store_has':
        return secure.has(`${args.namespace as string}:${args.key as string}`);
      case 'secure_store_list_keys': {
        const ns = args.namespace as string;
        return [...secure.keys()]
          .filter((k) => k.startsWith(`${ns}:`))
          .map((k) => k.slice(ns.length + 1));
      }
      case 'window_set_size':
        windowSize = {
          width: args.width as number,
          height: args.height as number,
        };
        return undefined;
      case 'window_get_size':
        return windowSize;
      case 'app_info_get':
        return {
          kind: 'tauri',
          name: 'EveryoneCoding',
          version: '0.1.0',
          platform: 'windows',
          arch: 'x64',
          dataDir,
          workspaceRoot: null,
          locale: 'en-US',
          isPackaged: false,
        };
      case 'app_info_get_data_dir':
        return dataDir;
      case 'app_info_set_workspace_root':
        return undefined;
      case 'clipboard_read_text':
        return clipboard;
      case 'clipboard_write_text':
        clipboard = args.text as string;
        return undefined;
      case 'clipboard_clear':
        clipboard = '';
        return undefined;
      case 'net_set_allowed_hosts':
        return undefined;
      case 'net_is_host_allowed':
        return false;
      case 'net_fetch':
        return { status: 200, statusText: 'OK', headers: {}, body: '' };
      case 'open_external':
        return undefined;
      default:
        return undefined;
    }
  }

  return { fakeInvoke, MockChannel };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: fakeInvoke,
  Channel: MockChannel,
}));

// 复用 shell-api 的契约套件：同一份用例覆盖 Tauri 实现。
runShellContract(
  'TauriShell',
  () => createTauriShell(),
  { describe, it, expect, beforeEach, afterEach } as unknown as ContractHarness,
);
