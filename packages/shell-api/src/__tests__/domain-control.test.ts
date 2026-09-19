import { describe, expect, it } from 'vitest';

import {
  DOMAIN_KINDS,
  DOMAIN_RPC_METHODS,
  WORKSPACE_IMPORT_PROGRESS_EVENT,
  WORKSPACE_IMPORT_STAGES,
  createDomainEventSink,
  createDomainRequestId,
  createLocalEmitter,
  domainErrorFromUnknown,
  domainUnavailableError,
  isDomainKind,
  isDomainRpcMethod,
  isWorkspaceImportProgressEvent,
  sanitizeDomainMessage,
  type DomainDescriptor,
  type DomainRpcRequest,
} from '../domain-control';
import { createMockDomainControlHost } from '../mock';

/**
 * 域端口契约测试。
 *
 * 重点不是"能不能调用"，而是三条边界：
 * 1. 白名单是封闭的（未知域/未知方法必须被拒，不做反射）；
 * 2. 未装配的域必须**如实**回答不可用，不能假装可用；
 * 3. 跨进程回传的错误消息必须已脱敏。
 */

describe('域端口方法白名单', () => {
  it('四个域的方法清单非空且无重复', () => {
    for (const kind of DOMAIN_KINDS) {
      const methods = DOMAIN_RPC_METHODS[kind] as readonly string[];
      expect(methods.length, `${kind} 域方法清单不应为空`).toBeGreaterThan(0);
      expect(new Set(methods).size, `${kind} 域方法清单存在重复`).toBe(methods.length);
    }
  });

  it('isDomainKind 只认四个已登记域', () => {
    for (const kind of DOMAIN_KINDS) expect(isDomainKind(kind)).toBe(true);
    expect(isDomainKind('database')).toBe(false);
    expect(isDomainKind('')).toBe(false);
    expect(isDomainKind(undefined)).toBe(false);
    expect(isDomainKind(42)).toBe(false);
  });

  it('isDomainRpcMethod 拒绝白名单外的方法名', () => {
    expect(isDomainRpcMethod('settings', 'getAll')).toBe(true);
    expect(isDomainRpcMethod('workspace', 'listProjects')).toBe(true);
    expect(isDomainRpcMethod('docs', 'supportedFormats')).toBe(true);
    expect(isDomainRpcMethod('auth', 'login')).toBe(true);
    // 越域调用必须被拒：settings 不存在 login
    expect(isDomainRpcMethod('settings', 'login')).toBe(false);
    // 原型链上的属性名不能成为后门
    expect(isDomainRpcMethod('settings', 'constructor')).toBe(false);
    expect(isDomainRpcMethod('settings', 'toString')).toBe(false);
    expect(isDomainRpcMethod('__proto__', 'getAll')).toBe(false);
  });
});

describe('域端口错误映射', () => {
  it('保留结构化 code 与 retryable', () => {
    const mapped = domainErrorFromUnknown({
      code: 'NOT_FOUND',
      message: '项目不存在',
      retryable: true,
    });
    expect(mapped).toEqual({ code: 'NOT_FOUND', message: '项目不存在', retryable: true });
  });

  it('普通 Error 归为 UNKNOWN 且不带堆栈', () => {
    const mapped = domainErrorFromUnknown(new Error('炸了'));
    expect(mapped.code).toBe('UNKNOWN');
    expect(mapped.message).toBe('炸了');
    expect(Object.keys(mapped)).not.toContain('stack');
  });

  it('回传前脱敏：Bearer / key=value / sk- 前缀都不外泄', () => {
    // Authorization 场景同时断言两件事：密钥确实被抹掉，且占位符没被二次拆碎
    const authorization = sanitizeDomainMessage('Authorization: Bearer abc123def');
    expect(authorization).toBe('Authorization: Bearer ***');
    expect(authorization).not.toContain('abc123def');

    expect(sanitizeDomainMessage('api_key=sk-live-99887766')).not.toContain('sk-live-99887766');
    expect(sanitizeDomainMessage('token: 9f8e7d6c5b')).not.toContain('9f8e7d6c5b');
    expect(sanitizeDomainMessage('bad key sk-abcdefghijkl')).toContain('sk-***');
  });

  it('脱敏不误伤普通诊断文字', () => {
    expect(sanitizeDomainMessage('迁移校验失败：条目数与迁移前不一致')).toBe(
      '迁移校验失败：条目数与迁移前不一致',
    );
    expect(sanitizeDomainMessage('找不到 SQLite 迁移目录')).toBe('找不到 SQLite 迁移目录');
  });

  it('domainUnavailableError 给出 NOT_SUPPORTED 与可读原因', () => {
    const error = domainUnavailableError('auth', '账号服务未配置');
    expect(error.code).toBe('NOT_SUPPORTED');
    expect(error.message).toBe('账号服务未配置');
    expect(error.retryable).toBe(false);
    expect(domainUnavailableError('docs').message).toContain('docs');
  });

  it('requestId 带域前缀，便于日志归因', () => {
    expect(createDomainRequestId('workspace').startsWith('workspace-')).toBe(true);
  });
});

