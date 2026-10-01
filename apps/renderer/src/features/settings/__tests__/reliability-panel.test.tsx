import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AiEventRecord, AiReadiness, FailoverPolicy } from '@ec/ai';

import { AiSettingsProvider, type AiSettingsApi } from '../ai-settings-context';
import { ReliabilityPanel } from '../provider/ReliabilityPanel';

/** T12-08：未配置引导 / 容灾开关 / 脱敏事件在设置页可见 */

const NOT_READY: AiReadiness = {
  ready: false,
  providers: 0,
  enabledProviders: 0,
  providersWithKey: 0,
  models: 0,
  purposes: [],
  steps: [
    {
      id: 'provider',
      done: false,
      label: '添加并启用一个模型服务',
      action: '打开「设置 → 模型服务」新增服务',
    },
    { id: 'key', done: false, label: '填写 API Key', action: '填写后点击「连接测试」' },
    { id: 'model', done: false, label: '至少有一个可用模型', action: '连接测试会自动拉取模型列表' },
  ],
};

function renderPanel(overrides: Partial<AiSettingsApi>) {
  const api = overrides as AiSettingsApi;
  return render(
    <AiSettingsProvider api={api}>
      <ReliabilityPanel />
    </AiSettingsProvider>,
  );
}

describe('ReliabilityPanel', () => {
  it('未配置时列出可执行的下一步', async () => {
    renderPanel({ readiness: async () => NOT_READY });
    const guide = await screen.findByTestId('ec-ai-readiness-guide');
    expect(guide.textContent).toContain('打开「设置 → 模型服务」新增服务');
    expect(guide.textContent).toContain('连接测试');
  });

  it('容灾开关写回同一份配置，并展示脱敏后的事件', async () => {
    let policy: FailoverPolicy = { enabled: true, failureThreshold: 2, resetAfterMs: 300_000 };
    const setFailoverPolicy = vi.fn(async (patch: Partial<FailoverPolicy>) => {
      policy = { ...policy, ...patch };
      return policy;
    });
    const events: AiEventRecord[] = [
      {
        at: Date.now(),
        kind: 'failover',
        providerId: 'P1',
        toProviderId: 'P2',
        message: '上游 503：key test***real',
      },
    ];
    renderPanel({
      readiness: async () => ({ ...NOT_READY, ready: true, steps: [] }),
      failoverPolicy: async () => policy,
      setFailoverPolicy,
      recentEvents: async () => events,
    });

    const toggle = await screen.findByLabelText('启用多服务容灾');
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await userEvent.click(toggle);
    await waitFor(() => expect(setFailoverPolicy).toHaveBeenCalledWith({ enabled: false }));
    expect((await screen.findByTestId('ec-ai-recent-events')).textContent).toContain('切换备用');
  });

  it('端口未实现这些方法时不渲染（旧外壳 / 测试替身）', () => {
    const { container } = renderPanel({});
    expect(container.textContent).toBe('');
  });
});
