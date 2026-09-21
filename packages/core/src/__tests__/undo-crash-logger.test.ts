import { MockShell } from '@ec/shell-api';
import { describe, expect, it } from 'vitest';
import {
  CrashRecovery,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  MAX_RECOVERY_WINDOW_MS,
} from '../crash-recovery';
import { Logger, memoryTransport } from '../logger';
import { UndoManager, UndoManagerRegistry } from '../undo-manager';

interface DesignerState {
  elements: Array<{ id: string; x: number }>;
}

describe('撤销重做', () => {
  const setup = () => {
    let state: DesignerState = { elements: [{ id: 'a', x: 0 }] };
    const manager = new UndoManager<DesignerState>({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      limit: 5,
      coalesceWindowMs: 1000,
    });
    return {
      manager,
      get: () => state,
      set: (next: DesignerState) => {
        state = next;
      },
    };
  };

  it('apply 后状态变更并可 undo / redo', () => {
    const { manager, get } = setup();
    manager.apply('移动元素', (draft) => {
      draft.elements[0]!.x = 10;
    });
    expect(get().elements[0]?.x).toBe(10);

    manager.undo();
    expect(get().elements[0]?.x).toBe(0);

    manager.redo();
    expect(get().elements[0]?.x).toBe(10);
  });

  it('连续同类操作在合并窗口内合并为一步', () => {
    const { manager, get } = setup();
    for (let i = 1; i <= 5; i += 1) {
      manager.apply('移动元素', (draft) => {
        draft.elements[0]!.x = i;
      });
    }
    expect(manager.undoDepth).toBe(1);
    expect(get().elements[0]?.x).toBe(5);

    manager.undo();
    expect(get().elements[0]?.x).toBe(0);
  });

  it('不同 label 不合并', () => {
    const { manager } = setup();
    manager.apply('移动元素', (d) => {
      d.elements[0]!.x = 1;
    });
    manager.apply('改样式', (d) => {
      d.elements[0]!.x = 2;
    });
    expect(manager.undoDepth).toBe(2);
  });

  it('栈深超限后丢弃最旧的', () => {
    let state = { n: 0 };
    const manager = new UndoManager<{ n: number }>({
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      limit: 3,
      coalesceWindowMs: 0,
    });
    for (let i = 1; i <= 5; i += 1) {
      manager.apply(`op${i}`, (d) => {
        d.n = i;
      });
    }
    expect(manager.undoDepth).toBe(3);
  });

  it('新变更使 redo 栈失效', () => {
    const { manager } = setup();
    manager.apply('A', (d) => {
      d.elements[0]!.x = 1;
    });
    manager.undo();
    expect(manager.canRedo).toBe(true);
    manager.apply('B', (d) => {
      d.elements[0]!.x = 2;
    });
    expect(manager.canRedo).toBe(false);
  });

  it('无变化时不入栈', () => {
    const { manager } = setup();
    manager.apply('无操作', () => undefined);
    expect(manager.canUndo).toBe(false);
  });

  it('多域撤销栈互相隔离', () => {
    const registry = new UndoManagerRegistry();
    const a = setup().manager;
    const b = setup().manager;
    registry.register('designer', a);
    registry.register('memory', b);

    a.apply('改设计', (d) => {
      d.elements[0]!.x = 9;
    });
    expect(registry.get<DesignerState>('designer')?.canUndo).toBe(true);
    expect(registry.get<DesignerState>('memory')?.canUndo).toBe(false);
    expect(registry.domains()).toEqual(['designer', 'memory']);

    registry.clear('designer');
    expect(a.canUndo).toBe(false);
  });
});

