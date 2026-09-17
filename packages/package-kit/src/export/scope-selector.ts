/**
 * 导出范围与方案选择（T8-02 / FR-PKG-02）。
 *
 * 提供：范围三选（全部 / 单项目 / 自定义勾选）、内容勾选（记忆五层级、文档、代码、
 * 流水线、锚点、注册表、附件）、命名"导出方案"的纯函数与内存存储。
 *
 * 纯函数不触碰持久化；持久化由调用方经 `PresetStore` 端口完成（渲染层走
 * `PackageApi.saveExportPreset/listExportPresets/deleteExportPreset`）。
 */

import {
  FULL_CONTENT_SELECTION,
  type ContentSelection,
  type ExportPlanPreset,
  type ExportScopeKind,
  type ExportSelection,
  type MemoryLayerSelection,
} from './export-types';

/** 默认选择：全范围 + 全内容 */
export function defaultSelection(): ExportSelection {
  return {
    scope: 'all',
    projectIds: [],
    content: cloneContent(FULL_CONTENT_SELECTION),
  };
}

function cloneContent(content: ContentSelection): ContentSelection {
  return {
    memory: { ...content.memory },
    documents: content.documents,
    code: content.code,
    pipeline: content.pipeline,
    anchors: content.anchors,
    registry: content.registry,
    attachments: content.attachments,
  };
}

function normalizeMemoryLayer(input: Partial<MemoryLayerSelection> | undefined): MemoryLayerSelection {
  const base = FULL_CONTENT_SELECTION.memory;
  if (input === undefined) return { ...base };
  return {
    longterm: input.longterm ?? base.longterm,
    project: input.project ?? base.project,
    feature: input.feature ?? base.feature,
    page: input.page ?? base.page,
    issue: input.issue ?? base.issue,
  };
}

function normalizeContent(input: Partial<ContentSelection> | undefined): ContentSelection {
  const base = FULL_CONTENT_SELECTION;
  if (input === undefined) return cloneContent(base);
  return {
    memory: normalizeMemoryLayer(input.memory),
    documents: input.documents ?? base.documents,
    code: input.code ?? base.code,
    pipeline: input.pipeline ?? base.pipeline,
    anchors: input.anchors ?? base.anchors,
    registry: input.registry ?? base.registry,
    attachments: input.attachments ?? base.attachments,
  };
}

/**
 * 校验并归一化一次选择：
 * - scope=all：清空 projectIds（全范围不限定项目）；
 * - scope=project：只保留首个 projectId（单项目）；
 * - scope=selected：保留勾选集合，空集合视为非法 → 回落为 all（避免导出空集）；
 * - 缺失的 content 字段按全选补齐（绝不静默丢弃数据）。
 */
export function normalizeSelection(input: Partial<ExportSelection>): ExportSelection {
  let scope: ExportScopeKind = input.scope ?? 'all';
  let projectIds = input.projectIds ? [...new Set(input.projectIds)] : [];

  if (scope === 'all') {
    projectIds = [];
  } else if (scope === 'project') {
    projectIds = projectIds.length > 0 ? [projectIds[0]!] : [];
  } else if (scope === 'selected') {
    if (projectIds.length === 0) {
      // 非法：自定义勾选却没选任何项目 → 回落全范围
      scope = 'all';
      projectIds = [];
    }
  }

  return {
    scope,
    projectIds,
    content: normalizeContent(input.content),
  };
}

/* ------------------------------ 命名方案 ------------------------------ */

/** 把当前选择存为命名方案 */
export function toPreset(
  name: string,
  selection: ExportSelection,
  options: { useDefaultExcludes?: boolean; redact?: boolean } = {},
): ExportPlanPreset {
  return {
    name,
    selection: normalizeSelection(selection),
    useDefaultExcludes: options.useDefaultExcludes ?? true,
    redact: options.redact ?? true,
    savedAt: Date.now(),
  };
}

/** 从命名方案还原选择 */
export function fromPreset(preset: ExportPlanPreset): ExportSelection {
  return normalizeSelection(preset.selection);
}

/** 方案存储端口（调用方注入；渲染层映射到 PackageApi） */
export interface PresetStore {
  list(): ExportPlanPreset[];
  save(preset: ExportPlanPreset): void;
  remove(name: string): void;
}

/** 内存方案存储（测试 / 假端口 / 无持久化场景） */
export function createMemoryPresetStore(initial: readonly ExportPlanPreset[] = []): PresetStore {
  const map = new Map<string, ExportPlanPreset>();
  for (const preset of initial) map.set(preset.name, preset);
  return {
    list: () => [...map.values()].sort((a, b) => b.savedAt - a.savedAt),
    save: (preset) => {
      map.set(preset.name, { ...preset, savedAt: Date.now() });
    },
    remove: (name) => {
      map.delete(name);
    },
  };
}
