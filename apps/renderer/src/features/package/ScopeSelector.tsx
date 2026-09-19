/**
 * 导出范围与内容勾选组件（T8-02 / FR-PKG-02）。
 *
 * - 范围三选：全部 / 单项目 / 自定义勾选（scope=selected 时显示项目多选）；
 * - 内容勾选：记忆五层级 + 文档 + 代码 + 流水线 + 锚点 + 注册表 + 附件；
 * - 命名导出方案：名称输入 + 保存 / 下拉加载 / 删除。
 *
 * 仅从 './package-api' 导入类型，绝不 import '@ec/package-kit'。
 */

import { Button, Checkbox, Input, Select } from '@ec/ui';

import type { ExportPlanPreset, ExportScopeKind, ExportSelection } from './package-api';

const MEMORY_LAYER_LABELS: ReadonlyArray<{
  key: keyof ExportSelection['content']['memory'];
  label: string;
}> = [
  { key: 'longterm', label: '长期记忆' },
  { key: 'project', label: '项目记忆' },
  { key: 'feature', label: '功能记忆' },
  { key: 'page', label: '页面记忆' },
  { key: 'issue', label: '问题记忆' },
];

const CONTENT_LABELS: ReadonlyArray<{
  key: keyof Omit<ExportSelection['content'], 'memory'>;
  label: string;
}> = [
  { key: 'documents', label: '文档' },
  { key: 'code', label: '代码' },
  { key: 'pipeline', label: '流水线产物' },
  { key: 'anchors', label: '代码锚点' },
  { key: 'registry', label: '统一标识注册表' },
  { key: 'attachments', label: '附件' },
];

export interface ScopeSelectorProps {
  selection: ExportSelection;
  projects: ReadonlyArray<{ id: string; name: string }>;
  presets: ReadonlyArray<ExportPlanPreset>;
  useDefaultExcludes: boolean;
  onChange: (selection: ExportSelection) => void;
  onToggleDefaultExcludes: (value: boolean) => void;
  onSavePreset: (name: string) => void;
  onLoadPreset: (name: string) => void;
  onDeletePreset: (name: string) => void;
}

export function ScopeSelector(props: ScopeSelectorProps): React.ReactElement {
  const { selection, projects, presets, useDefaultExcludes } = props;

  const setScope = (scope: ExportScopeKind): void => {
    const next: ExportSelection =
      scope === 'all'
        ? { ...selection, scope, projectIds: [] }
        : scope === 'project'
          ? { ...selection, scope, projectIds: selection.projectIds.slice(0, 1) }
          : { ...selection, scope };
    props.onChange(next);
  };

  const toggleMemoryLayer = (
    key: keyof ExportSelection['content']['memory'],
    value: boolean,
  ): void => {
    props.onChange({
      ...selection,
      content: { ...selection.content, memory: { ...selection.content.memory, [key]: value } },
    });
  };

  const toggleContent = (
    key: keyof Omit<ExportSelection['content'], 'memory'>,
    value: boolean,
  ): void => {
    props.onChange({ ...selection, content: { ...selection.content, [key]: value } });
  };

  const toggleProject = (id: string, value: boolean): void => {
    const set = new Set(selection.projectIds);
    if (value) set.add(id);
    else set.delete(id);
    props.onChange({ ...selection, projectIds: [...set] });
  };

  return (
    <div className="ec-package-scope" data-testid="scope-selector">
      <section className="ec-package-scope__block">
        <h3>导出范围</h3>
        <Select
          aria-label="导出范围"
          options={[
            { label: '全部项目', value: 'all' },
            { label: '单个项目', value: 'project' },
            { label: '自定义勾选', value: 'selected' },
          ]}
          value={selection.scope}
          onChange={(value) => setScope(value as ExportScopeKind)}
        />
        {selection.scope === 'selected' && (
          <div className="ec-package-scope__projects" data-testid="project-list">
            {projects.map((project) => (
              <Checkbox
                key={project.id}
                label={project.name}
                checked={selection.projectIds.includes(project.id)}
                onChange={(checked) => toggleProject(project.id, checked)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="ec-package-scope__block">
        <h3>记忆层级</h3>
        <div className="ec-package-scope__memory">
          {MEMORY_LAYER_LABELS.map(({ key, label }) => (
            <Checkbox
              key={key}
              label={label}
              checked={selection.content.memory[key]}
              onChange={(checked) => toggleMemoryLayer(key, checked)}
            />
          ))}
        </div>
      </section>

      <section className="ec-package-scope__block">
        <h3>内容类型</h3>
        <div className="ec-package-scope__content">
          {CONTENT_LABELS.map(({ key, label }) => (
            <Checkbox
              key={key}
              label={label}
              checked={selection.content[key]}
              onChange={(checked) => toggleContent(key, checked)}
            />
          ))}
        </div>
        <Checkbox
          label="默认排除规则（node_modules / dist / 构建缓存等）"
          checked={useDefaultExcludes}
          onChange={(checked) => props.onToggleDefaultExcludes(checked)}
        />
      </section>

      <section className="ec-package-scope__block">
        <h3>导出方案</h3>
        <div className="ec-package-scope__preset">
          <Input aria-label="方案名称" placeholder="方案名称" data-testid="preset-name" />
          <Button
            data-testid="save-preset"
            onClick={() => {
              const input = document.querySelector<HTMLInputElement>('[data-testid="preset-name"]');
              const name = input?.value?.trim() ?? '';
              if (name.length > 0) props.onSavePreset(name);
            }}
          >
            保存方案
          </Button>
          <Select
            aria-label="加载方案"
            placeholder="加载已存方案"
            options={presets.map((preset) => ({ label: preset.name, value: preset.name }))}
            value=""
            onChange={(value) => {
              if (value.length > 0) props.onLoadPreset(value);
            }}
          />
          <Button
            data-testid="delete-preset"
            onClick={() => {
              const select = document.querySelector<HTMLInputElement>('[aria-label="加载方案"]');
              const name = select?.value?.trim() ?? '';
              if (name.length > 0) props.onDeletePreset(name);
            }}
          >
            删除方案
          </Button>
        </div>
      </section>
    </div>
  );
}
