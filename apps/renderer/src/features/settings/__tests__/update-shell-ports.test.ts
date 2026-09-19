import { describe, expect, it } from 'vitest';
import { MockShell } from '@ec/shell-api';
import { UpdateService } from '@ec/core';

import {
  UPDATE_RUNTIME_FILE,
  createShellUpdatePorts,
  parseVersionFromInstallerName,
} from '../update-shell-ports';

const DATA_DIR = 'C:\\Users\\demo\\AppData\\Local\\EveryoneCoding';

/**
 * 用仓库自带的 `MockShell`（内存文件系统 + 记录进程启动）当假外壳，验证：
 * 端口能从"安装钩子留档的安装包"里按版本号找到备份，并真的把回滚动作发出去。
 */
async function createEnv(installedVersion = '0.1.0') {
  const shell = new MockShell({ dataDir: DATA_DIR, version: installedVersion });
  const seedInstaller = (fileName: string): string => {
    const file = shell.path.join(DATA_DIR, 'updates', 'backup', fileName);
    shell.fs.seed(file, 'MZ-placeholder-installer');
    return file;
  };
  return { shell, seedInstaller };
}

describe('安装包文件名解析版本号', () => {
  it('认 Tauri 下划线命名与 Electron 连字符命名', () => {
    expect(parseVersionFromInstallerName('EveryoneCoding_0.1.0_x64-setup.exe')).toBe('0.1.0');
    expect(parseVersionFromInstallerName('EveryoneCoding-0.2.0-x64-setup.exe')).toBe('0.2.0');
    expect(parseVersionFromInstallerName('EveryoneCoding_1.0.0-beta.1_x64-setup.exe')).toBe(
      '1.0.0-beta.1',
    );
  });

  it('解析不出时返回 null（该文件不算候选备份）', () => {
    expect(parseVersionFromInstallerName('readme.txt')).toBeNull();
    expect(parseVersionFromInstallerName('EveryoneCoding-setup.exe')).toBeNull();
  });
});

describe('外壳更新端口（双形态共用）', () => {
  it('按版本号在留档目录中找到上一版本安装包', async () => {
    const { shell, seedInstaller } = await createEnv();
    const expected = seedInstaller('EveryoneCoding_0.1.0_x64-setup.exe');
    seedInstaller('EveryoneCoding_0.0.9_x64-setup.exe');

    const { ports, backupDir } = await createShellUpdatePorts({ shell });
    expect(backupDir).toBe(shell.path.join(DATA_DIR, 'updates', 'backup'));
    expect(await ports.backupCurrentVersion('0.1.0')).toBe(expected);
    // 只匹配精确版本，不会拿 0.0.9 顶替
    expect(await ports.backupCurrentVersion('0.5.0')).toBeNull();
  });

  it('留档目录不存在时返回 null（台账据此判定 no-backup，不假装可回滚）', async () => {
    const { shell } = await createEnv();
    const { ports } = await createShellUpdatePorts({ shell });
    expect(await ports.backupCurrentVersion('0.1.0')).toBeNull();
  });

  it('回滚会静默重跑留档的安装包（NSIS /S），并触发外壳重启', async () => {
    const { shell, seedInstaller } = await createEnv();
    const installer = seedInstaller('EveryoneCoding_0.1.0_x64-setup.exe');
    let relaunched = 0;
    const { ports } = await createShellUpdatePorts({
      shell,
      relaunch: async () => {
        relaunched += 1;
      },
    });

    await ports.restoreBackup(installer);
    expect(
      shell.process.handles.map((handle) => ({ command: handle.command, args: handle.args })),
    ).toEqual([{ command: installer, args: ['/S'] }]);
    expect(relaunched).toBe(1);
  });

  it('备份文件丢失时回滚抛错（不会静默变成"回滚成功"）', async () => {
    const { shell } = await createEnv();
    const { ports } = await createShellUpdatePorts({ shell });
    await expect(
      ports.restoreBackup(shell.path.join(DATA_DIR, 'nowhere', 'setup.exe')),
    ).rejects.toThrow(/找不到上一版本安装包/);
  });

  it('运行时状态可落盘再读回；坏 JSON 返回 null 不阻塞启动', async () => {
    const { shell } = await createEnv();
    const { ports, runtimeFile } = await createShellUpdatePorts({ shell });
    expect(runtimeFile.endsWith(UPDATE_RUNTIME_FILE)).toBe(true);
    expect(await ports.loadRuntime()).toBeNull();

    const state = {
      lastCheckAt: 1_700_000_000_000,
      reminder: { deferredVersion: '0.2.0', deferredUntil: 1_700_100_000_000, snoozeCount: 1 },
      ledger: { current: null, history: [] },
    };
    await ports.saveRuntime(state);
    expect(await ports.loadRuntime()).toEqual(state);

    shell.fs.seed(runtimeFile, '{ 坏数据');
    expect(await ports.loadRuntime()).toBeNull();
  });

  it('当前版本取自外壳 appInfo（双形态都由外壳提供）', async () => {
    const { shell } = await createEnv('0.4.2');
    const { ports } = await createShellUpdatePorts({ shell });
    expect(await ports.currentVersion()).toBe('0.4.2');
  });

  it('端到端：真实 UpdateService 经外壳端口完成 检查 → 安装留档 → 启动失败 → 回滚重装', async () => {
    const { shell, seedInstaller } = await createEnv('0.1.0');
    const installer = seedInstaller('EveryoneCoding_0.1.0_x64-setup.exe');
    shell.nextUpdateInfo = { version: '0.2.0', notes: '修复若干问题' };

    const { ports } = await createShellUpdatePorts({ shell });
    const service = new UpdateService({ ports, maxBootAttempts: 2 });
    await service.bootstrap();
    expect(await service.install()).toBe(true);
    // 备份路径指向"当前已安装版本"的留档安装包，不是随便一个文件
    expect(service.currentRecord).toMatchObject({
      toVersion: '0.2.0',
      fromVersion: '0.1.0',
      backupPath: installer,
    });

    // 新版本启动即崩：第二次启动由台账判定回滚 → 重跑留档安装包
    shell.nextUpdateInfo = null;
    await service.bootstrap();
    const decision = await service.bootstrap();
    expect(decision).toMatchObject({ decision: 'rollback', restoreFrom: installer });
    expect(shell.process.handles.map((handle) => handle.command)).toContain(installer);
    expect(service.lastSettled?.stage).toBe('rolled-back');
  });
});
