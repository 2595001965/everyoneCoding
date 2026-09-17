/**
 * T7-03 渲染层测试：影响面分析面板（ImpactPanel）。
 *
 * 关键验收（PRD FR-UNI-04）：三级分组、**warn 区默认未勾选**、
 * 顶部总计与预计耗时、`scopeNotice` 原样展示、逐条展开 ±3 行、检索定位。
 */

import { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PROJECT_SCOPE_NOTICE, type ImpactReport } from '@ec/registry';

import { ImpactPanel } from '../ImpactPanel';
import { createFakeRenameApi } from './fake-rename';

async function reportFixture(): Promise<ImpactReport> {
  const fake = createFakeRenameApi();
  return fake.analyze({ registryId: 'reg-1', newName: '登录提交' });
}

/** 受控包装：把 onSelectionChange 接回 state，模拟真实宿主页面 */
function Controlled({ report, onExecute }: { report: ImpactReport; onExecute?: (selection: ReadonlySet<string>) => void }) {
  const [selection, setSelection] = useState<ReadonlySet<string> | undefined>(undefined);
  return (
    <ImpactPanel
      report={report}
      {...(selection !== undefined ? { selection } : {})}
      onSelectionChange={setSelection}
      {...(onExecute !== undefined ? { onExecute } : {})}
    />
  );
}

describe('ImpactPanel', () => {
  it('渲染三级分组，顺序为自动 / 确认 / 警告', async () => {
    const report = await reportFixture();
    render(<Controlled report={report} />);
    const groups = screen.getAllByTestId('risk-group');
    expect(groups.map((group) => group.getAttribute('data-level'))).toEqual(['auto', 'confirm', 'warn']);
  });

  it('warn 区默认未勾选，auto / confirm 默认勾选（FR-UNI-04 硬验收）', async () => {
    const report = await reportFixture();
    render(<Controlled report={report} />);

    const warnGroup = screen.getAllByTestId('risk-group').find((group) => group.getAttribute('data-level') === 'warn');
    expect(warnGroup?.getAttribute('data-selected')).toBe('0');
    expect(warnGroup).toHaveTextContent('已选 0 /');

    const autoGroup = screen.getAllByTestId('risk-group').find((group) => group.getAttribute('data-level') === 'auto');
    expect(autoGroup?.getAttribute('data-selected')).toBe(String(report.totals.auto));
  });

  it('顶部展示总计、预计耗时与项目内边界提示（D-07）', async () => {
    const report = await reportFixture();
    render(<Controlled report={report} />);
    expect(screen.getByTestId('impact-summary')).toHaveTextContent(`将修改 ${report.totals.selected} 处`);
    expect(screen.getByTestId('impact-summary')).toHaveTextContent(`警告区 ${report.totals.warn} 处`);
    expect(screen.getByTestId('impact-elapsed')).toHaveTextContent('预算 1500ms');
    expect(screen.getByTestId('impact-scope-notice')).toHaveTextContent(PROJECT_SCOPE_NOTICE);
    expect(screen.getByTestId('impact-groups-count')).toHaveTextContent(`共 ${report.totals.total} 处`);
  });

  it('检索定位：按文件路径过滤后仅保留命中条目', async () => {
    const user = userEvent.setup();
    const report = await reportFixture();
    render(<Controlled report={report} />);
    const before = screen.getAllByTestId('impact-item').length;

    await user.type(screen.getByLabelText('检索受影响位置'), 'LoginService');
    const after = screen.getAllByTestId('impact-item').length;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    for (const item of screen.getAllByTestId('impact-item')) {
      expect(item.textContent).toContain('LoginService');
    }
  });

  it('勾选变化会回传完整集合，且执行按钮禁用条件正确', async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn();
    const report = await reportFixture();
    render(<Controlled report={report} onExecute={onExecute} />);

    const executeButton = screen.getByTestId('impact-execute');
    expect(executeButton).toHaveTextContent(`确认执行 ${report.totals.selected} 处`);

    // 全部取消勾选 → 按钮禁用
    const warnToggle = screen
      .getAllByTestId('risk-group')
      .filter((group) => group.getAttribute('data-level') !== 'warn')
      .map((group) => group.querySelector<HTMLInputElement>('input[type="checkbox"]'));
    for (const toggle of warnToggle) {
      if (toggle !== null) await user.click(toggle);
    }
    expect(screen.getByTestId('impact-execute')).toBeDisabled();

    // 禁用态用 fireEvent 直送点击：userEvent 会因 pointer-events 而拒绝交互
    fireEvent.click(screen.getByTestId('impact-execute'));
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('勾选 warn 区条目后计入总数并可执行', async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn();
    const report = await reportFixture();
    render(<Controlled report={report} onExecute={onExecute} />);

    const warnGroup = screen
      .getAllByTestId('risk-group')
      .find((group) => group.getAttribute('data-level') === 'warn')!;
    const headerCheckbox = warnGroup.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await user.click(headerCheckbox);

    expect(warnGroup.getAttribute('data-selected')).toBe(String(report.totals.warn));
    expect(screen.getByTestId('impact-execute')).toHaveTextContent(
      `确认执行 ${report.totals.selected + report.totals.warn} 处`,
    );
    await user.click(screen.getByTestId('impact-execute'));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect((onExecute.mock.calls[0]?.[0] as ReadonlySet<string>).size).toBe(
      report.totals.selected + report.totals.warn,
    );
  });

  it('未分析 / 分析中 / 失败三态各自渲染', async () => {
    const { rerender } = render(<ImpactPanel report={null} />);
    expect(screen.getByTestId('impact-panel').getAttribute('data-state')).toBe('empty');

    rerender(<ImpactPanel report={null} loading />);
    expect(screen.getByTestId('impact-panel').getAttribute('data-state')).toBe('loading');
    expect(screen.getByText('正在分析影响面…')).toBeInTheDocument();

    const onReload = vi.fn();
    rerender(<ImpactPanel report={null} error="分析失败" onReload={onReload} />);
    expect(screen.getByTestId('impact-panel').getAttribute('data-state')).toBe('error');
    expect(screen.getByText('分析失败')).toBeInTheDocument();
  });
});
