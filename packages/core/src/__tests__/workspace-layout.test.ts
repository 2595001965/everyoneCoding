import { MockShell } from '@ec/shell-api';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceLayout } from '../workspace-layout';

describe('WorkspaceLayout', () => {
  let shell: MockShell;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    shell = new MockShell({ dataDir: 'C:/tmp/ec-core' });
    layout = new WorkspaceLayout(shell, { root: 'C:/workspace' });
  });

  it('按约定生成项目目录路径', () => {
    expect(layout.projectsDir).toBe('C:\\workspace\\projects');
    expect(layout.projectDir('p1')).toContain('p1');
    expect(layout.subdir('p1', 'design')).toContain('design');
  });

  it('create 建立全部子目录且幂等', async () => {
    const created = await layout.create('p1');
    expect(created).toHaveLength(6);
    expect((await layout.validate('p1')).ok).toBe(true);

    const again = await layout.create('p1');
    expect(again).toHaveLength(6);
    expect((await layout.validate('p1')).ok).toBe(true);
  });

  it('validate 报告缺失目录', async () => {
    await layout.create('p2');
    await shell.fs.remove(layout.subdir('p2', 'code'), { recursive: true });
    const result = await layout.validate('p2');
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
  });

  it('repair 修复缺失目录后校验通过', async () => {
    await layout.create('p3');
    await shell.fs.remove(layout.subdir('p3', 'meta'), { recursive: true });
    await shell.fs.remove(layout.subdir('p3', 'docs'), { recursive: true });

    const repaired = await layout.repair('p3');
    expect(repaired).toHaveLength(2);
    expect((await layout.validate('p3')).ok).toBe(true);

    // 已完整时 repair 不做任何事
    expect(await layout.repair('p3')).toEqual([]);
  });

  it('工作区根目录可迁移（FR-SET-03）', async () => {
    layout.setRoot('D:/new-workspace');
    expect(layout.root).toBe('D:/new-workspace');
    await layout.create('p9');
    expect(await shell.fs.exists('D:/new-workspace/projects/p9/meta')).toBe(true);
  });
});
