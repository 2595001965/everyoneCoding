import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toDiffViewModel, type AssembledContext, type ContextBlock, type WritePlan } from '@ec/ai';
import { serializePageDsl, type PageDsl } from '@ec/designer/dsl';
import { createLoginPageDsl } from '@ec/designer/dsl';

import { CodeWorkspacePage } from '../CodePage';
import { CODE_API_GLOBAL_KEY } from '../../features/code';
import { CONTEXT_API_GLOBAL_KEY } from '../../features/ai/context-api';
import { DESIGNER_API_GLOBAL_KEY } from '../../features/designer/designer-api';
import { useProjectStore } from '../../store/useProjectStore';

/**
 * 代码与上下文页集成测试（T12-02 验收的自动化替身）。
 *
 * 覆盖两条此前**产品里无路可走**的验收：
 * 1. 打开上下文面板能看到**真实来源与裁剪提示**（块 source、跳过原因、省略清单）；
 * 2. 代码只能由 AI 写入：键入 / 粘贴被拦截并弹出修改入口；
 *    写入走「AI 重改 → WritePipeline 计划 → 预览 diff → 应用」两段式。
 *
 * 端口用假实现（渲染层不碰 SQLite / 网络），页面装配与交互一律走真实组件。
 */

const PROJECT_ID = 'P-CODE-TEST';

interface FakeState {
  applied: WritePlan[];
  reworked: unknown[];
  emitExternalChange: ((change: unknown) => void) | null;
  emitWritePlan: ((hint: { plan: WritePlan; source: string }) => void) | null;
}

let state: FakeState;

function contextFixture(): AssembledContext {
  const blocks: ContextBlock[] = [
    {
      id: 'instruction',
      label: '任务指令与输出契约',
      priority: 1000,
      quota: 16000,
      tokens: 12,
      content: '本次生成目标：后端代码\n作用元素：el-submit',
      source: '会话上下文',
      editable: true,
      items: [
        {
          key: 'task',
          label: '任务指令',
          tokens: 12,
          weight: 1000,
          text: '本次生成目标：后端代码',
        },
      ],
    },
    {
      id: 'longterm',
      label: '长期记忆（用户偏好与规范）',
      priority: 400,
      quota: 8000,
      tokens: 18,
      content: '- 命名规范\n组件文件一律 kebab-case',
      source: '关键词检索（FTS5 trigram） 1 条',
      editable: true,
      items: [
        {
          key: 'mem-longterm-1',
          label: '命名规范',
          tokens: 18,
          weight: 5,
          text: '- 命名规范\n组件文件一律 kebab-case',
        },
      ],
    },
    {
      id: 'code',
      label: '已有代码与 Code Anchor',
      priority: 860,
      quota: 40000,
      tokens: 0,
      content: '',
      source: '未接入',
      editable: false,
      items: [],
      skipped: '项目中尚无与本次生成相关的代码（首次生成）',
    },
  ];
  return {
    blocks,
    system: '# 角色与输出契约\n…',
    user: '请完成生成。',
    messages: [],
    totalTokens: 30,
    budget: 128000,
    tookMs: 3,
    truncation: {
      omittedCount: 1,
      omittedTokens: 42,
      items: [
        {
          block: 'project',
          blockLabel: '项目记忆',
          label: '技术选型',
          tokens: 42,
          reason: 'block-over-quota',
          preview: '技术选型：React + Node',
        },
      ],
      beforeTokens: 72,
      afterTokens: 30,
      aggressive: false,
      summary: '已省略 1 项（点击展开）',
      byReason: {
        'block-over-quota': 1,
        'block-over-budget': 0,
        'aggressive-trim': 0,
        'block-disabled': 0,
      },
    },
    noteIds: ['note-1'],
    memoryIds: ['mem-longterm-1'],
    skipped: [{ block: 'code', reason: '项目中尚无与本次生成相关的代码（首次生成）' }],
    aggressive: false,
  };
}

function planFixture(): WritePlan {
  return {
    id: 'plan-1',
    mode: 'preview',
    entries: [
      {
        path: 'src/auth.service.ts',
        action: 'patch',
        language: 'typescript',
        content: '@@ -1,1 +1,2 @@\n export const a = 1;\n+export const b = 2;',
        before: 'export const a = 1;\n',
        after: 'export const a = 1;\nexport const b = 2;\n',
        blocked: false,
        blockReason: null,
        changed: true,
        selected: true,
      },
    ],
    createdAt: 0,
    summary: '补齐验证码校验',
    anchors: [],
    noteIds: ['note-1'],
    addedLines: 1,
    removedLines: 0,
    blockedCount: 0,
  };
}

