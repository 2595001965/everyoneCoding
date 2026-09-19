import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultPresetFor, canvasSizeOf } from '@ec/designer';
import { RECYCLE_BIN_RETENTION_MS } from '@ec/core';

import { NewProjectDialog } from '../NewProjectDialog';
import { ProjectSettings } from '../ProjectSettings';
import { RecycleBin } from '../RecycleBin';
import { WorkspaceHome, GRID_WINDOW_SIZE } from '../WorkspaceHome';
import { WorkspaceApiProvider, type WorkspaceApi, type WorkspaceImportProgress } from '../workspace-api';
import { buildTargetsPayload, onTargetsChanged, type TargetsChangedPayload } from '../workspace-events';
import { createFakeWorkspace, seedProjects, type FakeWorkspaceEnvironment } from './fake-workspace';
import { normalizeTiming, reportTiming } from './perf-probe';

let env: FakeWorkspaceEnvironment;

beforeEach(() => {
  env = createFakeWorkspace();
});

function renderHome(onOpenProject = vi.fn(), onOpenSettings = vi.fn()) {
  render(
    <WorkspaceApiProvider api={env.api}>
      <WorkspaceHome onOpenProject={onOpenProject} onOpenSettings={onOpenSettings} />
    </WorkspaceApiProvider>,
  );
  return { onOpenProject, onOpenSettings };
}

describe('工作台首页（FR-WSP-01/04）', () => {
  it('空态展示引导，创建后出现卡片并写库', async () => {
    renderHome();
    expect(await screen.findByText('还没有项目')).toBeTruthy();

    await env.api.createProject({ name: '订单系统' });
    // 触发重新加载：切换标签再切回
    fireEvent.click(screen.getByRole('tab', { name: '归档' }));
    fireEvent.click(screen.getByRole('tab', { name: '项目' }));
    expect(await screen.findByLabelText('项目 订单系统')).toBeTruthy();
  });

  it('搜索、仅看收藏、排序生效（真实查询语义）', async () => {
    await env.api.createProject({ name: '订单系统' });
    await env.api.createProject({ name: '课程平台' });
    renderHome();
    await screen.findByLabelText('项目 课程平台');

    fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: '订单' } });
    await waitFor(() => expect(screen.queryByLabelText('项目 课程平台')).toBeNull());
    expect(screen.getByLabelText('项目 订单系统')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: '' } });
    await screen.findByLabelText('项目 课程平台');
    fireEvent.click(screen.getByRole('checkbox', { name: /仅看收藏/ }));
    await waitFor(() => expect(screen.queryByLabelText('项目 订单系统')).toBeNull());

    fireEvent.click(screen.getByRole('checkbox', { name: /仅看收藏/ }));
    await screen.findByLabelText('项目 订单系统');
    fireEvent.change(screen.getByLabelText('排序方式'), { target: { value: 'name' } });
    await screen.findByLabelText('项目 订单系统');
  });

  it('置顶后卡片状态更新（★ / aria-pressed）', async () => {
    const project = await env.api.createProject({ name: '置顶测试' });
    renderHome();
    const pin = await screen.findByRole('button', { name: '置顶 置顶测试' });
    fireEvent.click(pin);
    await waitFor(() => expect(env.store.rows.get(project.id)?.pinned).toBe(1));
    expect(await screen.findByRole('button', { name: '取消置顶 置顶测试' })).toBeTruthy();
  });

  it('最近打开区展示已打开过的项目（保留最近 10 条口径）', async () => {
    const first = await env.api.createProject({ name: '最近项目A' });
    await env.api.createProject({ name: '最近项目B' });
    env.setNow(RECYCLE_BIN_RETENTION_MS + 5000);
    await env.api.markOpened(first.id);
    renderHome();
    const recent = await screen.findByLabelText('最近打开');
    expect(within(recent).getByRole('button', { name: '最近项目A' })).toBeTruthy();
  });

  it('删除需二次确认，确认后进回收站（列表消失）', async () => {
    const project = await env.api.createProject({ name: '待删除项目' });
    renderHome();
    await screen.findByLabelText('项目 待删除项目');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    const dialog = await screen.findByRole('dialog', { name: '删除项目确认' });
    expect(within(dialog).getByText(/保留 30 天可恢复/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(env.store.rows.get(project.id)?.deleted_at).not.toBeNull());
    await waitFor(() => expect(screen.queryByLabelText('项目 待删除项目')).toBeNull());
  });
});