describe('Mock 域宿主如实报告不可用', () => {
  const host = createMockDomainControlHost();

  it('describe 覆盖四个域且全部为不可用并给出原因', async () => {
    const descriptors: DomainDescriptor[] = await host.describe();
    expect(descriptors.map((item) => item.kind).sort()).toEqual([...DOMAIN_KINDS].sort());
    for (const descriptor of descriptors) {
      expect(descriptor.available).toBe(false);
      expect(descriptor.reason).toBeTruthy();
    }
  });

  it('invoke 一律返回 NOT_SUPPORTED，不返回假数据', async () => {
    const request: DomainRpcRequest = {
      requestId: 'settings-test-1',
      domain: 'settings',
      method: 'getAll',
      params: {},
    };
    const response = await host.invoke(request);
    expect(response.ok).toBe(false);
    expect(response.requestId).toBe('settings-test-1');
    expect(response.error?.code).toBe('NOT_SUPPORTED');
    expect(response.result).toBeUndefined();
  });
});

describe('本地订阅分发器', () => {
  it('值未变化时不重复通知，退订后不再收到', () => {
    const emitter = createLocalEmitter(false);
    const seen: boolean[] = [];
    const off = emitter.on((value) => seen.push(value));

    emitter.set(true);
    emitter.set(true);
    expect(seen).toEqual([true]);
    expect(emitter.get()).toBe(true);

    off();
    emitter.set(false);
    expect(seen).toEqual([true]);
    expect(emitter.get()).toBe(false);
  });
});

describe('域事件下发注册表', () => {
  it('只投递给注册了该 requestId 的目标，其余静默丢弃', () => {
    const sink = createDomainEventSink();
    const seen: unknown[] = [];
    sink.register('r1', (event) => seen.push(event.payload));

    sink.send({ requestId: 'r1', domain: 'workspace', payload: 'progress' });
    // 没有订阅者（渲染层未订阅 / 请求已结束）时丢弃，而不是抛出
    sink.send({ requestId: 'r2', domain: 'workspace', payload: 'progress' });
    expect(seen).toEqual(['progress']);
  });

  it('注销后不再投递（请求定局即收口，不留悬空回调）', () => {
    const sink = createDomainEventSink();
    const seen: unknown[] = [];
    sink.register('r1', (event) => seen.push(event.payload));
    sink.unregister('r1');
    sink.send({ requestId: 'r1', domain: 'workspace', payload: 'x' });
    expect(seen).toEqual([]);
  });

  it('重复注册同一 requestId 时后者覆盖（不叠加投递）', () => {
    const sink = createDomainEventSink();
    const first: unknown[] = [];
    const second: unknown[] = [];
    sink.register('r1', (event) => first.push(event.payload));
    sink.register('r1', (event) => second.push(event.payload));
    sink.send({ requestId: 'r1', domain: 'workspace', payload: 'x' });
    expect(first).toEqual([]);
    expect(second).toEqual(['x']);
  });

  it('目标抛错不向外传播（窗口销毁等失败不能反过来打断业务）', () => {
    const sink = createDomainEventSink();
    sink.register('r1', () => {
      throw new Error('窗口已销毁');
    });
    expect(() => sink.send({ requestId: 'r1', domain: 'workspace', payload: 'x' })).not.toThrow();
  });
});

describe('导入进度事件载荷守卫', () => {
  const valid = {
    type: WORKSPACE_IMPORT_PROGRESS_EVENT,
    stage: 'clone',
    ratio: 0.42,
    message: 'Receiving objects:  42%',
  };

  it('三阶段常量与事件名稳定（跨进程判别依据）', () => {
    expect(WORKSPACE_IMPORT_STAGES).toEqual(['clone', 'inspect', 'finalize']);
    expect(WORKSPACE_IMPORT_PROGRESS_EVENT).toBe('workspace:import-progress');
  });

  it('接受合法载荷，含比例不可知阶段的 null', () => {
    expect(isWorkspaceImportProgressEvent(valid)).toBe(true);
    expect(isWorkspaceImportProgressEvent({ ...valid, ratio: 0 })).toBe(true);
    expect(isWorkspaceImportProgressEvent({ ...valid, ratio: 1 })).toBe(true);
    expect(isWorkspaceImportProgressEvent({ ...valid, stage: 'inspect', ratio: null })).toBe(true);
    expect(isWorkspaceImportProgressEvent({ ...valid, stage: 'finalize', ratio: null })).toBe(true);
  });

  it('拒绝形状不符的载荷（脏值不许进 UI）', () => {
    expect(isWorkspaceImportProgressEvent(null)).toBe(false);
    expect(isWorkspaceImportProgressEvent(undefined)).toBe(false);
    expect(isWorkspaceImportProgressEvent('clone')).toBe(false);
    expect(isWorkspaceImportProgressEvent({})).toBe(false);
    // 别的域事件必须被挡掉，不能当成进度
    expect(isWorkspaceImportProgressEvent({ ...valid, type: 'docs:other' })).toBe(false);
    expect(isWorkspaceImportProgressEvent({ ...valid, stage: 'upload' })).toBe(false);
    expect(isWorkspaceImportProgressEvent({ ...valid, message: 3 })).toBe(false);
  });

  it('拒绝越界或非数值的 ratio', () => {
    expect(isWorkspaceImportProgressEvent({ ...valid, ratio: 1.5 })).toBe(false);
    expect(isWorkspaceImportProgressEvent({ ...valid, ratio: -0.1 })).toBe(false);
    expect(isWorkspaceImportProgressEvent({ ...valid, ratio: Number.NaN })).toBe(false);
    expect(isWorkspaceImportProgressEvent({ ...valid, ratio: Number.POSITIVE_INFINITY })).toBe(
      false,
    );
    expect(isWorkspaceImportProgressEvent({ ...valid, ratio: '42%' })).toBe(false);
    expect(isWorkspaceImportProgressEvent({ ...valid, ratio: undefined })).toBe(false);
  });
});
