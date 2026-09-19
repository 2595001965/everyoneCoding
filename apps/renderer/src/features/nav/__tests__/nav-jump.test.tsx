/**
 * T6-07 渲染层测试：悬停目标列表 / Ctrl + 点击层级跳转 / 数据流浮层。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NAV_TARGET_LABELS } from '@ec/ai';

import { DataFlowOverlay } from '../DataFlowOverlay';
import { JumpOverlay } from '../JumpOverlay';
import { NavApiProvider } from '../nav-api';
import { NavWorkspace } from '../NavWorkspace';
import { createFakeNavApi, SAMPLE_ELEMENT } from './fake-nav';

function renderWith(api: ReturnType<typeof createFakeNavApi>, node: JSX.Element): void {
  render(<NavApiProvider api={api}>{node}</NavApiProvider>);
}

function anchor(): HTMLElement {
  return screen.getByTestId(`jump-anchor-${SAMPLE_ELEMENT.elementId}`);
}

describe('JumpOverlay（T6-07 跳转浮层）', () => {
  it('悬停元素名展示四类目标，且按相关度降序（第一个分数最高）', async () => {
    const api = createFakeNavApi();
    renderWith(api, <JumpOverlay pageId="p1" element={SAMPLE_ELEMENT} />);

    fireEvent.mouseEnter(anchor());

    const list = await screen.findByTestId('jump-target-list');
    expect(list).toBeInTheDocument();

    // 四类目标都出现
    const kinds = ['anc-login', 'tbl-user', 'test-login', 'doc-auth'].map(
      (id) => screen.getByTestId(`jump-kind-${id}`).textContent,
    );
    expect(kinds).toEqual([
      NAV_TARGET_LABELS['backend-api'],
      NAV_TARGET_LABELS['db-table'],
      NAV_TARGET_LABELS['test-case'],
      NAV_TARGET_LABELS['doc-section'],
    ]);

    // 降序
    const scores = ['anc-login', 'tbl-user', 'test-login', 'doc-auth'].map((id) =>
      Number(screen.getByTestId(`jump-score-${id}`).textContent),
    );
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBe(1.4);
    expect(scores[1]).toBeGreaterThan(1);
  });

  it('悬停时把当前文件一起交给端口（就近优先）', async () => {
    const api = createFakeNavApi();
    renderWith(
      api,
      <JumpOverlay pageId="p1" element={SAMPLE_ELEMENT} currentFile="src/login.tsx" />,
    );

    fireEvent.mouseEnter(anchor());
    await waitFor(() => expect(api.calls.hoverTargets).toHaveLength(1));
    expect(api.calls.hoverTargets[0]).toEqual({
      pageId: 'p1',
      elementId: 'e-login',
      elementName: '登录按钮',
      currentFile: 'src/login.tsx',
    });
  });

  it('未按 Ctrl 时点击只展开列表，不执行跳转', async () => {
    const api = createFakeNavApi();
    renderWith(api, <JumpOverlay pageId="p1" element={SAMPLE_ELEMENT} />);

    fireEvent.click(anchor());

    expect(await screen.findByTestId('jump-target-list')).toBeInTheDocument();
    expect(api.calls.resolveJump).toHaveLength(0);
    expect(api.calls.commitJump).toHaveLength(0);
  });

  it('Ctrl + 点击后展示层级下拉（含控制器 / 服务 / 数据访问 / 测试）', async () => {
    const api = createFakeNavApi();
    renderWith(api, <JumpOverlay pageId="p1" element={SAMPLE_ELEMENT} />);

    fireEvent.click(anchor(), { ctrlKey: true });

    const menu = await screen.findByTestId('jump-layer-menu');
    expect(menu).toBeInTheDocument();
    await waitFor(() => expect(api.calls.resolveJump).toHaveLength(1));

    const labels = [0, 1, 2, 3].map(
      (layer) => screen.getByTestId(`jump-layer-${layer}`).textContent ?? '',
    );
    expect(labels[0]).toContain('Controller');
    expect(labels[1]).toContain('Service');
    expect(labels[2]).toContain('数据访问');
    expect(labels[3]).toContain('测试');
  });

  it('window 的 keydown(Control) 被跟踪：此后不带 ctrlKey 的点击同样触发跳转解析', async () => {
    const api = createFakeNavApi();
    renderWith(api, <JumpOverlay pageId="p1" element={SAMPLE_ELEMENT} />);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
    fireEvent.click(anchor());

    await waitFor(() => expect(api.calls.resolveJump).toHaveLength(1));

    // 松开 Ctrl 后回到「只展开列表」
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }));
    fireEvent.click(anchor());
    await waitFor(() => expect(api.calls.hoverTargets).toHaveLength(1));
    expect(await screen.findByTestId('jump-target-list')).toBeInTheDocument();
    expect(api.calls.resolveJump).toHaveLength(1);
  });

  it('在层级下拉里选择目标后调用 commitJump 并关闭浮层', async () => {
    const user = userEvent.setup();
    const api = createFakeNavApi();
    renderWith(api, <JumpOverlay pageId="p1" element={SAMPLE_ELEMENT} />);

    fireEvent.click(anchor(), { ctrlKey: true });
    await screen.findByTestId('jump-layer-menu');

    await user.click(screen.getByTestId('jump-layer-target-anc-svc'));

    await waitFor(() => expect(api.calls.commitJump).toHaveLength(1));
    expect(api.calls.commitJump[0]?.id).toBe('anc-svc');
    expect(api.calls.commitJump[0]?.layer).toBe(1);
    await waitFor(() => expect(screen.queryByTestId('jump-layer-menu')).not.toBeInTheDocument());
  });

  it('点击悬停列表里的目标同样落地跳转', async () => {
    const user = userEvent.setup();
    const api = createFakeNavApi();
    renderWith(api, <JumpOverlay pageId="p1" element={SAMPLE_ELEMENT} />);

    fireEvent.mouseEnter(anchor());
    await screen.findByTestId('jump-target-list');
    await user.click(screen.getByTestId('jump-target-tbl-user'));

    await waitFor(() => expect(api.calls.commitJump).toHaveLength(1));
    expect(api.calls.commitJump[0]?.kind).toBe('db-table');
  });

  it('未注入端口时不崩溃（浮层显式降级为空列表）', () => {
    render(
      <NavApiProvider api={null}>
        <JumpOverlay pageId="p1" element={SAMPLE_ELEMENT} />
      </NavApiProvider>,
    );
    fireEvent.mouseEnter(anchor());
    expect(screen.getByTestId('jump-anchor-e-login')).toBeInTheDocument();
    expect(screen.queryByTestId('jump-target-list')).not.toBeInTheDocument();
  });
});

describe('DataFlowOverlay（T6-07 数据流）', () => {
  function Harness(): JSX.Element {
    return <DataFlowOverlay elementId="e-login" open onOpenChange={() => undefined} />;
  }

  it('按固定次序渲染 6 个环节（元素 → 事件 → 接口 → 后端 → 回写 → 渲染）', async () => {
    const api = createFakeNavApi();
    renderWith(api, <Harness />);

    const steps = await screen.findAllByTestId(/^dataflow-step-/);
    expect(steps).toHaveLength(6);
    expect(steps.map((step) => step.getAttribute('data-order'))).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    expect(steps.map((step) => step.getAttribute('data-testid'))).toEqual([
      'dataflow-step-element',
      'dataflow-step-event',
      'dataflow-step-api',
      'dataflow-step-backend',
      'dataflow-step-writeback',
      'dataflow-step-render',
    ]);
    expect(screen.getByTestId('dataflow-step-element')).toHaveClass('ec-dataflow__step');
  });

  it('失败环节用错误态样式，摘要给出失败数', async () => {
    const api = createFakeNavApi();
    renderWith(api, <Harness />);

    const failed = await screen.findByTestId('dataflow-step-backend');
    expect(failed).toHaveAttribute('data-ok', 'false');
    expect(failed).toHaveClass('ec-dataflow__step--error');
    expect(screen.getByTestId('dataflow-summary')).toHaveTextContent('6 个环节');
    expect(screen.getByTestId('dataflow-summary')).toHaveTextContent('1 个失败');
  });

  it('未打开时不渲染任何内容', () => {
    const api = createFakeNavApi();
    renderWith(
      api,
      <DataFlowOverlay elementId="e-login" open={false} onOpenChange={() => undefined} />,
    );
    expect(screen.queryByTestId('dataflow-overlay')).not.toBeInTheDocument();
  });
});

describe('NavWorkspace（T6-07 组装）', () => {
  it('展示双向跳转成功率，并能为元素打开数据流浮层', async () => {
    const user = userEvent.setup();
    const api = createFakeNavApi();
    const flow = vi.spyOn(api, 'dataFlow');
    renderWith(api, <NavWorkspace pageId="p1" elements={[SAMPLE_ELEMENT]} />);

    const stats = await screen.findByTestId('jump-stats');
    expect(stats).toHaveTextContent('正跳成功率 95%（19/20）');
    expect(stats).toHaveTextContent('反跳成功率 100%（20/20）');

    await user.click(screen.getByTestId('open-flow-e-login'));
    await waitFor(() => expect(flow).toHaveBeenCalledWith('e-login'));
    expect(await screen.findByTestId('dataflow-overlay')).toBeInTheDocument();
  });

  it('没有元素时给出引导而不是空白', async () => {
    const api = createFakeNavApi();
    renderWith(api, <NavWorkspace pageId="p1" elements={[]} />);
    expect(await screen.findByText('没有可跳转的元素')).toBeInTheDocument();
  });
});