describe('工作台性能（100 项目首屏 ≤1s）', () => {
  it('首屏只挂载窗口内的卡片，且渲染耗时在预算内（实测打印）', async () => {
    await seedProjects(env, 100);

    /**
     * 性能口径 = **按机器吞吐归一化后的耗时**（与 T7-02 `occurrence.test.ts` 同一方法）。
     *
     * 为什么不能直接断言绝对毫秒：本仓 vitest 全量并行跑（8 worker 抢 CPU），
     * 同一份"100 项目首屏"工作量在单独跑时约 300~500ms，在全量套件里实测能到 1445ms
     * ——直接把 1000ms 当门槛，会把"机器被自己的测试打满"误报成性能回归（本 Wave 首次基线即如此）。
     *
     * 做法：跑 3 遍取最小值剔除调度抖动，再用固定工作量的纯计算探针测出当前机器吞吐，
     * 按 `CALM_PROBE_MS`（本机空载实测约 20ms）折算；争用与 CPU 型号的影响同时作用在两个测量上，
     * 比值因此稳定。折算后仍按 NFR 口径的 1000ms 预算断言。
     */
    const samples: number[] = [];
    let cards: HTMLElement[] = [];
    for (let round = 0; round < 3; round += 1) {
      cleanup();
      const started = performance.now();
      renderHome();
      cards = await screen.findAllByRole('article');
      samples.push(Number((performance.now() - started).toFixed(2)));
    }
    const timing = normalizeTiming(samples);
    reportTiming('工作台 100 项目首屏渲染', 1000, timing, `DOM 卡片 ${cards.length} 张`);

    expect(cards).toHaveLength(GRID_WINDOW_SIZE);
    expect(screen.getByRole('button', { name: /加载更多（已显示 48 \/ 100）/ })).toBeTruthy();
    expect(timing.normalized).toBeLessThan(1000);
  });

  it('列表视图使用虚拟化：1000 项目只渲染窗口内的行', async () => {
    await seedProjects(env, 1000);
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: '切换为列表视图' }));
    const table = await screen.findByLabelText('项目列表');
    const rows = within(table).getAllByRole('row');
    process.stdout.write(`[perf] 工作台 1000 项目列表视图渲染 ${rows.length} 行（含表头）\n`);
    expect(rows.length).toBeLessThan(40);
  });
});

