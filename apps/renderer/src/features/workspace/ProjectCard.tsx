/**
 * ProjectCard（T9-01 / FR-WSP-01）：项目卡片。
 *
 * 内容：缩略图（懒加载，无图显示占位）、名称、更新时间、目标端标签、
 * 流水线当前阶段进度环；操作：置顶、设置、归档、删除（删除需二次确认，由父级负责）。
 */

import { useState } from 'react';
import { Tag } from '@ec/ui';
import { TARGET_PLATFORM_LABELS } from '@ec/pipeline';
import type { ProjectSummary } from '@ec/core';

import type { ProjectStageInfo } from './workspace-api';

export interface ProjectCardProps {
  project: ProjectSummary;
  thumbnailUrl: string | null;
  stage: ProjectStageInfo | null;
  selected: boolean;
  busy?: boolean;
  archived?: boolean;
  onOpen: (id: string) => void;
  onOpenSettings: (id: string) => void;
  onTogglePinned: (id: string, pinned: boolean) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}

/** 进度环（SVG，避免依赖图表库） */
function StageRing({ stage }: { stage: ProjectStageInfo | null }): JSX.Element {
  const ratio =
    stage && stage.total > 0 ? Math.max(0, Math.min(1, stage.confirmed / stage.total)) : 0;
  const radius = 14;
  const circumference = 2 * Math.PI * radius;
  const label = stage ? stage.stage : '未开始';
  return (
    <span className="ec-ws__ring" role="img" aria-label={`流水线阶段：${label}`}>
      <svg width="36" height="36" viewBox="0 0 36 36">
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          stroke="var(--ec-color-border, #e5e7eb)"
          strokeWidth="3"
        />
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          stroke="var(--ec-color-primary, #2f6fed)"
          strokeWidth="3"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span className="ec-ws__ring-label">{label}</span>
    </span>
  );
}

export function ProjectCard({
  project,
  thumbnailUrl,
  stage,
  selected,
  busy = false,
  archived = false,
  onOpen,
  onOpenSettings,
  onTogglePinned,
  onArchive,
  onDelete,
}: ProjectCardProps): JSX.Element {
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null);
  return (
    <article
      className="ec-ws__card"
      data-selected={selected ? 'true' : 'false'}
      data-project-id={project.id}
      aria-label={`项目 ${project.name}`}
    >
      <button
        type="button"
        className="ec-ws__thumb"
        onClick={() => onOpen(project.id)}
        aria-label={`打开 ${project.name}`}
      >
        {thumbnailUrl && thumbnailUrl !== failedThumbnail ? (
          // 缩略图懒加载：视口外不请求
          <img
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            className="ec-ws__thumb-img"
            onError={() => setFailedThumbnail(thumbnailUrl)}
          />
        ) : (
          <span className="ec-ws__thumb-placeholder">{project.name.slice(0, 1).toUpperCase()}</span>
        )}
      </button>

      <div className="ec-ws__card-body">
        <header className="ec-ws__card-head">
          <button type="button" className="ec-ws__card-name" onClick={() => onOpen(project.id)}>
            {project.name}
          </button>
          <button
            type="button"
            className="ec-ws__pin"
            aria-label={project.pinned ? `取消置顶 ${project.name}` : `置顶 ${project.name}`}
            aria-pressed={project.pinned}
            disabled={busy}
            onClick={() => onTogglePinned(project.id, !project.pinned)}
          >
            {project.pinned ? '★' : '☆'}
          </button>
        </header>

        <p className="ec-ws__card-desc">{project.description ?? '（无描述）'}</p>

        <div className="ec-ws__card-tags">
          {project.targetPlatforms.length === 0 ? (
            <Tag color="neutral">未选目标端</Tag>
          ) : (
            project.targetPlatforms.map((platform) => (
              <Tag key={platform} color="info">
                {TARGET_PLATFORM_LABELS[platform]}
              </Tag>
            ))
          )}
        </div>

        <footer className="ec-ws__card-foot">
          <span className="ec-ws__time">{formatTime(project.updatedAt)}</span>
          <StageRing stage={stage} />
        </footer>

        <div className="ec-ws__card-actions">
          <button type="button" onClick={() => onOpenSettings(project.id)}>
            设置
          </button>
          <button type="button" disabled={busy} onClick={() => onArchive(project.id)}>
            {archived ? '取消归档' : '归档'}
          </button>
          <button
            type="button"
            disabled={busy}
            className="ec-ws__danger"
            onClick={() => onDelete(project.id)}
          >
            删除
          </button>
        </div>
      </div>
    </article>
  );
}

export function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 回收站剩余天数（30 天保留期） */
export function remainingDays(project: ProjectSummary, now: number, retentionMs: number): number {
  if (project.deletedAt === null) return retentionMs / (24 * 60 * 60 * 1000);
  const remain = project.deletedAt + retentionMs - now;
  return Math.max(0, Math.ceil(remain / (24 * 60 * 60 * 1000)));
}
