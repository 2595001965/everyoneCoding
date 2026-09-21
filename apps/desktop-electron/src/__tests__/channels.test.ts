/**
 * IPC 通道完整性审计：通道常量与主进程注册表必须一一对应。
 */
import { describe, expect, it } from 'vitest';
import { flattenChannels, registerAllIpc } from '../main/ipc';
import { CHANNELS, EVENT_CHANNELS, SYNC_CHANNELS } from '../main/channels';
import type { IpcDependencies } from '../main/types';

function buildDeps(): IpcDependencies {
  return {
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
    getWindow: () => null,
    clipboard: { readText: () => '', writeText: () => undefined, clear: () => undefined },
    safeStorage: null,
    updater: null,
    app: {
      getName: () => 'EveryoneCoding',
      getVersion: () => '0.0.0',
      getLocale: () => 'zh-CN',
      isPackaged: false,
      getPath: () => 'C:/tmp',
    },
    dataDir: 'C:/tmp/data',
    secureDir: 'C:/tmp/secure',
    openExternal: async () => undefined,
  };
}

describe('IPC 通道完整性', () => {
  it('CHANNELS 常量导出的通道名与 flattenChannels 一致且无重复', () => {
    const all = flattenChannels();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThanOrEqual(40);
  });

  it('每个通道都以 ec: 前缀命名', () => {
    for (const channel of flattenChannels()) {
      expect(channel.startsWith('ec:'), channel).toBe(true);
    }
  });

  it('主进程注册覆盖全部常量通道，dispose 后清空', () => {
    const captured = new Set<string>();
    /** 同步通道经 `ipcMain.on` 注册，与 handle 是两张表 */
    const capturedSync = new Set<string>();
    const ipc = {
      handle: (channel: string) => captured.add(channel),
      removeHandler: (channel: string) => captured.delete(channel),
      on: (channel: string) => capturedSync.add(channel),
      removeAllListeners: (channel: string) => capturedSync.delete(channel),
    };
    const registered = registerAllIpc(ipc, buildDeps());

    // 事件通道是单向推送（无 handler）；同步通道用 on 注册（不适用 handle）
    const expected = flattenChannels().filter(
      (channel) => !EVENT_CHANNELS.includes(channel) && !SYNC_CHANNELS.includes(channel),
    );
    expect(captured.size).toBe(expected.length);
    expect(registered.handlers.size).toBe(expected.length);
    for (const channel of expected) {
      expect(captured.has(channel), `缺少通道 ${channel}`).toBe(true);
    }

    // 同步通道必须真的注册上：漏注册会让渲染层 sendSync 永久阻塞（无对端应答）
    expect([...capturedSync]).toEqual([...SYNC_CHANNELS]);

    registered.dispose();
    expect(registered.handlers.size).toBe(0);
    expect(capturedSync.size).toBe(0);
  });

  it('通道命名空间与 ShellHost 能力一一对应', () => {
    expect(Object.keys(CHANNELS).sort()).toEqual(
      [
        'ai',
        'appInfo',
        'clipboard',
        'dialog',
        'domain',
        'fs',
        'net',
        'openExternal',
        'process',
        'secureStore',
        'updater',
        'window',
      ].sort(),
    );
  });
});
