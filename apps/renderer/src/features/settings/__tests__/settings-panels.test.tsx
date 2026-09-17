import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { BackupPanel } from '../BackupPanel';
import { DataLocation } from '../DataLocation';
import { GeneralSettings } from '../GeneralSettings';
import { PrivacyPanel } from '../PrivacyPanel';
import { SettingsHome } from '../SettingsHome';
import { ShortcutSettings, keyFromEvent } from '../ShortcutSettings';
import { SettingsApiProvider, detectKeymapConflicts } from '../settings-api';
import { createFakeSettings, type FakeSettingsEnvironment } from './fake-settings';
import { useUiStore } from '../../../store/useUiStore';

let env: FakeSettingsEnvironment;

beforeEach(() => {
  env = createFakeSettings();
});

function renderWith(node: JSX.Element) {
  render(<SettingsApiProvider api={env.api}>{node}</SettingsApiProvider>);
}

describe('通用设置即时生效（FR-SET-01）', () => {
  it('修改主题后立即写入设置并作用到 DOM（无需重启）', async () => {
    renderWith(<GeneralSettings />);
    await screen.findByLabelText('主题');

    fireEvent.click(screen.getByLabelText('主题'));
    fireEvent.click(screen.getByRole('option', { name: '深色' }));

    await waitFor(() => expect(env.updates.some((patch) => patch.theme === 'dark')).toBe(true));
    // 即时生效：DOM data-theme 被改写
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    expect(await screen.findByText('已保存并即时生效')).toBeTruthy();
  });

  it('语言与编辑器偏好可切换并被持久化到设置对象', async () => {
    renderWith(<GeneralSettings />);
    fireEvent.click(await screen.findByLabelText('界面语言'));
    fireEvent.click(screen.getByRole('option', { name: 'English' }));
    await waitFor(() => expect(env.state.settings.language).toBe('en-US'));
    expect(useUiStore.getState().locale).toBe('en-US');

    fireEvent.click(screen.getByLabelText('编辑器字号'));
    fireEvent.click(screen.getByRole('option', { name: '16 px' }));
    await waitFor(() => expect(env.state.settings.editor.fontSize).toBe(16));

    fireEvent.click(screen.getByRole('switch', { name: '自动换行' }));
    await waitFor(() => expect(env.state.settings.editor.wordWrap).toBe(false));
  });
});

