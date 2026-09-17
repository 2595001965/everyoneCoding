/**
 * Electron 桥接层契约测试。
 *
 * 用伪造的 preload 暴露面（window.ecShell）驱动 createElectronShell，
 * 复用 @ec/shell-api 的 runShellContract 契约套件，保证与 Mock / Tauri 同一套用例通过。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElectronShell, type EcShellPreload } from '../bridge';
import { type ContractHarness, runShellContract } from '@ec/shell-api';

const { fakeApi } = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const secure = new Map<string, string>();
  let clipboardText = '';
  let windowSize = { width: 1024, height: 640 };
  const dataDir = 'C:\\Users\\tester\\AppData\\Roaming\\EveryoneCoding';
  const allowedHosts = { value: [] as string[] | '*' };
  const external: string[] = [];
  let processSeq = 0;
  const processListeners = new Map<string, { stdout: Array<(chunk: string) => void>; stderr: Array<(chunk: string) => void>; exit: Array<(result: { code: number | null; signal: string | null }) => void> }>();

  const fakeApi = {
    fs: {
      readText: async (filePath: string) => {
        const content = files.get(filePath);
        if (content === undefined) throw new Error(JSON.stringify({ code: 'NOT_FOUND', message: '文件不存在' }));
        return content;
      },
      readBinary: async (filePath: string) => {
        const content = files.get(filePath);
        if (content === undefined) throw new Error(JSON.stringify({ code: 'NOT_FOUND', message: '文件不存在' }));
        return Array.from(Buffer.from(content, 'utf8'));
      },
      writeAtomic: async (filePath: string, data: string | number[]) => {
        if (dirs.has(filePath)) {
          throw new Error(JSON.stringify({ code: 'INVALID_ARGUMENT', message: '目标是目录' }));
        }
        files.set(filePath, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
      },
      stat: async (filePath: string) => {
        const content = files.get(filePath);
        if (content === undefined) return null;
        return { path: filePath, size: content.length, isFile: true, isDirectory: false, mtimeMs: 0, ctimeMs: 0, readonly: false };
      },
      readdir: async (dirPath: string) => {
        const prefix = `${dirPath}\\`;
        return [...files.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ name: key.slice(prefix.length), path: key, isFile: true, isDirectory: false }));
      },
      mkdir: async (dirPath: string) => {
        dirs.add(dirPath);
      },
      remove: async (target: string) => {
        dirs.delete(target);
        files.delete(target);
        const prefix = `${target}\\`;
        for (const key of [...files.keys()]) {
          if (key.startsWith(prefix)) files.delete(key);
        }
        for (const dir of [...dirs]) {
          if (dir.startsWith(prefix)) dirs.delete(dir);
        }
      },
      copy: async (source: string, target: string) => {
        const content = files.get(source);
        if (content !== undefined) files.set(target, content);
      },
      rename: async (source: string, target: string) => {
        const content = files.get(source);
        if (content !== undefined) {
          files.delete(source);
          files.set(target, content);
        }
      },
      exists: async (target: string) => files.has(target) || dirs.has(target),
      watch: async () => ({ id: 'w1', close: async () => undefined }),
    },
    dialog: {
      openFile: async () => null,
      openDirectory: async () => null,
      saveFile: async () => null,
      showMessage: async () => 0,
      confirm: async () => true,
    },
    process: {
      spawn: async (_command: string, args: string[]) => {
        const id = `p${++processSeq}`;
        processListeners.set(id, { stdout: [], stderr: [], exit: [] });
        setTimeout(() => {
          const listeners = processListeners.get(id);
          if (!listeners) return;
          for (const cb of listeners.stdout) cb(args.join(' '));
          for (const cb of listeners.exit) cb({ code: 0, signal: null });
        }, 0);
        return { id, pid: 1000 + processSeq };
      },
      write: async () => undefined,
      kill: async () => true,
      list: async () => [],
      killAll: async () => undefined,
      onStdout: (id: string, cb: (chunk: string) => void) => {
        processListeners.get(id)?.stdout.push(cb);
        return () => undefined;
      },
      onStderr: (id: string, cb: (chunk: string) => void) => {
        processListeners.get(id)?.stderr.push(cb);
        return () => undefined;
      },
      onExit: (id: string, cb: (result: { code: number | null; signal: string | null }) => void) => {
        processListeners.get(id)?.exit.push(cb);
        return () => undefined;
      },
    },
    window: {
      setTitle: async () => undefined,
      minimize: async () => undefined,
      maximize: async () => undefined,
      unmaximize: async () => undefined,
      isMaximized: async () => false,
      setFullScreen: async () => undefined,
      isFullScreen: async () => false,
      setSize: async (size: { width: number; height: number }) => {
        windowSize = size;
      },
      getSize: async () => [windowSize.width, windowSize.height],
      center: async () => undefined,
      focus: async () => undefined,
      close: async () => undefined,
    },
    secureStore: {
      set: async (namespace: string, key: string, value: string) => {
        secure.set(`${namespace}:${key}`, Buffer.from(value).toString('base64'));
      },
      get: async (namespace: string, key: string) => {
        const cipher = secure.get(`${namespace}:${key}`);
        return cipher === undefined ? null : Buffer.from(cipher, 'base64').toString('utf8');
      },
      delete: async (namespace: string, key: string) => {
        secure.delete(`${namespace}:${key}`);
      },
      has: async (namespace: string, key: string) => secure.has(`${namespace}:${key}`),
      listKeys: async (namespace: string) =>
        [...secure.keys()].filter((k) => k.startsWith(`${namespace}:`)).map((k) => k.slice(namespace.length + 1)),
    },
    updater: {
      check: async () => null,
      downloadAndInstall: async () => undefined,
      onProgress: () => () => undefined,
    },
    appInfo: {
      get: async () => ({
        kind: 'electron',
        name: 'EveryoneCoding',
        version: '0.1.0',
        platform: 'windows',
        arch: 'x64',
        dataDir,
        workspaceRoot: null,
        locale: 'zh-CN',
        isPackaged: false,
      }),
      getDataDir: async () => dataDir,
      setWorkspaceRoot: async () => undefined,
    },
    clipboard: {
      readText: async () => clipboardText,
      writeText: async (text: string) => {
        clipboardText = text;
      },
      clear: async () => {
        clipboardText = '';
      },
    },
    net: {
      fetch: async (request: { url: string }) => {
        const host = new URL(request.url).host;
        const allowed = allowedHosts.value === '*' || (allowedHosts.value as string[]).includes(host);
        if (!allowed) {
          throw new Error(JSON.stringify({ code: 'NET_BLOCKED', message: `主机未放行: ${host}` }));
        }
        return { status: 200, statusText: 'OK', headers: {}, body: '' };
      },
      isHostAllowed: async (host: string) => allowedHosts.value === '*' || (allowedHosts.value as string[]).includes(host),
      setAllowedHosts: async (hosts: string[] | '*') => {
        allowedHosts.value = hosts;
      },
    },
    openExternal: async (url: string) => {
      external.push(url);
    },
  };

  return { fakeApi, external, files };
});

vi.stubGlobal('ecShell', fakeApi);

runShellContract(
  'ElectronShell',
  () => createElectronShell(fakeApi as unknown as EcShellPreload),
  { describe, it, expect, beforeEach, afterEach } as unknown as ContractHarness,
);