describe('新建项目四类来源（FR-WSP-02）', () => {
  function renderDialog(onCreated = vi.fn()) {
    render(
      <WorkspaceApiProvider api={env.api}>
        <NewProjectDialog open onClose={vi.fn()} onCreated={onCreated} />
      </WorkspaceApiProvider>,
    );
    return { onCreated };
  }

  it('空白项目：名称必填，创建后落库并回调', async () => {
    const { onCreated } = renderDialog();
    fireEvent.change(screen.getByLabelText('新项目名称'), { target: { value: '空白项目A' } });
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const project = onCreated.mock.calls[0]![0] as { id: string };
    expect(env.store.rows.get(project.id)?.name).toBe('空白项目A');
    expect(env.store.rows.get(project.id)?.source_kind).toBe('blank');
  });

  it('模板来源：三套内置模板可见，创建后落初始页面与项目记忆', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: '从模板' }));
    const list = await screen.findByLabelText('内置模板');
    expect(within(list).getByLabelText('Web 管理后台')).toBeTruthy();
    expect(within(list).getByLabelText('移动端 App')).toBeTruthy();
    expect(within(list).getByLabelText('官网落地页')).toBeTruthy();

    fireEvent.click(within(list).getByLabelText('移动端 App'));
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));

    await waitFor(() => expect(env.templateArtifacts).toHaveLength(1));
    const artifact = env.templateArtifacts[0]!;
    expect(artifact.templateId).toBe('tpl-mobile-app');
    expect(artifact.pages).toBe(3);
    expect(artifact.memory).toBeGreaterThanOrEqual(2);
    expect(env.store.rows.get(artifact.projectId)?.target_platforms).toContain('android');
  });

  it('Git 来源：克隆 + 类型识别后落目标端与技术栈指纹', async () => {
    const { onCreated } = renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: '从 Git 仓库' }));
    fireEvent.change(screen.getByLabelText('Git 仓库地址'), { target: { value: 'https://example.com/mobile.git' } });
    fireEvent.change(screen.getByLabelText('克隆目录'), { target: { value: 'D:/projects/mobile' } });
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(env.gitClones).toEqual(['https://example.com/mobile.git']);
    const project = onCreated.mock.calls[0]![0] as { id: string };
    const row = env.store.rows.get(project.id)!;
    expect(row.source_kind).toBe('git_import');
    expect(row.target_platforms).toContain('android');
    expect(row.tech_stack_fingerprint).toContain('flutter');
  });

  it('Git 来源：克隆进度实时显示，扫描阶段退化为不确定进度条', async () => {
    // 用可挂起的包装端口在"调用进行中"投递进度，验证 UI 真的跟着事件走
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let report: ((progress: WorkspaceImportProgress) => void) | null = null;
    const api: WorkspaceApi = {
      ...env.api,
      importFromGit: async (input) => {
        report = input.onProgress ?? null;
        await gate;
        return env.api.importFromGit({
          url: input.url,
          targetDir: input.targetDir,
          ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
        });
      },
    };
    const onCreated = vi.fn();
    render(
      <WorkspaceApiProvider api={api}>
        <NewProjectDialog open onClose={vi.fn()} onCreated={onCreated} />
      </WorkspaceApiProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: '从 Git 仓库' }));
    fireEvent.change(screen.getByLabelText('Git 仓库地址'), { target: { value: 'https://example.com/mobile.git' } });
    fireEvent.change(screen.getByLabelText('克隆目录'), { target: { value: 'D:/projects/mobile' } });
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));

    await waitFor(() => expect(report).not.toBeNull());
    expect(screen.queryByRole('progressbar')).toBeNull();

    // 克隆阶段：文案 + 具体百分比
    await act(async () => {
      report?.({ stage: 'clone', ratio: 0.42, message: 'Receiving objects: 42%' });
    });
    await screen.findByText('Receiving objects: 42%');
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.className).not.toContain('indeterminate');

    // 扫描阶段：比例不可知，显示不确定进度而不是假装 100%
    await act(async () => {
      report?.({ stage: 'inspect', ratio: null, message: '克隆完成，正在扫描仓库文件…' });
    });
    await screen.findByText('克隆完成，正在扫描仓库文件…');
    const scanning = screen.getByRole('progressbar');
    expect(scanning.getAttribute('aria-valuenow')).toBeNull();
    expect(scanning.className).toContain('indeterminate');

    release();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('文档来源：解析预览显示功能清单，创建后落功能与页面', async () => {    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: '从需求文档' }));
    fireEvent.change(screen.getByLabelText('需求文档内容'), {
      target: {
        value: '# 课程平台\n\n## 功能\n- 课程管理：支持上下架\n- 学习进度：支持续播\n\n## 页面清单\n- 首页 /home\n',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析文档' }));

    const digest = await screen.findByLabelText('解析结果');
    expect(within(digest).getByText(/共识别 2 项功能/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor(() => expect(env.digestArtifacts).toHaveLength(1));
    expect(env.digestArtifacts[0]).toMatchObject({ features: 2, pages: 1 });
  });

  it('文档未解析时不能创建（避免落空项目）', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: '从需求文档' }));
    expect(screen.getByRole('button', { name: '创建项目' })).toBeDisabled();
  });
});

describe('回收站（FR-WSP-05：保留 30 天）', () => {
  it('显示剩余天数、可恢复、彻底删除需再次确认', async () => {
    const project = await env.api.createProject({ name: '回收项目' });
    await env.api.moveToRecycleBin(project.id);
    env.setNow(1_700_000_000_000 + 5 * 24 * 60 * 60 * 1000);
    const now = 1_700_000_000_000 + 5 * 24 * 60 * 60 * 1000;

    render(
      <WorkspaceApiProvider api={env.api}>
        <RecycleBin now={now} />
      </WorkspaceApiProvider>,
    );
    expect(await screen.findByText(/剩余 25 天/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(env.store.rows.get(project.id)?.deleted_at).toBeNull());
  });

  it('彻底删除需再次确认，确认后物理删除', async () => {
    const project = await env.api.createProject({ name: '彻底删' });
    await env.api.moveToRecycleBin(project.id);
    render(
      <WorkspaceApiProvider api={env.api}>
        <RecycleBin />
      </WorkspaceApiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '彻底删除' }));
    const dialog = await screen.findByRole('dialog', { name: '彻底删除确认' });
    expect(within(dialog).getByText(/无法恢复/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '彻底删除' }));
    await waitFor(() => expect(env.store.rows.has(project.id)).toBe(false));
  });

  it('清理超期条目：超 30 天的被清掉，未超期保留', async () => {
    const old = await env.api.createProject({ name: '超期项目' });
    await env.api.moveToRecycleBin(old.id);
    env.setNow(1_700_000_000_000 + RECYCLE_BIN_RETENTION_MS + 1000);
    const fresh = await env.api.createProject({ name: '刚删除' });
    await env.api.moveToRecycleBin(fresh.id);

    render(
      <WorkspaceApiProvider api={env.api}>
        <RecycleBin />
      </WorkspaceApiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '清理超期项目' }));
    await waitFor(() => expect(env.store.rows.has(old.id)).toBe(false));
    expect(env.store.rows.has(fresh.id)).toBe(true);
    expect(await screen.findByText(/已清理 1 个超期项目/)).toBeTruthy();
  });
});

