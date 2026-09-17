import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '@ec/core';
import { WorkspaceHome } from '../WorkspaceHome';
import { WorkspaceApiProvider } from '../workspace-api';
import { createFakeWorkspace } from './fake-workspace';
import { WorkspacePage } from '../index';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mount(api: ReturnType<typeof createFakeWorkspace>['api']) {
  const onOpenProject = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <WorkspaceApiProvider api={api}>
      <WorkspaceHome onOpenProject={onOpenProject} onOpenSettings={onOpenSettings} />
    </WorkspaceApiProvider>,
  );
  return { onOpenProject, onOpenSettings };
}

describe('工作台异步请求与恢复操作', () => {
  it('再次打开同一项目设置会读取最新数据，不显示过期表单', async () => {
    const { api } = createFakeWorkspace();
    const project = await api.createProject({ name: '旧名称' });
    render(<WorkspacePage api={api} />);
    await screen.findByLabelText('项目 旧名称');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByDisplayValue('旧名称')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
    await api.updateProject(project.id, { name: '新名称' });
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    expect(await screen.findByDisplayValue('新名称')).toBeTruthy();
    expect(screen.queryByDisplayValue('旧名称')).toBeNull();
  });
  it('快速搜索时，较晚返回的旧请求不会覆盖最新结果', async () => {
    const { api } = createFakeWorkspace();
    const first = await api.createProject({ name: '订单系统' });
    await api.createProject({ name: '课程平台' });
    const slow = deferred<ProjectSummary[]>();
    const list = api.listProjects;
    vi.spyOn(api, 'listProjects').mockImplementation((query) =>
      query?.search === '订单' ? slow.promise : list(query),
    );
    mount(api);
    await screen.findByLabelText('项目 课程平台');
    fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: '订单' } });
    fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: '课程' } });
    await screen.findByLabelText('项目 课程平台');
    await act(async () => slow.resolve([first]));
    expect(screen.getByLabelText('项目 课程平台')).toBeTruthy();
    expect(screen.queryByLabelText('项目 订单系统')).toBeNull();
  });

  it('主列表失败显示重试，恢复后显示项目，不误报为新用户空态', async () => {
    const { api } = createFakeWorkspace();
    await api.createProject({ name: '可恢复项目' });
    const list = api.listProjects;
    let failed = true;
    vi.spyOn(api, 'listProjects').mockImplementation((query) =>
      query?.view && failed ? Promise.reject(new Error('数据库暂时不可用')) : list(query),
    );
    mount(api);
    expect(await screen.findByRole('alert')).toHaveTextContent('数据库暂时不可用');
    expect(screen.queryByText('还没有项目')).toBeNull();
    expect(screen.queryByLabelText('新手引导')).toBeNull();
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByLabelText('项目 可恢复项目')).toBeTruthy();
  });

  it('最近打开失败或一直未返回，不阻塞主列表', async () => {
    const { api } = createFakeWorkspace();
    await api.createProject({ name: '主列表项目' });
    const recent = deferred<ProjectSummary[]>();
    const list = api.listProjects;
    vi.spyOn(api, 'listProjects').mockImplementation((query) =>
      query?.recentLimit ? recent.promise : list(query),
    );
    mount(api);
    expect(await screen.findByLabelText('项目 主列表项目')).toBeTruthy();
    await act(async () => recent.reject(new Error('最近打开不可用')));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('某个缩略图失败时仍加载该项目阶段和后续批次', async () => {
    const { api } = createFakeWorkspace();
    for (let i = 0; i < 10; i++) await api.createProject({ name: `项目${i}` });
    vi.spyOn(api, 'getThumbnailUrl').mockRejectedValue(new Error('缩略图不可用'));
    const stage = vi
      .spyOn(api, 'getProjectStage')
      .mockResolvedValue({ stage: 'S2', status: 'ready', confirmed: 1, total: 7 });
    mount(api);
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: '流水线阶段：S2' })).toHaveLength(10),
    );
    expect(stage).toHaveBeenCalledTimes(10);
  });

  it('归档页可以恢复项目，恢复后重新出现在项目页', async () => {
    const { api } = createFakeWorkspace();
    const project = await api.createProject({ name: '归档作品' });
    await api.archiveProject(project.id);
    mount(api);
    fireEvent.click(screen.getByRole('tab', { name: '归档' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消归档' }));
    await screen.findByText('没有归档项目');
    fireEvent.click(screen.getByRole('tab', { name: '项目' }));
    expect(await screen.findByLabelText('项目 归档作品')).toBeTruthy();
  });

  it('列表内的设置、删除操作不会冒泡打开项目', async () => {
    const { api } = createFakeWorkspace();
    const project = await api.createProject({ name: '列表作品' });
    const { onOpenProject, onOpenSettings } = mount(api);
    await screen.findByLabelText('项目 列表作品');
    fireEvent.click(screen.getByRole('button', { name: '切换为列表视图' }));
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onOpenSettings).toHaveBeenCalledWith(project.id);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByRole('dialog', { name: '删除项目确认' })).toBeTruthy();
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it('删除失败保留确认弹窗和项目，操作中不重复提交', async () => {
    const { api } = createFakeWorkspace();
    await api.createProject({ name: '保留作品' });
    const request = deferred<void>();
    const remove = vi.spyOn(api, 'moveToRecycleBin').mockReturnValue(request.promise);
    mount(api);
    await screen.findByLabelText('项目 保留作品');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(screen.getByRole('button', { name: '正在删除…' })).toBeDisabled();
    await act(async () => request.reject(new Error('删除失败，请重试')));
    const dialog = screen.getByRole('dialog', { name: '删除项目确认' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('删除失败，请重试');
    expect(screen.getByLabelText('项目 保留作品')).toBeTruthy();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('无匹配结果提供清除筛选，不误报为没有项目', async () => {
    const { api } = createFakeWorkspace();
    await api.createProject({ name: '已有作品' });
    mount(api);
    await screen.findByLabelText('项目 已有作品');
    fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: '不存在' } });
    expect(await screen.findByText('没有匹配的项目')).toBeTruthy();
    expect(screen.queryByLabelText('新手引导')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(await screen.findByLabelText('项目 已有作品')).toBeTruthy();
  });
});
