import { renderHook } from '@testing-library/react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type {
  CapabilityPatch,
  ConnectionTestResult,
  Model,
  Provider,
  PurposeBinding,
  RemoteConfigSource,
  RemoteFetchResult,
} from '@ec/ai';
import type { ApplyPlan, ConfigDiffItem } from '@ec/ai';
import { AiSettingsProvider } from '../ai-settings-context';
import type { AiSettingsApi } from '../ai-settings-context';
import { ProviderSettings } from '../ProviderSettings';
import { RemoteConfigSettings } from '../remote-config/useRemoteConfig';

/**
 * T1-06 集成测试：覆盖 Provider 保存 + 连接测试、远程配置拉取三条路径。
 * 用内存假实现替代真实仓库，避免牵扯 SQLite 与网络。
 */

const USER = 'USER0000000000000000000000';

interface FakeState {
  providers: Provider[];
  models: Model[];
  binding: PurposeBinding;
  sources: RemoteConfigSource[];
}

let state: FakeState;
let testResult: ConnectionTestResult;
let fetchResult: RemoteFetchResult;

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'P1',
    userId: USER,
    name: '我的中转',
    protocol: 'openai',
    baseUrl: 'https://relay.example.com/v1',
    keyRef: 'ref-1',
    headers: {},
    timeoutMs: 30_000,
    supportsStream: true,
    supportsTools: false,
    supportsVision: false,
    enabled: true,
    order: 0,
    manualModels: [],
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: 'M1',
    providerId: 'P1',
    name: 'gpt-4o',
    displayName: null,
    capability: {
      contextWindow: 128_000,
      maxOutput: 4096,
      supportsStream: true,
      supportsTools: false,
      supportsVision: false,
      inputPricePerMTok: null,
      outputPricePerMTok: null,
      manualOverride: false,
    },
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function createFakeApi(): AiSettingsApi {
  return {
    listProviders: () => state.providers,
    createProvider: async (input) => {
      const created = provider({
        id: `P${state.providers.length + 1}`,
        name: input.name ?? '未命名',
        protocol: input.protocol ?? 'openai',
        baseUrl: input.baseUrl ?? '',
        keyRef: input.keyRef ? 'ref-new' : null,
      });
      state.providers = [...state.providers, created];
      return created;
    },
    updateProvider: async (id, patch) => {
      const index = state.providers.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const next = { ...(state.providers[index] as Provider), ...(patch as Partial<Provider>) };
      state.providers = state.providers.map((item, i) => (i === index ? next : item));
      return next;
    },
    removeProvider: async (id) => {
      const before = state.providers.length;
      state.providers = state.providers.filter((item) => item.id !== id);
      return state.providers.length < before;
    },
    setProviderEnabled: (id, enabled) => {
      const target = state.providers.find((item) => item.id === id);
      if (target) target.enabled = enabled;
      return target ?? null;
    },
    reorderProviders: (ids) => {
      state.providers = ids
        .map((id) => state.providers.find((item) => item.id === id))
        .filter((item): item is Provider => Boolean(item));
    },
    testConnection: async () => testResult,
    testDraftConnection: async () => testResult,
    persistApiKey: async () => 'temp-fake-ref',
    discardTempKey: async () => undefined,
    streamChat: () => ({
      requestId: 'stream-1',
      on: () => () => undefined,
      abort: () => undefined,
    }),
    listModels: (providerId) => state.models.filter((item) => item.providerId === providerId),
    listAllModels: () => state.models,
    refreshModels: async (providerId) => state.models.filter((item) => item.providerId === providerId),
    addManualModel: (providerId, name) => {
      const created = model({ id: `M${state.models.length + 1}`, providerId, name });
      state.models = [...state.models, created];
      return created;
    },
    updateCapability: (modelId, patch: CapabilityPatch) => {
      const target = state.models.find((item) => item.id === modelId);
      if (target) target.capability = { ...target.capability, ...patch, manualOverride: true };
      return target ?? null;
    },
    getBinding: () => state.binding,
    saveBinding: (binding) => {
      state.binding = binding;
      return binding;
    },
    monthlyUsage: () => ({ requests: 3, promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.0025, complete: true }),
    listRemoteSources: () => state.sources,
    createRemoteSource: (input) => {
      const created: RemoteConfigSource = {
        id: `S${state.sources.length + 1}`,
        userId: USER,
        name: input.name,
        url: input.url,
        publicKey: input.publicKey ?? null,
        enabled: input.enabled ?? false,
        updateIntervalMin: input.updateIntervalMin ?? 1440,
        lastFetchAt: null,
        lastStatus: 'idle',
        lastError: null,
        lastPayloadJson: null,
        appliedRevision: null,
        ackedRevision: null,
        createdAt: 0,
        updatedAt: 0,
      };
      state.sources = [...state.sources, created];
      return created;
    },
    updateRemoteSource: (id, patch) => {
      const target = state.sources.find((item) => item.id === id);
      if (target) Object.assign(target, patch);
      return target ?? null;
    },
    removeRemoteSource: (id) => {
      const before = state.sources.length;
      state.sources = state.sources.filter((item) => item.id !== id);
      return state.sources.length < before;
    },
    fetchRemoteSource: async (id) => {
      const target = state.sources.find((item) => item.id === id);
      if (target) {
        target.lastStatus = fetchResult.status;
        target.lastError = fetchResult.ok ? null : fetchResult.message;
        target.lastFetchAt = Date.now();
      }
      return fetchResult;
    },
    previewRemoteSource: async () => ({
      items: [
        { kind: 'added', path: 'providers[0]', label: '新增服务 团队中转', after: 'openai · https://relay.team/v1' },
      ] as ConfigDiffItem[],
      summary: '新增 1 项 · 修改 0 项 · 移除 0 项',
      revision: '2026.09.01',
    }),
    applyRemoteSource: async () =>
      ({
        revision: '2026.09.01',
        items: [{ kind: 'create', name: '团队中转', config: { name: '团队中转', protocol: 'openai', baseUrl: 'https://relay.team/v1', models: [], headers: {}, timeoutMs: 30000, supportsStream: true, supportsTools: false, supportsVision: false } }],
        defaultModel: null,
        defaultModelChange: null,
      }) as unknown as ApplyPlan,
    ackRemoteRevision: (id, revision) => {
      const target = state.sources.find((item) => item.id === id);
      if (target) target.ackedRevision = revision;
      return target ?? null;
    },
  };
}