describe('项目设置与目标端联动（FR-WSP-03）', () => {
  it('选择目标端与方案后保存：写库 + 广播画布预设与组件库分组', async () => {
    const project = await env.api.createProject({ name: '联动项目' });
    const events: TargetsChangedPayload[] = [];
    const unsubscribe = onTargetsChanged((payload) => events.push(payload));
    const onSaved = vi.fn();

    render(
      <WorkspaceApiProvider api={env.api}>
        <ProjectSettings project={project} onSaved={onSaved} />
      </WorkspaceApiProvider>,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Web' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Android' }));
    fireEvent.click(screen.getByLabelText('Web技术方案'));
    fireEvent.click(screen.getByRole('option', { name: /React 18/ }));
    fireEvent.click(screen.getByLabelText('Android技术方案'));
    fireEvent.click(screen.getByRole('option', { name: /Flutter/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const payload = onSaved.mock.calls[0]![0] as TargetsChangedPayload;
    expect(payload.platforms).toEqual(['web', 'android']);
    // 画布预设与设计器预设一致（联动口径可核对）
    const webPreset = defaultPresetFor('web');
    const expectWeb = canvasSizeOf(webPreset);
    expect(payload.canvasPresets[0]).toMatchObject({ presetId: webPreset.id, width: expectWeb.width, height: expectWeb.height });
    expect(payload.canvasPresets[1]!.presetId).toBe(defaultPresetFor('android').id);
    expect(payload.componentGroups.length).toBeGreaterThan(0);
    // 事件总线也确实广播了（设计器工作区据此切换）
    expect(events).toHaveLength(1);
    expect(events[0]!.projectId).toBe(project.id);

    // 落库校验
    const row = env.store.rows.get(project.id)!;
    expect(JSON.parse(row.target_platforms)).toEqual(['web', 'android']);
    expect(JSON.parse(row.tech_stack_fingerprint ?? '{}')).toMatchObject({ web: 'react', android: 'flutter' });
    unsubscribe();
  });

  it('已选目标端但未选方案时拒绝保存并给出可读原因', async () => {
    const project = await env.api.createProject({ name: '缺方案' });
    render(
      <WorkspaceApiProvider api={env.api}>
        <ProjectSettings project={project} />
      </WorkspaceApiProvider>,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Web' }));
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByText(/尚未选择技术方案/)).toBeTruthy();
    expect(env.store.rows.get(project.id)?.target_platforms).toBe('[]');
  });

  it('未选目标端时保存成功且提示使用默认画布', async () => {
    const project = await env.api.createProject({ name: '无目标端' });
    render(
      <WorkspaceApiProvider api={env.api}>
        <ProjectSettings project={project} />
      </WorkspaceApiProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByText(/未选择目标端/)).toBeTruthy();
  });

  it('buildTargetsPayload 对七端都给出画布预设（与设计器预设逐端对齐）', () => {
    const payload = buildTargetsPayload('p-1', ['web', 'android', 'ios', 'harmonyos', 'windows', 'linux', 'macos']);
    expect(payload.canvasPresets).toHaveLength(7);
    for (const preset of payload.canvasPresets) {
      expect(preset.presetId).toBe(defaultPresetFor(preset.platform).id);
      expect(preset.width).toBeGreaterThan(0);
    }
  });
});

describe('端口未注入时', () => {
  it('展示装配引导而不是崩溃', async () => {
    const { WorkspacePage } = await import('../index');
    render(<WorkspacePage api={null} />);
    expect(screen.getByText(/工作台尚未连接本地数据库/)).toBeTruthy();
  });
});
