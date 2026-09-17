import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { PackageApiProvider } from '../package-api';
import { ImportWizard } from '../ImportWizard';
import { createFakeImportApi, type FakeObject } from '../fake-import-ports';
import { conflictItem, diffWithConflicts, failVerify, okVerify } from './import-fixtures';

function renderWizard(api: ReturnType<typeof createFakeImportApi>['api']): void {
  render(
    <PackageApiProvider api={api}>
      <ImportWizard />
    </PackageApiProvider>,
  );
}

describe('ImportWizard：端到端流程', () => {
  it('未注入端口：显示装配引导', () => {
    render(
      <PackageApiProvider api={null}>
        <ImportWizard />
      </PackageApiProvider>,
    );
    expect(screen.getByText(/未装配 PackageApi/)).toBeInTheDocument();
  });

  it('校验失败：展示 failureMessage 与步骤', async () => {
    const fake = createFakeImportApi({ verifyReport: failVerify('integrity', '包完整性校验未通过，损坏/缺失文件：memory/longterm.jsonl') });
    renderWizard(fake.api);
    await userEvent.click(screen.getByText('选择包文件'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('包完整性校验未通过'));
  });

  it('默认不覆盖本地：未决策时禁用，全部保留本地后落库本地仍保留', async () => {
    const localStore: FakeObject[] = [
      { id: 'M1', type: 'memory', projectId: null, name: 'M1', updatedAt: 5, payload: 'local-M1' },
      { id: 'M2', type: 'memory', projectId: null, name: 'M2', updatedAt: 5, payload: 'local-M2' },
    ];
    const fake = createFakeImportApi({
      verifyReport: okVerify(),
      localStore,
      diffPreview: diffWithConflicts([
        conflictItem('M1', 'memory', 'M1', 10, 5),
        conflictItem('M2', 'memory', 'M2', 10, 5),
      ]),
    });
    renderWizard(fake.api);

    await userEvent.click(screen.getByText('选择包文件'));
    await waitFor(() => expect(screen.getByText('选择导入模式')).toBeInTheDocument());
    await userEvent.click(screen.getByText('下一步：差异预览'));
    await waitFor(() => expect(screen.getByTestId('conflict-total')).toHaveTextContent('冲突条目：2'));

    // 未决策：导入按钮禁用 + 未决策徽标
    const importBtn = screen.getByTestId('import-button') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    expect(screen.getByTestId('conflict-undecided')).toHaveTextContent('2 项未决策');

    // 逐条选择"保留本地"
    const keepLocalButtons = screen.getAllByRole('button', { name: '保留本地' });
    await userEvent.click(keepLocalButtons[0]!);
    await userEvent.click(keepLocalButtons[1]!);

    // 决策齐备 → 按钮可点
    await waitFor(() => expect((screen.getByTestId('import-button') as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByTestId('import-button'));

    await waitFor(() => expect(screen.getByTestId('report-title')).toHaveTextContent('导入完成'));
    // 默认保留本地：本地内容未被覆盖
    expect(fake.getStore().get('M1')?.payload).toBe('local-M1');
    expect(fake.getStore().get('M2')?.payload).toBe('local-M2');
  });

  it('keepBoth：落库生成新 id（原本地保留）', async () => {
    const localStore: FakeObject[] = [
      { id: 'M1', type: 'memory', projectId: null, name: 'M1', updatedAt: 5, payload: 'local-M1' },
    ];
    const fake = createFakeImportApi({
      verifyReport: okVerify(),
      localStore,
      diffPreview: diffWithConflicts([conflictItem('M1', 'memory', 'M1', 10, 5)]),
    });
    renderWizard(fake.api);

    await userEvent.click(screen.getByText('选择包文件'));
    await waitFor(() => expect(screen.getByText('选择导入模式')).toBeInTheDocument());
    await userEvent.click(screen.getByText('下一步：差异预览'));
    await waitFor(() => expect(screen.getByTestId('conflict-total')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '两者都保留' }));
    await waitFor(() => expect((screen.getByTestId('import-button') as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByTestId('import-button'));

    await waitFor(() => expect(screen.getByTestId('report-title')).toBeInTheDocument());
    const ids = [...fake.getStore().keys()];
    expect(ids).toContain('M1'); // 原本地保留
    expect(ids.some((id) => id.startsWith('kb-'))).toBe(true); // 新 id 落库
  });

  it('未决策冲突：importPackage 直接调用应被端口拒绝', async () => {
    const fake = createFakeImportApi({
      verifyReport: okVerify(),
      diffPreview: diffWithConflicts([conflictItem('M1', 'memory', 'M1', 10, 5)]),
    });
    await expect(
      fake.api.importPackage({ packagePath: '/x.ecpkg', mode: 'full-restore', decisions: [] }),
    ).rejects.toThrow(/存在未决策的冲突条目/);
  });
});