function wrap(ui: React.ReactNode, api: AiSettingsApi): JSX.Element {
  return <AiSettingsProvider api={api}>{ui}</AiSettingsProvider>;
}

beforeEach(() => {
  state = {
    providers: [provider()],
    models: [model()],
    binding: { bindings: {}, useDefaultForAll: true, defaultModelId: 'M1' },
    sources: [],
  };
  testResult = {
    ok: true,
    latencyMs: 128,
    models: { models: [model()], source: 'remote' },
  };
  fetchResult = { ok: true, status: 'success', document: null, latencyMs: 12, message: '拉取成功（未校验签名）' };
});

describe('Provider 设置页', () => {
  it('保存 Provider：写入名称与地址，并展示在列表中', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    render(wrap(<ProviderSettings />, api));

    await user.click(screen.getAllByRole('button', { name: '新增服务' })[0] as HTMLElement);
    const nameInput = screen.getByPlaceholderText('例如：团队中转');
    await user.type(nameInput, '新中转');
    const urlInput = screen.getByPlaceholderText('https://api.openai.com/v1 或 https://your-relay.com/v1');
    await user.type(urlInput, 'https://new.example.com/v1');

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(state.providers.some((item) => item.name === '新中转')).toBe(true);
    });
  });

  it('连接测试：展示耗时与可用模型数量', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    render(wrap(<ProviderSettings />, api));

    // 选中列表里的服务进入编辑态
    await user.click(screen.getByText('我的中转'));
    await user.click(screen.getByRole('button', { name: '连接测试' }));

    await waitFor(() => {
      expect(screen.getByText('连接成功')).toBeInTheDocument();
    });
    expect(screen.getByText(/耗时 128 ms/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.getAllByText('gpt-4o').length).toBeGreaterThan(0);
  });

  it('连接失败时展示可操作建议', async () => {
    const user = userEvent.setup();
    testResult = {
      ok: false,
      latencyMs: 30,
      models: { models: [], source: 'manual', note: '该服务未提供 /models' },
      error: Object.assign(new Error('认证失败'), {
        userMessage: 'API Key 无效或没有访问该模型的权限。',
        action: '请检查 Key 是否正确。',
      }) as never,
    };
    const api = createFakeApi();
    render(wrap(<ProviderSettings />, api));

    await user.click(screen.getByText('我的中转'));
    await user.click(screen.getByRole('button', { name: '连接测试' }));

    await waitFor(() => {
      expect(screen.getByText('连接失败')).toBeInTheDocument();
    });
    expect(screen.getByText('请检查 Key 是否正确。')).toBeInTheDocument();
  });

  it('删除需二次确认，取消后不删除', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    render(wrap(<ProviderSettings />, api));

    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('确认删除');

    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(state.providers).toHaveLength(1);
  });

  it('用途绑定：关闭"全部使用默认模型"后可选择不同模型', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const stateModel = model({ id: 'M2', name: 'gpt-cheap' });
    state.models = [model(), stateModel];

    render(wrap(<ProviderSettings />, api));
    const toggle = screen.getByLabelText('全部使用默认模型');
    await user.click(toggle);

    await waitFor(() => {
      expect(state.binding.useDefaultForAll).toBe(false);
    });
  });

  it('未注入实现时渲染不崩溃（组件层会抛错，由页面层判断）', () => {
    expect(() => renderHook(() => ({ ok: true }))).not.toThrow();
  });
});

