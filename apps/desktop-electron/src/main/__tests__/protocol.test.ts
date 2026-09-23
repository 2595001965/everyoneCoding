import { describe, expect, it, vi } from 'vitest';

import {
  createProtocolBridge,
  extractProtocolUrl,
  installOAuthProtocol,
  OAUTH_PROTOCOL_SCHEME,
  type ProtocolAppLike,
} from '../protocol';

/**
 * OAuth 自定义协议通道测试。
 *
 * 这里**不 mock 判定逻辑**：`extractProtocolUrl` 与 `createProtocolBridge` 跑真实实现，
 * 只有 Electron `app` 用假对象。目的是验证"协议回调最终会被交给 auth 域的处理器"，
 * 而不是只验证 `app.on` 被注册过 —— 后者在 URL 丢弃、时序错位时照样全绿。
 */

/** 假 Electron app：记录监听器与协议注册调用，可编程触发事件 */
class FakeApp implements ProtocolAppLike {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly registrations: Array<{
    scheme: string;
    execPath?: string | undefined;
    args?: string[] | undefined;
  }> = [];
  lock = true;
  quitCalls = 0;
  registerResult = true;

  requestSingleInstanceLock(): boolean {
    return this.lock;
  }

  quit(): void {
    this.quitCalls += 1;
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  setAsDefaultProtocolClient(scheme: string, execPath?: string, args?: string[]): boolean {
    this.registrations.push({ scheme, execPath, args });
    return this.registerResult;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function makeLogger(): {
  info: (m: string) => void;
  warn: (m: string) => void;
  infos: string[];
  warns: string[];
} {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    info: (message) => infos.push(message),
    warn: (message) => warns.push(message),
  };
}

const CALLBACK = 'everyonecoding://oauth?code=abc&state=srv-1';

function install(
  app: FakeApp,
  overrides: Partial<Parameters<typeof installOAuthProtocol>[0]> = {},
) {
  return installOAuthProtocol({
    app,
    isPackaged: false,
    execPath: 'C:/electron/electron.exe',
    entryScript: 'C:/app/dist/main/index.cjs',
    argv: ['C:/electron/electron.exe'],
    logger: makeLogger(),
    ...overrides,
  });
}

describe('extractProtocolUrl：从 argv 里精确挑出本应用的协议 URL', () => {
  it('命中 everyonecoding:// 前缀并原样返回（含查询串）', () => {
    expect(extractProtocolUrl(['app.exe', CALLBACK])).toBe(CALLBACK);
  });

  it('大小写不敏感（Windows 注册表拉起可能保留用户输入的大小写）', () => {
    expect(extractProtocolUrl(['app.exe', 'EveryoneCoding://oauth?code=x'])).toBe(
      'EveryoneCoding://oauth?code=x',
    );
  });

  it('不把"路径里恰好含该词"的目录误判成回调', () => {
    // 宽松判定（includes）会把下面这条当成命中，从而用错误的 URL 去换令牌
    expect(extractProtocolUrl(['C:/tools/everyonecoding/notes', '--flag'])).toBeNull();
    expect(extractProtocolUrl(['--everyonecoding=1'])).toBeNull();
  });

  it('没有协议 URL 时返回 null，忽略 Electron 自己的开关参数', () => {
    expect(extractProtocolUrl(['app.exe', '--allow-file-access-from-files'])).toBeNull();
    expect(extractProtocolUrl([])).toBeNull();
  });

  it('scheme 可覆盖（测试与多环境命名用）', () => {
    expect(extractProtocolUrl(['x', 'myapp://cb?code=1'], 'myapp')).toBe('myapp://cb?code=1');
  });
});

describe('createProtocolBridge：回调投递的时序保证', () => {
  it('注册前到达的回调先排队，注册后按到达顺序补投（不丢、不乱序）', () => {
    const bridge = createProtocolBridge();
    const received: string[] = [];

    bridge.deliver('everyonecoding://oauth?state=a');
    bridge.deliver('everyonecoding://oauth?state=b');
    expect(bridge.pendingCount()).toBe(2);

    bridge.register((url) => received.push(url));
    expect(received).toEqual(['everyonecoding://oauth?state=a', 'everyonecoding://oauth?state=b']);
    expect(bridge.pendingCount()).toBe(0);
  });

  it('注册后到达的回调直投，不再排队', () => {
    const bridge = createProtocolBridge();
    const received: string[] = [];
    bridge.register((url) => received.push(url));
    bridge.deliver('everyonecoding://oauth?state=c');
    expect(received).toEqual(['everyonecoding://oauth?state=c']);
    expect(bridge.pendingCount()).toBe(0);
  });

  it('重复注册时后来者生效（每次 beginOAuth 带新 codeVerifier 的闭包）', () => {
    const bridge = createProtocolBridge();
    const first: string[] = [];
    const second: string[] = [];
    bridge.register((url) => first.push(url));
    bridge.register((url) => second.push(url));
    bridge.deliver('everyonecoding://oauth?state=d');

    expect(first).toEqual([]);
    expect(second).toEqual(['everyonecoding://oauth?state=d']);
  });

  it('空/非字符串输入被忽略（异常输入不占用队列）', () => {
    const bridge = createProtocolBridge();
    bridge.deliver('');
    bridge.deliver(undefined as unknown as string);
    expect(bridge.pendingCount()).toBe(0);
  });

  it('排队有上限：只保留最近若干条，避免异常输入撑大内存', () => {
    const bridge = createProtocolBridge();
    for (let index = 0; index < 20; index += 1) {
      bridge.deliver(`everyonecoding://oauth?state=s${index}`);
    }
    expect(bridge.pendingCount()).toBe(8);

    const received: string[] = [];
    bridge.register((url) => received.push(url));
    // 保留的是最后 8 条（s12..s19）
    expect(received[0]).toBe('everyonecoding://oauth?state=s12');
    expect(received[received.length - 1]).toBe('everyonecoding://oauth?state=s19');
  });
});

describe('installOAuthProtocol：外壳事件与协议注册接线', () => {
  it('second-instance 携带协议 URL：聚焦已有窗口并把 URL 投给处理器', () => {
    const app = new FakeApp();
    const focusWindow = vi.fn();
    const bridge = install(app, { focusWindow });
    const received: string[] = [];
    bridge.register((url) => received.push(url));

    app.emit('second-instance', {}, ['app.exe', CALLBACK], 'C:/cwd', {});

    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(received).toEqual([CALLBACK]);
  });

  it('second-instance 不带协议 URL（只是重复启动）：仍聚焦窗口，但不伪造回调', () => {
    const app = new FakeApp();
    const focusWindow = vi.fn();
    const bridge = install(app, { focusWindow });
    const received: string[] = [];
    bridge.register((url) => received.push(url));

    app.emit('second-instance', {}, ['app.exe'], 'C:/cwd', {});

    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
  });

  it('macOS open-url：preventDefault 后投递（否则系统会再开一次）', () => {
    const app = new FakeApp();
    const bridge = install(app);
    const received: string[] = [];
    bridge.register((url) => received.push(url));

    const preventDefault = vi.fn();
    app.emit('open-url', { preventDefault }, CALLBACK);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(received).toEqual([CALLBACK]);
  });

  it('冷启动：本次进程就是被协议拉起的，URL 在 argv 里 → 排队等注册后补投', () => {
    const app = new FakeApp();
    const bridge = install(app, { argv: ['app.exe', CALLBACK] });

    // 此刻运行时尚在装配，auth 域还没申请接管 —— URL 不能丢
    expect(bridge.pendingCount()).toBe(1);

    const received: string[] = [];
    bridge.register((url) => received.push(url));
    expect(received).toEqual([CALLBACK]);
  });

  it('开发态注册必须显式带 execPath + 入口脚本（裸 electron.exe 不是可用的处理器）', () => {
    const app = new FakeApp();
    install(app, {
      isPackaged: false,
      execPath: 'C:/electron/electron.exe',
      entryScript: 'C:/app/dist/main/index.cjs',
    });

    expect(app.registrations).toEqual([
      {
        scheme: OAUTH_PROTOCOL_SCHEME,
        execPath: 'C:/electron/electron.exe',
        args: ['C:/app/dist/main/index.cjs'],
      },
    ]);
  });

  it('打包态注册不带额外参数（scheme 直接指向当前可执行文件）', () => {
    const app = new FakeApp();
    install(app, { isPackaged: true });

    expect(app.registrations).toEqual([
      { scheme: OAUTH_PROTOCOL_SCHEME, execPath: undefined, args: undefined },
    ]);
  });

  it('注册被系统拒绝：不抛错、不阻止启动，但留下可排查的告警', () => {
    const app = new FakeApp();
    app.registerResult = false;
    const logger = makeLogger();

    const bridge = install(app, { logger });

    expect(bridge.pendingCount()).toBe(0);
    expect(logger.warns.join('\n')).toContain('注册失败');
    expect(logger.warns.join('\n')).toContain('回环');
  });

  it('注册抛异常（策略拦截）：同样只降级告警，进程继续可用', () => {
    const app = new FakeApp();
    app.setAsDefaultProtocolClient = () => {
      throw new Error('access denied');
    };
    const logger = makeLogger();

    expect(() => install(app, { logger })).not.toThrow();
    expect(logger.warns.join('\n')).toContain('access denied');
  });

  it('注册成功时留下成功痕迹（用于确认通道真的可用）', () => {
    const app = new FakeApp();
    const logger = makeLogger();
    install(app, { logger });
    expect(logger.infos.join('\n')).toContain('已注册');
  });
});