describe('D-02 断言：设置页无任何云端同步入口', () => {
  it('渲染出的设置页不含同步类入口文案', async () => {
    renderWith(<SettingsHome api={env.api} />);
    await screen.findByLabelText('设置类目');

    const nav = screen.getByLabelText('设置类目');
    for (const button of within(nav).getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/同步|云端上传|云盘|分享链接/);
    }
    // 逐个类目走查：任何按钮文案都不出现"同步 / 上传到云"
    for (const label of ['通用', '数据与位置', '导出与备份', '隐私', '快捷键']) {
      fireEvent.click(within(nav).getByRole('button', { name: label }));
      for (const button of screen.getAllByRole('button')) {
        expect(button.textContent ?? '').not.toMatch(/同步|上传到云|云端拉取/);
      }
    }
  });

  it('源码层面不存在云同步实现（api/sync、cloudSync、同步状态等标识符）', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          // 跳过测试目录：断言用的词表字面量不属于实现代码
          if (entry.name === '__tests__') continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    walk(join(root, 'features/settings'));
    walk(join(root, 'layout'));

    const forbidden = [
      /api\/sync/,
      /cloudSync/,
      /syncNow/,
      /同步状态/,
      /立即同步/,
      /上传到云端/,
      /云端拉取/,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      // 先剥注释再匹配：注释里声明"不做云同步"不应算违规（本 Wave 实测踩过）
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const pattern of forbidden) {
        if (pattern.test(source)) offenders.push(`${file} 命中 ${String(pattern)}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(5);
  });
});

describe('数据目录迁移（FR-SET-02/03）', () => {
  it('迁移成功且迁移前后条数一致，显示备份目录', async () => {
    renderWith(<DataLocation />);
    const input = await screen.findByLabelText('工作区根目录');
    fireEvent.change(input, { target: { value: 'E:\\EC' } });
    fireEvent.click(screen.getByRole('button', { name: '迁移数据目录' }));

    expect(await screen.findByText(/迁移完成：条目 120 → 120（一致）/)).toBeTruthy();
    expect(screen.getByText(/旧目录已备份至/)).toBeTruthy();
    expect(env.state.dirs.workspaceRoot).toBe('E:\\EC');
  });

  it('迁移失败展示原因并提供回滚入口（且不谎报成功）', async () => {
    const failing = createFakeSettings({ failMigration: true });
    render(
      <SettingsApiProvider api={failing.api}>
        <DataLocation />
      </SettingsApiProvider>,
    );
    await screen.findByLabelText('工作区根目录');
    fireEvent.click(screen.getByRole('button', { name: '迁移数据目录' }));

    expect((await screen.findAllByText(/迁移校验失败/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '回滚迁移' }));
    expect(await screen.findByRole('status')).toBeTruthy();
  });
});

describe('导出与备份（FR-SET-04）', () => {
  it('完整归档与仅代码导出共用端口，体积按口径区分', async () => {
    renderWith(<BackupPanel projectId="p-1" />);
    await screen.findByLabelText('导出范围');

    fireEvent.click(screen.getByRole('button', { name: '一键导出' }));
    await waitFor(() => expect(env.exports).toHaveLength(1));
    expect(env.exports[0]!.mode).toBe('full');
    expect(await screen.findByText(/已导出 完整归档/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('导出范围'));
    fireEvent.click(screen.getByRole('option', { name: /仅代码/ }));
    fireEvent.click(screen.getByRole('button', { name: '一键导出' }));
    await waitFor(() => expect(env.exports).toHaveLength(2));
    expect(env.exports[1]!.bytes).toBeLessThan(env.exports[0]!.bytes);
  });

  it('未选项目时导出按钮禁用', async () => {
    renderWith(<BackupPanel />);
    const button = await screen.findByRole('button', { name: '一键导出' });
    expect(button).toBeDisabled();
  });

  it('导入归档展示记忆/文档/代码计数与冲突数', async () => {
    renderWith(<BackupPanel projectId="p-1" />);
    fireEvent.change(await screen.findByLabelText('归档包路径'), {
      target: { value: 'D:/backup/a.ecpkg' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导入归档' }));
    expect(await screen.findByText(/记忆 12 条、文档 3 篇、代码 40 个文件/)).toBeTruthy();
    expect(env.imports).toEqual(['D:/backup/a.ecpkg']);
  });

  it('备份计划可保存（间隔 + 目录）', async () => {
    renderWith(<BackupPanel projectId="p-1" />);
    fireEvent.change(await screen.findByLabelText('备份间隔'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('备份目录'), { target: { value: 'E:\\backup' } });
    fireEvent.click(screen.getByRole('button', { name: '保存备份计划' }));
    await waitFor(() =>
      expect(env.state.backupConfig).toMatchObject({ intervalHours: 12, dir: 'E:\\backup' }),
    );
  });
});

describe('隐私（FR-SET-06）', () => {
  it('遥测默认关闭，需显式开启；一键清除后自检为 0', async () => {
    renderWith(<PrivacyPanel />);
    const toggle = await screen.findByRole('switch', { name: '匿名使用数据' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(env.state.telemetryEnabled).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => expect(env.state.telemetryEnabled).toBe(true));
    expect(await screen.findByText(/已开启匿名使用数据上报/)).toBeTruthy();

    expect(screen.getByText(/遥测记录 42 条/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '一键清除本地数据' }));
    await waitFor(() => expect(screen.getByText(/遥测记录 0 条，缓存 0.0 KB/)).toBeTruthy());
    expect(await screen.findByText(/自检无残留/)).toBeTruthy();
  });
});

describe('快捷键（FR-SET-07）', () => {
  it('冲突检测：同一快捷键绑定多个命令', () => {
    const conflicts = detectKeymapConflicts({ a: 'Ctrl+K', b: 'ctrl+k', c: 'Ctrl+L' });
    expect(conflicts).toHaveLength(1);
    expect([...conflicts[0]!.commands].sort()).toEqual(['a', 'b']);
  });

  it('键盘事件合成快捷键串', () => {
    expect(
      keyFromEvent({ key: 'k', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }),
    ).toBe('Ctrl+Shift+K');
    expect(
      keyFromEvent({
        key: 'Control',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      }),
    ).toBe('Ctrl');
  });

  it('存在冲突时禁止保存并提示占用命令', async () => {
    renderWith(<ShortcutSettings />);
    await screen.findByLabelText('新建项目 快捷键');

    fireEvent.change(screen.getByLabelText('新建项目 快捷键'), { target: { value: 'Ctrl+Z' } });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存快捷键' })).toBeDisabled();
    // 冲突提示列出占用该键位命令（keys 归一化为小写）
    expect(screen.getByRole('alert').textContent).toContain('designer.undo');
    expect(screen.getByRole('alert').textContent).toContain('ctrl+z');
  });

  it('无冲突时可保存，且键位方案可导出与导入', async () => {
    renderWith(<ShortcutSettings />);
    await screen.findByLabelText('撤销 快捷键');
    fireEvent.change(screen.getByLabelText('撤销 快捷键'), { target: { value: 'Ctrl+Shift+Z' } });
    fireEvent.click(screen.getByRole('button', { name: '保存快捷键' }));
    await waitFor(() => expect(env.state.keymap['designer.undo']).toBe('Ctrl+Shift+Z'));

    fireEvent.click(screen.getByRole('button', { name: '导出键位方案' }));
    const textarea = (await screen.findByLabelText('键位方案 JSON')) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toContain('designer.undo'));

    fireEvent.change(textarea, { target: { value: JSON.stringify({ 'workspace.new': 'Alt+N' }) } });
    fireEvent.click(screen.getByRole('button', { name: '导入键位方案' }));
    await waitFor(() => expect(env.state.keymap).toEqual({ 'workspace.new': 'Alt+N' }));
    expect(await screen.findByText(/已导入 1 条键位/)).toBeTruthy();
  });
});

describe('设置端口未注入', () => {
  it('保留独立模型服务入口，不因通用设置缺失而隐藏整个设置页', () => {
    render(<SettingsHome api={null} renderAiSection={() => <div>可用的模型服务</div>} />);
    expect(screen.getByText('可用的模型服务')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '通用' }));
    expect(screen.getByText(/设置尚未连接本地配置/)).toBeTruthy();
    expect(screen.queryByText('可用的模型服务')).toBeNull();
  });
  it('展示装配引导而不是崩溃', () => {
    render(<SettingsHome api={null} />);
    expect(screen.getByText(/设置尚未连接本地配置/)).toBeTruthy();
  });
});