function installFakePorts(): FakeState {
  const login: PageDsl = { ...createLoginPageDsl(), projectId: PROJECT_ID };
  const envelope = JSON.parse(serializePageDsl(login)) as { dslVersion: number; page: PageDsl };
  const created: FakeState = {
    applied: [],
    reworked: [],
    emitExternalChange: null,
    emitWritePlan: null,
  };

  (globalThis as Record<string, unknown>)[CODE_API_GLOBAL_KEY] = {
    files: {
      listFiles: async () => [{ path: 'src/auth.service.ts', language: 'typescript' }],
      readFile: async () => 'export const a = 1;\n',
    },
    write: {
      plan: async () => planFixture(),
      apply: async (plan: WritePlan) => {
        created.applied.push(plan);
        return {
          ok: true,
          planId: plan.id,
          applied: [plan.entries[0]?.path ?? ''],
          skipped: [],
          rolledBack: [],
          error: null,
        };
      },
      requestRework: async (request: unknown) => {
        created.reworked.push(request);
      },
    },
    subscribeExternalChanges: (listener: (change: unknown) => void) => {
      created.emitExternalChange = listener;
      return () => {
        created.emitExternalChange = null;
      };
    },
    subscribeWritePlan: (listener: (hint: { plan: WritePlan; source: string }) => void) => {
      created.emitWritePlan = listener;
      return () => {
        created.emitWritePlan = null;
      };
    },
  };

  (globalThis as Record<string, unknown>)[CONTEXT_API_GLOBAL_KEY] = {
    ready: true,
    availableSources: ['memory', 'notes', 'elements', 'documents', 'code'],
    assemble: async () => contextFixture(),
  };

  (globalThis as Record<string, unknown>)[DESIGNER_API_GLOBAL_KEY] = {
    openProject: async (projectId: string) => ({ projectId }),
    listPages: async () => [{ pageId: login.id, name: login.name, route: login.route }],
    loadPage: async () => envelope,
    savePage: async () => ({ pageId: login.id, savedAt: 0 }),
    createPage: async () => envelope,
    writePageStructure: async () => ({ id: 'mem-1' }),
    listStructureRevisions: async () => [],
    upsertRoutes: async () => ({}),
    readRoutes: async () => [],
    generatePage: async () => ({ candidate: null, raw: '', model: 'fake' }),
    readNotes: async () => [],
    saveNote: async () => ({}),
    updateNote: async () => ({}),
    setNoteStatus: async () => ({}),
    removeNote: async () => ({ removed: false }),
    noteBadges: async () => ({}),
  };

  return created;
}

async function renderPage(): Promise<void> {
  render(
    <MemoryRouter>
      <CodeWorkspacePage />
    </MemoryRouter>,
  );
  await screen.findByTestId('ec-code-surface');
}

beforeEach(() => {
  state = installFakePorts();
  useProjectStore.getState().openProject({
    id: PROJECT_ID,
    name: '代码页测试项目',
    targetPlatforms: ['web'],
    updatedAt: 0,
  });
});

