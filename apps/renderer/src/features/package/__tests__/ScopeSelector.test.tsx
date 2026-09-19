/**
 * ScopeSelector 渲染层测试（T8-02 / FR-PKG-02）。
 *
 * 验证：范围三选、记忆五层级 + 内容勾选、scope=selected 时项目多选、
 * 方案保存/加载/删除走端口回调。仅用内存假端口，不碰 SQLite。
 *
 * ScopeSelector 是受控组件（selection 由父级持有），故用 Harness 持有状态以触发重渲染。
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PackageApiProvider } from '../package-api';
import type { ExportPlanPreset, ExportSelection } from '../package-api';
import { ScopeSelector } from '../ScopeSelector';
import { createFakePackageApi } from '../fake-package-api';

const PROJECTS = [
  { id: 'p1', name: '项目一' },
  { id: 'p2', name: '项目二' },
];

const FULL_SELECTION: ExportSelection = {
  scope: 'all',
  projectIds: [],
  content: {
    memory: { longterm: true, project: true, feature: true, page: true, issue: true },
    documents: true,
    code: true,
    pipeline: true,
    anchors: true,
    registry: true,
    attachments: true,
  },
};

/** 受控包装：持有 selection 状态，变更时同步回传 onChange（供回调断言） */
function Harness(props: {
  onChange: (s: ExportSelection) => void;
  presets?: Array<{ name: string }> | undefined;
}): React.ReactElement {
  const [selection, setSelection] = React.useState<ExportSelection>(FULL_SELECTION);
  const onChange = (s: ExportSelection): void => {
    props.onChange(s);
    setSelection(s);
  };
  return (
    <PackageApiProvider api={createFakePackageApi()}>
      <ScopeSelector
        selection={selection}
        projects={PROJECTS}
        presets={(props.presets ?? []).map((p): ExportPlanPreset => ({
          name: p.name,
          selection: FULL_SELECTION,
          useDefaultExcludes: true,
          redact: true,
          savedAt: 0,
        }))}
        useDefaultExcludes
        onChange={onChange}
        onToggleDefaultExcludes={vi.fn()}
        onSavePreset={vi.fn()}
        onLoadPreset={vi.fn()}
        onDeletePreset={vi.fn()}
      />
    </PackageApiProvider>
  );
}

function setup(overrides: { presets?: Array<{ name: string }> } = {}) {
  const onChange = vi.fn();
  const utils = render(<Harness onChange={onChange} presets={overrides.presets} />);
  return { onChange, ...utils };
}

describe('ScopeSelector', () => {
  it('渲染范围三选与记忆五层级 / 内容勾选', () => {
    setup();
    expect(screen.getByLabelText('导出范围')).toBeInTheDocument();
    for (const label of [
      '长期记忆',
      '项目记忆',
      '功能记忆',
      '页面记忆',
      '问题记忆',
      '文档',
      '代码',
      '流水线产物',
      '代码锚点',
      '统一标识注册表',
      '附件',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('切换范围为 selected 时显示项目多选', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByLabelText('导出范围'));
    await user.click(await screen.findByRole('option', { name: '自定义勾选' }));
    expect(screen.getByTestId('project-list')).toBeInTheDocument();
    await user.click(screen.getByLabelText('项目一'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'selected', projectIds: ['p1'] }),
    );
  });

  it('勾选/取消内容类型回调新 selection', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByLabelText('代码'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.objectContaining({ code: false }) }),
    );
  });

  it('记忆层级勾选回调', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByLabelText('长期记忆'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ memory: expect.objectContaining({ longterm: false }) }),
      }),
    );
  });

  it('保存方案：写入名称后点保存回调 onSavePreset', async () => {
    const user = userEvent.setup();
    const onSavePreset = vi.fn();
    render(
      <PackageApiProvider api={createFakePackageApi()}>
        <ScopeSelector
          selection={FULL_SELECTION}
          projects={PROJECTS}
          presets={[]}
          useDefaultExcludes
          onChange={vi.fn()}
          onToggleDefaultExcludes={vi.fn()}
          onSavePreset={onSavePreset}
          onLoadPreset={vi.fn()}
          onDeletePreset={vi.fn()}
        />
      </PackageApiProvider>,
    );
    const nameInput = screen.getByTestId('preset-name');
    await user.type(nameInput, '仅代码');
    await user.click(screen.getByTestId('save-preset'));
    expect(onSavePreset).toHaveBeenCalledWith('仅代码');
  });

  it('加载方案：选择下拉项回调 onLoadPreset', async () => {
    const user = userEvent.setup();
    const onLoadPreset = vi.fn();
    render(
      <PackageApiProvider api={createFakePackageApi()}>
        <ScopeSelector
          selection={FULL_SELECTION}
          projects={PROJECTS}
          presets={[
            {
              name: '备份全量',
              selection: FULL_SELECTION,
              useDefaultExcludes: true,
              redact: true,
              savedAt: 0,
            },
          ]}
          useDefaultExcludes
          onChange={vi.fn()}
          onToggleDefaultExcludes={vi.fn()}
          onSavePreset={vi.fn()}
          onLoadPreset={onLoadPreset}
          onDeletePreset={vi.fn()}
        />
      </PackageApiProvider>,
    );
    await user.click(screen.getByLabelText('加载方案'));
    await user.click(await screen.findByRole('option', { name: '备份全量' }));
    expect(onLoadPreset).toHaveBeenCalledWith('备份全量');
  });

  it('勾选默认排除规则切换回调', async () => {
    const user = userEvent.setup();
    const onToggleDefaultExcludes = vi.fn();
    render(
      <PackageApiProvider api={createFakePackageApi()}>
        <ScopeSelector
          selection={FULL_SELECTION}
          projects={PROJECTS}
          presets={[]}
          useDefaultExcludes
          onChange={vi.fn()}
          onToggleDefaultExcludes={onToggleDefaultExcludes}
          onSavePreset={vi.fn()}
          onLoadPreset={vi.fn()}
          onDeletePreset={vi.fn()}
        />
      </PackageApiProvider>,
    );
    await user.click(screen.getByLabelText('默认排除规则（node_modules / dist / 构建缓存等）'));
    expect(onToggleDefaultExcludes).toHaveBeenCalledWith(false);
  });
});
