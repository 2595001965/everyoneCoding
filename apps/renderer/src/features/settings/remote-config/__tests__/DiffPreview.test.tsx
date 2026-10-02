import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ApplyPlan } from '@ec/ai';

import { DiffPreview } from '../DiffPreview';

/** V2-D00：默认模型差异提示必须区分「换模型」与「同名模型仅换渠道」，未确认不切换 */

function renderPreview(plan: ApplyPlan | null, onApply = vi.fn()) {
  render(
    <DiffPreview
      items={[]}
      summary="新增 0 项 · 修改 0 项 · 移除 0 项"
      revision="rev-1"
      plan={plan}
      onApply={onApply}
      onAck={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return onApply;
}

const SWITCH_PLAN: ApplyPlan = {
  revision: 'rev-1',
  items: [],
  defaultModel: 'same-model',
  defaultModelChange: {
    before: 'same-model',
    after: 'same-model',
    providerName: '渠道B',
    providerSwitch: { from: '渠道A', to: '渠道B' },
  },
};

describe('DiffPreview 默认路由差异提示（V2-D00）', () => {
  it('同名模型仅换渠道：文案点明当前与目标渠道，不冒充「更新了默认模型」', () => {
    renderPreview(SWITCH_PLAN);
    const notice = screen.getByRole('alert');
    expect(notice.textContent).toContain('「渠道B」渠道的 same-model');
    expect(notice.textContent).toContain('「渠道A」渠道的 same-model');
    expect(notice.textContent).not.toContain('远程配置更新了默认模型');
  });

  it('普通模型名变更：沿用原有文案', () => {
    renderPreview({
      revision: 'rev-1',
      items: [],
      defaultModel: 'new-model',
      defaultModelChange: {
        before: 'old-model',
        after: 'new-model',
        providerName: null,
      },
    });
    expect(screen.getByRole('alert').textContent).toContain('远程配置更新了默认模型：new-model');
  });

  it('确认按钮回传 ackDefaultModel:true；「保持原样」只 ack 版本不应用', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onAck = vi.fn();
    render(
      <DiffPreview
        items={[]}
        summary=""
        revision="rev-1"
        plan={SWITCH_PLAN}
        onApply={onApply}
        onAck={onAck}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: '应用新默认模型' }));
    expect(onApply).toHaveBeenCalledWith({ overwriteLocal: false, ackDefaultModel: true });
    await user.click(screen.getByRole('button', { name: '保持原样（不再提示）' }));
    expect(onAck).toHaveBeenCalledWith('rev-1');
  });
});
