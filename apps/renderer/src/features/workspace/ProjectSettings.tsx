/**
 * ProjectSettings（T9-01 / FR-WSP-03）：项目设置。
 *
 * 覆盖：名称、目标端（七端多选）、各端技术方案（**与 T5-04 问卷共用同一数据源**
 * `PLATFORM_MATRIX`）、技术栈指纹（前端 / 后端 / 数据库 / 各端方案）、关联 Git 远程。
 *
 * 联动（FR-WSP-03 验收点）：修改目标端并发保存后广播
 * `TARGETS_CHANGED_EVENT`，载荷含由 `@ec/designer` 推导的画布预设与组件库分组——
 * 设计器工作区订阅后切换画布尺寸预设与组件库（本文件不直接 import 设计器工作区）。
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Input, Select, Textarea } from '@ec/ui';
import {
  PLATFORM_MATRIX,
  TARGET_PLATFORMS,
  TARGET_PLATFORM_LABELS,
  isPlatformEnabled,
  type TargetPlatform,
} from '@ec/pipeline';
import type { ProjectSummary, TechStackFingerprint } from '@ec/core';

import {
  buildTargetsPayload,
  emitTargetsChanged,
  type TargetsChangedPayload,
} from './workspace-events';
import { useWorkspace } from './workspace-api';

export interface ProjectSettingsProps {
  project: ProjectSummary;
  onSaved?: (payload: TargetsChangedPayload) => void;
  onCancel?: () => void;
}

/** 七端多选（含"该端无可用方案"的禁用与说明） */
export function TargetPlatformPicker({
  value,
  onChange,
  disabled,
}: {
  value: TargetPlatform[];
  onChange: (next: TargetPlatform[]) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="ec-ws__platforms" role="group" aria-label="目标端">
      {TARGET_PLATFORMS.map((platform) => {
        const availability = isPlatformEnabled(platform);
        const checked = value.includes(platform);
        return (
          <label
            key={platform}
            className="ec-ws__platform"
            data-disabled={availability.enabled ? 'false' : 'true'}
          >
            <Checkbox
              checked={checked}
              disabled={disabled || !availability.enabled}
              onChange={(next) => {
                onChange(next ? [...value, platform] : value.filter((item) => item !== platform));
              }}
              label={TARGET_PLATFORM_LABELS[platform]}
            />
            {!availability.enabled ? (
              <span className="ec-ws__hint">{availability.reason ?? '当前矩阵无可用方案'}</span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

export function ProjectSettings({ project, onSaved, onCancel }: ProjectSettingsProps): JSX.Element {
  const api = useWorkspace();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [platforms, setPlatforms] = useState<TargetPlatform[]>(project.targetPlatforms);
  const [stack, setStack] = useState<Record<string, string>>(project.techStackFingerprint ?? {});
  const [gitRemote, setGitRemote] = useState(project.gitRemote ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? '');
    setPlatforms(project.targetPlatforms);
    setStack(project.techStackFingerprint ?? {});
    setGitRemote(project.gitRemote ?? '');
  }, [project]);

  const missingChoice = useMemo(
    () => platforms.filter((platform) => !stack[platform]),
    [platforms, stack],
  );

  const save = async (): Promise<void> => {
    if (missingChoice.length > 0) {
      setError(
        `以下目标端尚未选择技术方案：${missingChoice.map((p) => TARGET_PLATFORM_LABELS[p]).join('、')}`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fingerprint: TechStackFingerprint = { ...stack };
      await api.updateProject(project.id, {
        name: name.trim(),
        description: description.trim() || null,
        targetPlatforms: platforms,
        techStackFingerprint: fingerprint,
        gitRemote: gitRemote.trim() || null,
      });
      const payload = buildTargetsPayload(project.id, platforms);
      emitTargetsChanged(payload);
      setNotice(
        payload.canvasPresets.length > 0
          ? `已保存。设计器画布将切换为：${payload.canvasPresets.map((preset) => preset.label).join('、')}`
          : '已保存。未选择目标端，设计器使用默认画布。',
      );
      onSaved?.(payload);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ec-ws__settings" aria-label="项目设置">
      <header className="ec-ws__settings-head">
        <h1>{`项目设置：${project.name}`}</h1>
      </header>

      <label className="ec-ws__field">
        <span>项目名称</span>
        <Input value={name} onChange={setName} aria-label="项目名称" />
      </label>

      <label className="ec-ws__field">
        <span>项目描述</span>
        <Textarea value={description} onChange={setDescription} rows={3} aria-label="项目描述" />
      </label>

      <div className="ec-ws__field">
        <span>目标端（七端多选）</span>
        <TargetPlatformPicker value={platforms} onChange={setPlatforms} disabled={busy} />
      </div>

      {platforms.length > 0 ? (
        <div className="ec-ws__field">
          <span>各端技术方案（FR-AI-13 矩阵，与技术选型问卷同源）</span>
          <div className="ec-ws__stack">
            {platforms.map((platform) => {
              const entry = PLATFORM_MATRIX.find((candidate) => candidate.platform === platform);
              const options = (entry?.options ?? []).map((option) => ({
                value: option.value,
                label: option.recommended ? `${option.label}（推荐）` : option.label,
                disabled: option.disabled ?? false,
              }));
              const selected = stack[platform] ?? '';
              const current = entry?.options.find((option) => option.value === selected);
              return (
                <label key={platform} className="ec-ws__field">
                  <span>{TARGET_PLATFORM_LABELS[platform]}</span>
                  <Select
                    aria-label={`${TARGET_PLATFORM_LABELS[platform]}技术方案`}
                    value={selected}
                    placeholder="请选择方案"
                    options={options}
                    onChange={(value) => setStack((prev) => ({ ...prev, [platform]: value }))}
                  />
                  {current ? <span className="ec-ws__hint">{current.tradeoffs}</span> : null}
                </label>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="ec-ws__field">
        <span>技术栈指纹（可选，供 S3 阶段参考）</span>
        <div className="ec-ws__stack">
          {(['frontend', 'backend', 'database'] as const).map((key) => (
            <label key={key} className="ec-ws__field">
              <span>{key === 'frontend' ? '前端' : key === 'backend' ? '后端' : '数据库'}</span>
              <Input
                value={stack[key] ?? ''}
                onChange={(value) => setStack((prev) => ({ ...prev, [key]: value }))}
                aria-label={`技术栈 ${key}`}
                placeholder={
                  key === 'frontend'
                    ? 'React 18 + TypeScript'
                    : key === 'backend'
                      ? 'Node + Fastify'
                      : 'SQLite'
                }
              />
            </label>
          ))}
        </div>
      </div>

      <label className="ec-ws__field">
        <span>关联 Git 远程</span>
        <Input
          value={gitRemote}
          onChange={setGitRemote}
          aria-label="Git 远程地址"
          placeholder="https://example.com/team/repo.git"
        />
      </label>

      {error ? <p className="ec-ws__error">{error}</p> : null}
      {notice ? (
        <p className="ec-ws__notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="ec-ws__settings-actions">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            返回
          </Button>
        ) : null}
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          保存设置
        </Button>
      </div>
    </section>
  );
}