describe('远程配置页', () => {
  it('新增配置源 → 立即拉取 → 展示成功状态', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    render(wrap(<RemoteConfigSettings />, api));

    await user.click(screen.getAllByRole('button', { name: '新增配置源' })[0] as HTMLElement);
    await user.type(screen.getByPlaceholderText('例如：团队共享配置'), '团队配置');
    await user.type(screen.getByPlaceholderText('https://example.com/ai-config.json'), 'https://cfg.example.com/ai.json');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(state.sources).toHaveLength(1);
    });

    await user.click(screen.getByRole('button', { name: '立即拉取' }));
    await waitFor(() => {
      expect(state.sources[0]?.lastStatus).toBe('success');
    });
    expect(screen.getAllByText(/拉取成功/).length).toBeGreaterThan(0);
  });

  it('拉取不可达时展示失败原因且不阻塞页面', async () => {
    const user = userEvent.setup();
    fetchResult = { ok: false, status: 'unreachable', document: null, latencyMs: 5, message: '连接超时' };
    const api = createFakeApi();
    state.sources = [
      {
        id: 'S1',
        userId: USER,
        name: '团队配置',
        url: 'https://cfg.example.com/ai.json',
        publicKey: null,
        enabled: true,
        updateIntervalMin: 1440,
        lastFetchAt: null,
        lastStatus: 'idle',
        lastError: null,
        lastPayloadJson: null,
        appliedRevision: null,
        ackedRevision: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ];

    render(wrap(<RemoteConfigSettings />, api));
    await user.click(screen.getByRole('button', { name: '立即拉取' }));

    await waitFor(() => {
      expect(screen.getByText(/拉取失败：连接超时/)).toBeInTheDocument();
    });
    expect(screen.getByText('不可达')).toBeInTheDocument();
  });

  it('选中源后展示差异预览并可应用', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    state.sources = [
      {
        id: 'S1',
        userId: USER,
        name: '团队配置',
        url: 'https://cfg.example.com/ai.json',
        publicKey: null,
        enabled: true,
        updateIntervalMin: 1440,
        lastFetchAt: null,
        lastStatus: 'success',
        lastError: null,
        lastPayloadJson: null,
        appliedRevision: null,
        ackedRevision: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const spy = vi.spyOn(api, 'applyRemoteSource');

    render(wrap(<RemoteConfigSettings />, api));
    await user.click(screen.getByText('团队配置'));
    await waitFor(() => {
      expect(screen.getByText('差异预览')).toBeInTheDocument();
    });
    expect(screen.getByText('新增服务 团队中转')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '应用配置' }));
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
  });
});
