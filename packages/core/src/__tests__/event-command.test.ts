import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../event-bus';
import { CommandRegistry, formatAccelerator, parseAccelerator } from '../command-registry';

interface TestEvents {
  'project:opened': { id: string };
  'project:closed': { id: string };
  'designer:changed': { count: number };
  'app:error': { message: string };
}

describe('事件总线', () => {
  it('on / emit 传递负载', async () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.on('project:opened', handler);
    await bus.emit('project:opened', { id: 'p1' });
    expect(handler).toHaveBeenCalledWith({ id: 'p1' }, 'project:opened');
  });

  it('once 只触发一次', async () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.once('project:closed', handler);
    await bus.emit('project:closed', { id: 'p1' });
    await bus.emit('project:closed', { id: 'p2' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('off 取消订阅', async () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    const off = bus.on('project:opened', handler);
    off();
    await bus.emit('project:opened', { id: 'p1' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('通配符 * 监听全部事件', async () => {
    const bus = new EventBus<TestEvents>();
    const seen: string[] = [];
    bus.onAny('*', (event) => {
      seen.push(event);
    });
    await bus.emit('project:opened', { id: 'p1' });
    await bus.emit('designer:changed', { count: 1 });
    expect(seen).toEqual(['project:opened', 'designer:changed']);
  });

  it('前缀通配符 domain:* 只匹配该域', async () => {
    const bus = new EventBus<TestEvents>();
    const seen: string[] = [];
    bus.onAny('project:*', (event) => {
      seen.push(event);
    });
    await bus.emit('project:opened', { id: 'p1' });
    await bus.emit('designer:changed', { count: 1 });
    expect(seen).toEqual(['project:opened']);
  });

  it('异步监听串行执行', async () => {
    const bus = new EventBus<TestEvents>();
    const order: string[] = [];
    bus.on('project:opened', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('first');
    });
    bus.on('project:opened', () => {
      order.push('second');
    });
    await bus.emit('project:opened', { id: 'p1' });
    expect(order).toEqual(['first', 'second']);
  });

  it('单个监听抛错不中断其余监听，错误汇总抛出', async () => {
    const bus = new EventBus<TestEvents>();
    const second = vi.fn();
    bus.on('project:opened', () => {
      throw new Error('boom');
    });
    bus.on('project:opened', second);
    await expect(bus.emit('project:opened', { id: 'p1' })).rejects.toThrow(/1 个异常/);
    expect(second).toHaveBeenCalled();
  });

  it('clear 清空全部监听', () => {
    const bus = new EventBus<TestEvents>();
    bus.on('project:opened', () => undefined);
    bus.onAny('*', () => undefined);
    expect(bus.listenerCount()).toBe(2);
    bus.clear();
    expect(bus.listenerCount()).toBe(0);
  });
});

describe('快捷键解析', () => {
  it('解析组合键', () => {
    expect(parseAccelerator('Ctrl+Shift+P')).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
      key: 'P',
    });
  });

  it('识别别名（Cmd / Option / Control）', () => {
    expect(parseAccelerator('Cmd+Option+K')?.meta).toBe(true);
    expect(parseAccelerator('Cmd+Option+K')?.alt).toBe(true);
    expect(parseAccelerator('Control+S')?.ctrl).toBe(true);
  });

  it('非法格式返回 null', () => {
    expect(parseAccelerator(undefined)).toBeNull();
    expect(parseAccelerator('A+B')).toBeNull();
    expect(parseAccelerator('Ctrl+')).toBeNull();
  });

  it('格式化为统一展示形式', () => {
    expect(formatAccelerator('ctrl+shift+p')).toBe('Ctrl+Shift+P');
  });
});

describe('命令系统', () => {
  const buildRegistry = () => {
    const registry = new CommandRegistry<{ projectOpen: boolean }>();
    registry.registerAll([
      { id: 'app.save', title: '保存', group: '文件', shortcut: 'Ctrl+S', execute: vi.fn() },
      { id: 'app.open', title: '打开项目', group: '文件', shortcut: 'Ctrl+O', execute: vi.fn() },
      { id: 'designer.align', title: '对齐选中元素', group: '设计器', execute: vi.fn() },
      {
        id: 'designer.delete',
        title: '删除元素',
        group: '设计器',
        isEnabled: (ctx) => ctx.projectOpen,
        execute: vi.fn(),
      },
    ]);
    return registry;
  };

  it('注册重复 id 直接报错', () => {
    const registry = buildRegistry();
    expect(() =>
      registry.register({ id: 'app.save', title: '重复', group: '文件', execute: vi.fn() }),
    ).toThrow(/重复/);
  });

  it('注册期检测快捷键冲突', () => {
    const registry = buildRegistry();
    expect(() =>
      registry.register({
        id: 'app.other',
        title: '其它',
        group: '文件',
        shortcut: 'Ctrl+S',
        execute: vi.fn(),
      }),
    ).toThrow(/快捷键冲突/);
  });

  it('按 id 执行，未注册或不可用则报错', async () => {
    const registry = buildRegistry();
    await registry.execute('app.save', { projectOpen: true });
    await expect(registry.execute('nope', { projectOpen: true })).rejects.toThrow(/未注册/);
    await expect(registry.execute('designer.delete', { projectOpen: false })).rejects.toThrow(
      /不可用/,
    );
  });

  it('按快捷键反查命令', () => {
    const registry = buildRegistry();
    expect(registry.findByShortcut('Ctrl+S')?.id).toBe('app.save');
    expect(registry.findByShortcut('Ctrl+Shift+S')).toBeUndefined();
  });

  it('detectShortcutConflicts 返回冲突分组', () => {
    const registry = new CommandRegistry();
    // 关闭注册期检测以便人为制造冲突
    const lenient = new CommandRegistry({ detectConflictsOnRegister: false });
    lenient.registerAll([
      { id: 'a', title: 'A', group: 'g', shortcut: 'Ctrl+K', execute: vi.fn() },
      { id: 'b', title: 'B', group: 'g', shortcut: 'Ctrl+K', execute: vi.fn() },
      { id: 'c', title: 'C', group: 'g', shortcut: 'Ctrl+J', execute: vi.fn() },
    ]);
    expect(lenient.detectShortcutConflicts()).toEqual([['a', 'b']]);
    expect(registry.detectShortcutConflicts()).toEqual([]);
  });

  it('命令面板检索：按标题与分组模糊匹配', () => {
    const registry = buildRegistry();
    expect(registry.search('保存').map((c) => c.id)).toEqual(['app.save']);
    expect(
      registry
        .search('文件')
        .map((c) => c.id)
        .sort(),
    ).toEqual(['app.open', 'app.save']);
    expect(
      registry
        .search('元素')
        .map((c) => c.id)
        .sort(),
    ).toEqual(['designer.align', 'designer.delete']);
  });

  it('检索可按上下文过滤不可用命令', () => {
    const registry = buildRegistry();
    expect(registry.search('元素', { projectOpen: false }).map((c) => c.id)).toEqual([
      'designer.align',
    ]);
  });
});