describe('崩溃恢复', () => {
  const setup = (intervalMs = 1000) => {
    const shell = new MockShell({ dataDir: 'C:/tmp/ec-core' });
    const dir = 'C:/tmp/ec-core/snapshots';
    const recovery = new CrashRecovery({ shell, dir, intervalMs });
    let state = { count: 0 };
    recovery.register({
      domain: 'designer',
      getState: () => state,
      applyState: (next) => {
        state = next;
      },
    });
    return { shell, dir, recovery, getState: () => state };
  };

  it('快照间隔不超过 30s 丢失窗口', () => {
    expect(DEFAULT_SNAPSHOT_INTERVAL_MS).toBeLessThanOrEqual(MAX_RECOVERY_WINDOW_MS);
    expect(() => setup(60_000)).toThrow(/超过最大恢复窗口/);
  });

  it('正常退出后无待恢复快照', async () => {
    const { recovery } = setup();
    await recovery.snapshotNow();
    expect(await recovery.detectPending()).toHaveLength(1);

    await recovery.markClean();
    expect(await recovery.detectPending()).toHaveLength(0);
  });

  it('模拟强杀：dirty 快照可在重启后被检出并恢复', async () => {
    const { recovery, getState, shell, dir } = setup();
    (getState() as { count: number }).count = 42;
    await recovery.snapshotNow();

    // 模拟进程被强杀：新建实例（未 markClean），状态归零
    (getState() as { count: number }).count = 0;
    const restarted = new CrashRecovery({ shell, dir, intervalMs: 1000 });
    let restored = { count: 0 };
    restarted.register({
      domain: 'designer',
      getState: () => restored,
      applyState: (next) => {
        restored = next as { count: number };
      },
    });

    const pending = await restarted.detectPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.domain).toBe('designer');

    expect(await restarted.restore('designer')).toBe(true);
    expect(restored.count).toBe(42);
  });

  it('可丢弃不需要恢复的快照', async () => {
    const { recovery } = setup();
    await recovery.snapshotNow();
    await recovery.discard('designer');
    expect(await recovery.detectPending()).toHaveLength(0);
  });

  it('域名含非法文件名字符（pipeline:P-1）时快照仍能被 readdir 检出并恢复', async () => {
    const shell = new MockShell({ dataDir: 'C:/tmp/ec-core' });
    const dir = 'C:/tmp/ec-core/snapshots';
    const recovery = new CrashRecovery({ shell, dir, intervalMs: 1000 });
    let state = { step: 'S5' };
    recovery.register({
      domain: 'pipeline:P-1',
      getState: () => state,
      applyState: (next) => {
        state = next as { step: string };
      },
    });
    await recovery.snapshotNow();

    // Windows 上路径里的 `:` 会被解释成 NTFS 备用数据流：写入/读取/exists 全都"成功"，
    // 但 readdir 永远列不出这个条目 ⇒ 脏快照检测静默失效。落盘名必须已净化。
    const names = (await shell.fs.readdir(dir)).map((entry) => entry.name);
    expect(names).toEqual(['pipeline_P-1.snapshot.json']);

    // 净化只作用于文件名：信封里保留逻辑域名，detectPending / restore 仍按域名匹配
    const pending = await recovery.detectPending();
    expect(pending.map((item) => item.domain)).toEqual(['pipeline:P-1']);
    expect(await recovery.restore('pipeline:P-1')).toBe(true);
    expect(state).toEqual({ step: 'S5' });
  });

  it('快照年龄可用于校验恢复窗口', async () => {
    const { recovery } = setup();
    await recovery.snapshotNow();
    const age = await recovery.snapshotAge('designer');
    expect(age).not.toBeNull();
    expect(age ?? Number.MAX_SAFE_INTEGER).toBeLessThan(MAX_RECOVERY_WINDOW_MS);
  });

  it('损坏的快照不影响启动检测', async () => {
    const { shell, dir } = setup();
    await shell.fs.mkdir(dir, { recursive: true });
    await shell.fs.writeAtomic(`${dir}/designer.snapshot.json`, '{ 这不是合法 JSON');
    const recovery = new CrashRecovery({ shell, dir, intervalMs: 1000 });
    expect(await recovery.detectPending()).toHaveLength(0);
  });

  it('start / stop 控制定时快照', async () => {
    const { recovery, shell, dir } = setup(50);
    const holder: { tick: (() => void) | null } = { tick: null };
    const scheduled = new CrashRecovery({
      shell,
      dir,
      intervalMs: 50,
      schedule: (task) => {
        holder.tick = task;
        return () => {
          holder.tick = null;
        };
      },
    });
    scheduled.start();
    expect(holder.tick).not.toBeNull();
    holder.tick?.();
    scheduled.stop();
    expect(holder.tick).toBeNull();
    await recovery.snapshotNow();
  });
});

describe('日志', () => {
  it('分级过滤生效', () => {
    const transport = memoryTransport();
    const logger = new Logger({ level: 'warn', transports: [transport] });
    logger.debug('忽略');
    logger.info('忽略');
    logger.warn('警告');
    logger.error('错误');
    expect(transport.entries).toHaveLength(2);
    expect(transport.entries[0]?.level).toBe('warn');
  });

  it('输出自动脱敏，明文密钥不进日志', () => {
    const transport = memoryTransport();
    const logger = new Logger({ level: 'debug', transports: [transport] });
    logger.info('调用模型失败 key=sk-liveabcdef123456');
    expect(transport.text()).not.toContain('sk-liveabcdef123456');
  });

  it('子日志器继承级别与 transport', () => {
    const transport = memoryTransport();
    const parent = new Logger({ scope: 'app', level: 'debug', transports: [transport] });
    const child = parent.child('designer');
    child.info('hi');
    expect(transport.entries[0]?.scope).toBe('app:designer');
  });

  it('结构化 data 同样被脱敏', () => {
    const transport = memoryTransport();
    const logger = new Logger({ level: 'debug', transports: [transport] });
    logger.error('请求失败', {
      authorization: 'Bearer abcdef123456',
      url: 'https://api.example.com',
    });
    expect(JSON.stringify(transport.entries)).not.toContain('abcdef123456');
    expect(JSON.stringify(transport.entries)).toContain('api.example.com');
  });
});
