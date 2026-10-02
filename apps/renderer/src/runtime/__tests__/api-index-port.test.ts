import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiIndexApi, installProductionPorts } from '../production-ports';
import { navigateToLocation, useNavLocation } from '../nav-location';
import { useProjectStore } from '../../store/useProjectStore';
import type { DomainCaller } from '../domain-ports';
import type { DomainControlHost } from '@ec/shell-api';
import type { SourceRef } from '@ec/core';

beforeEach(() => {
  useProjectStore
    .getState()
    .openProject({ id: 'p-api', name: '接口', targetPlatforms: ['web'], updatedAt: 0 });
  useNavLocation.setState({ target: null });
});
describe('D04 共用异步生产端口（Electron/Tauri）', () => {
  it('新方法只经 nav 白名单，附带真实项目与版本；缺同步口仍可注入', async () => {
    const invoke = vi.fn(async () => ({ requestId: 'r', ok: true, result: null }));
    const host = {
      invoke,
      describe: async () => [{ kind: 'nav', available: true }],
    } as DomainControlHost;
    const call = vi.fn(async () => null),
      caller = { call } as DomainCaller,
      globals: Record<string, unknown> = {};
    const installed = await installProductionPorts(
      host,
      caller,
      () => () => {},
      new Set(['nav']),
      globals,
    );
    expect(installed.installed).toEqual(['nav']);
    expect(globals['__EC_API_INDEX__']).toBeTruthy();
    const api = createApiIndexApi(caller);
    await api.list();
    await api.rescan();
    await api.classify({ endpointId: 'e', revision: 3, group: '业务', tags: ['核心'] });
    expect(call).toHaveBeenNthCalledWith(1, 'nav', 'apiList', { projectId: 'p-api' });
    expect(call).toHaveBeenNthCalledWith(3, 'nav', 'apiClassify', {
      projectId: 'p-api',
      endpointId: 'e',
      revision: 3,
      group: '业务',
      tags: ['核心'],
    });
  });
  it('源码导航先验证，跨项目返回不会跳错；接口反向导航有生产路由', async () => {
    const ref: SourceRef = { filePath: 'api.ts', startLine: 8, endLine: 8, symbol: 'handler' };
    let finish: (ref: SourceRef) => void = () => {};
    const caller = {
      call: vi.fn(
        () =>
          new Promise<SourceRef>((resolve) => {
            finish = resolve;
          }),
      ),
    } as DomainCaller;
    const navigation = createApiIndexApi(caller).navigate(ref);
    useProjectStore
      .getState()
      .openProject({ id: 'other', name: '另一个项目', targetPlatforms: ['web'], updatedAt: 0 });
    finish(ref);
    await navigation;
    expect(useNavLocation.getState().target).toBeNull();
    navigateToLocation({ projectId: 'other', endpointIds: ['e'] });
    expect(location.hash).toBe('#/apis');
  });
});