afterEach(() => {
  for (const key of [CODE_API_GLOBAL_KEY, CONTEXT_API_GLOBAL_KEY, DESIGNER_API_GLOBAL_KEY]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
  useProjectStore.getState().closeProject();
});

describe('代码与上下文页', () => {
  it('上下文面板展示真实来源、跳过原因与裁剪提示', async () => {
    await renderPage();

    // 真实来源：块的 source 由外壳给出（这里是"关键词检索（FTS5 trigram） 1 条"），
    // 不是写死的"双路召回"
    expect(await screen.findByText(/关键词检索（FTS5 trigram） 1 条/)).toBeInTheDocument();
    // 跳过原因如实展示（块卡片 + 页面汇总各一处）
    expect(screen.getAllByText(/项目中尚无与本次生成相关的代码/).length).toBeGreaterThan(0);
    // 裁剪提示：省略清单可直接展开
    expect(screen.getByTestId('ec-context-omitted')).toBeInTheDocument();
    expect(screen.getAllByText(/已省略 1 项/).length).toBeGreaterThan(0);
    // 页面自身的汇总行同时给出 token 与跳过块
    const summary = screen.getByTestId('ec-context-summary');
    expect(within(summary).getByText(/30 \/ 128000 token/)).toBeInTheDocument();
    expect(screen.getByTestId('ec-context-skipped').textContent).toContain('code');
  });

  it('元素清单来自真实页面 DSL（可选到登录页元素）', async () => {
    await renderPage();
    // Select 是自定义 listbox：先展开再读选项
    fireEvent.click(screen.getByLabelText('选中元素'));
    const options = within(await screen.findByRole('listbox'))
      .getAllByRole('option')
      .map((option) => option.textContent ?? '');
    expect(options.length).toBeGreaterThan(1);
    expect(options.some((text) => text.includes('Button'))).toBe(true);
  });

  it('代码视图只读：键击与粘贴被拦截并弹出「交给 AI 修改」入口', async () => {
    await renderPage();
    const surface = screen.getByTestId('ec-code-surface');
    expect(surface).toHaveAttribute('data-readonly', 'true');
    expect(surface).not.toHaveAttribute('contenteditable');

    fireEvent.paste(surface);
    expect(await screen.findByText(/已被拦截（代码视图只读）/)).toBeInTheDocument();
  });

  it('AI 重改：计划经事件回流 → 预览 diff → 应用（事务）', async () => {
    await renderPage();

    // 主进程产出计划后经 code:write-plan 事件回流（requestRework 的返回类型是 void，
    // 计划只能走事件；这也是"先给人看 diff 再落盘"的形态要求）
    const plan = planFixture();
    state.emitWritePlan?.({ plan, source: 'rework' });
    const planPanel = await screen.findByTestId('ec-write-plan');
    expect(within(planPanel).getAllByText(/src\/auth\.service\.ts/).length).toBeGreaterThan(0);

    // 「交给 AI 修改」：带上勾选范围（这里取差异面板里的文件）与用户意见
    fireEvent.change(screen.getByLabelText('AI 修改要求'), {
      target: { value: '补上验证码校验' },
    });
    fireEvent.click(screen.getByRole('button', { name: '交给 AI 修改' }));
    await waitFor(() => {
      expect(state.reworked).toHaveLength(1);
    });
    const rework = state.reworked[0] as {
      instruction: string;
      context: string;
      paths: readonly string[];
    };
    expect(rework.instruction).toBe('补上验证码校验');
    expect(rework.paths).toEqual(['src/auth.service.ts']);
    // 差异上下文真的带上了增删行，模型才能定位
    expect(rework.context).toContain('+export const b = 2;');

    // 应用 → 走端口（真实实现里是 WritePipeline 的事务写）
    fireEvent.click(screen.getByRole('button', { name: '应用变更' }));
    await waitFor(() => {
      expect(state.applied).toHaveLength(1);
    });
    const result = await screen.findByTestId('ec-apply-result');
    expect(result.textContent).toContain('已应用 1 个文件');

    // DiffView 消费的是同一份计划的纯函数转换（与主进程同源）
    expect(toDiffViewModel(plan).files).toHaveLength(1);
  });

  it('外部进程改动 → 提示横幅给出「重新生成」与「回滚」两个动作', async () => {
    await renderPage();

    state.emitExternalChange?.({
      path: 'src/auth.service.ts',
      message: '代码已被外部修改（src/auth.service.ts），建议回滚到最近提交或让 AI 重新生成。',
      actions: [
        { key: 'rollback', label: '回滚到最近提交' },
        { key: 'regenerate', label: '让 AI 重新生成' },
      ],
    });

    const banner = await screen.findByTestId('ec-external-change-banner');
    expect(within(banner).getByText(/代码已被外部修改/)).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole('button', { name: '让 AI 重新生成' }));
    // 「重新生成」把该文件带进重改要求（预填上下文），而不是悄悄什么都不做
    expect(screen.getByLabelText('AI 修改要求')).toHaveValue(
      '请重新生成 src/auth.service.ts：外部修改与生成结果冲突。',
    );
    expect(within(banner).getByRole('button', { name: '回滚到最近提交' })).toBeInTheDocument();
  });
});
