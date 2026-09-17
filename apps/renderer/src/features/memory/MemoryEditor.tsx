import { useEffect, useMemo, useState } from 'react';

import { Button, Input, Select, Switch, Tabs, Tag, Textarea } from '@ec/ui';
import {
  FEATURE_SECTION_LABELS,
  ISSUE_SECTION_LABELS,
  ISSUE_STATUS_LABELS,
  PAGE_SECTION_LABELS,
  PROJECT_SECTION_TITLES,
  MEMORY_STATUS_LABELS,
  type IssueStatus,
  type MemoryPatch,
} from '@ec/memory';

import { MarkdownPreview } from './MarkdownPreview';
import { ConflictBadge } from './ConflictBadge';
import type { MemoryDetail } from './memory-api';

/**
 * 记忆条目编辑器（FR-MEM-21）。
 *
 * 三个视图：
 * - **编辑**：Markdown 正文编辑；
 * - **预览**：Markdown 渲染结果；
 * - **结构化**：对已知分区的表单化编辑（页面骨架/状态/事件/接口依赖、功能流程/接口/错误码、
 *   问题现象/复现/已尝试/结论、项目技术选型/模块/路由…），未知键回退为 JSON 编辑。
 *
 * 保存走乐观锁：外壳抛冲突（条目被其他会话改过）时给出可读提示，不静默覆盖。
 */

export interface MemoryEditorProps {
  detail: MemoryDetail;
  /** 保存补丁；返回 Promise 时按钮进入 loading */
  onSave: (patch: MemoryPatch, expectedVersion: number) => Promise<void> | void;
  onTogglePin?: () => void;
  onSetIssueStatus?: (next: IssueStatus) => void;
  /** 只读模式（归档条目浏览 / 外部编辑器检测到改动后的保护态） */
  readOnly?: boolean;
}

/** 各 scope 已知分区的展示名，未知键回退为键名本身 */
function sectionLabel(scope: string, key: string): string {
  if (scope === 'page') return (PAGE_SECTION_LABELS as Record<string, string>)[key] ?? key;
  if (scope === 'feature') return (FEATURE_SECTION_LABELS as Record<string, string>)[key] ?? key;
  if (scope === 'issue') return (ISSUE_SECTION_LABELS as Record<string, string>)[key] ?? key;
  if (scope === 'project') return (PROJECT_SECTION_TITLES as Record<string, string>)[key] ?? key;
  return key;
}

export function MemoryEditor({
  detail,
  onSave,
  onTogglePin,
  onSetIssueStatus,
  readOnly = false,
}: MemoryEditorProps): JSX.Element {
  const { item } = detail;
  const [tab, setTab] = useState('edit');
  const [title, setTitle] = useState(item.title);
  const [content, setContent] = useState(item.content);
  const [tagsText, setTagsText] = useState(item.tags.join(', '));
  const [importance, setImportance] = useState(String(item.importance));
  const [structured, setStructured] = useState<Record<string, unknown>>(item.structured ?? {});
  const [jsonDraft, setJsonDraft] = useState(() => JSON.stringify(item.structured ?? {}, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 切换到另一条记忆时重置草稿（否则会把上一条的编辑内容带过去）
  useEffect(() => {
    setTitle(item.title);
    setContent(item.content);
    setTagsText(item.tags.join(', '));
    setImportance(String(item.importance));
    setStructured(item.structured ?? {});
    setJsonDraft(JSON.stringify(item.structured ?? {}, null, 2));
    setJsonError(null);
    setMessage(null);
  }, [item.id, item.version, item.title, item.content, item.tags, item.importance, item.structured]);

  const structuredKeys = useMemo(() => Object.keys(structured), [structured]);

  const handleSave = async (): Promise<void> => {
    const importanceValue = Number.parseInt(importance, 10);
    const patch: MemoryPatch = {
      title: title.trim(),
      content,
      tags: tagsText
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
      structured,
      ...(Number.isFinite(importanceValue) ? { importance: importanceValue } : {}),
    };
    setBusy(true);
    setMessage(null);
    try {
      await onSave(patch, item.version);
      setMessage('已保存');
    } catch (error) {
      setMessage(
        error instanceof Error && error.name === 'ConflictError'
          ? '该条目已被其他操作修改（版本冲突），请重新打开后再编辑'
          : `保存失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const applyJson = (): void => {
    try {
      const parsed: unknown = JSON.parse(jsonDraft);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('结构化数据必须是一个 JSON 对象');
        return;
      }
      setStructured(parsed as Record<string, unknown>);
      setJsonError(null);
    } catch (error) {
      setJsonError(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const disabled = readOnly || busy;

  return (
    <section className="ec-memory-editor" aria-label={`编辑「${item.title}」`}>
      <header className="ec-memory-editor__head">
        <Input
          value={title}
          onChange={setTitle}
          disabled={readOnly}
          aria-label="记忆标题"
          className="ec-memory-editor__title"
        />
        <span className="ec-memory-editor__meta">
          <Tag color="neutral">{MEMORY_STATUS_LABELS[item.status]}</Tag>
          {item.issueStatus && <Tag color="warning">{ISSUE_STATUS_LABELS[item.issueStatus]}</Tag>}
          <span className="ec-memory-editor__version">v{item.version}</span>
        </span>
      </header>

      <div className="ec-memory-editor__toolbar">
        <label className="ec-memory-editor__field">
          <span>重要度</span>
          <Select
            options={[1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) }))}
            value={importance}
            onChange={setImportance}
            disabled={readOnly}
            aria-label="重要度"
          />
        </label>
        <label className="ec-memory-editor__field ec-memory-editor__field--wide">
          <span>标签</span>
          <Input value={tagsText} onChange={setTagsText} disabled={readOnly} aria-label="标签（逗号分隔）" />
        </label>
        {onTogglePin && (
          <Switch checked={item.pinned} onChange={() => onTogglePin()} label="置顶" />
        )}
        {item.scope === 'issue' && onSetIssueStatus && (
          <label className="ec-memory-editor__field">
            <span>处置状态</span>
            <Select
              options={[
                { value: 'unsolved', label: ISSUE_STATUS_LABELS.unsolved },
                { value: 'solved', label: ISSUE_STATUS_LABELS.solved },
                { value: 'mitigated', label: ISSUE_STATUS_LABELS.mitigated },
              ]}
              value={item.issueStatus ?? 'unsolved'}
              onChange={(value) => onSetIssueStatus(value as IssueStatus)}
              aria-label="处置状态"
            />
          </label>
        )}
      </div>

      {detail.conflicts.length > 0 && (
        <div className="ec-memory-editor__conflicts" aria-label="冲突来源">
          {detail.conflicts.map((annotation) => (
            <ConflictBadge
              key={`${annotation.role}:${annotation.counterpartId}:${annotation.field}`}
              annotation={annotation}
            />
          ))}
        </div>
      )}

      <Tabs
        items={[
          { key: 'edit', label: '编辑' },
          { key: 'preview', label: '预览' },
          { key: 'structured', label: '结构化' },
        ]}
        value={tab}
        onChange={setTab}
        // eslint-disable-next-line react/no-children-prop -- Tabs 的 children 是渲染函数（render prop）
        children={(active) => {
          if (active === 'edit') {
            return (
              <Textarea
                value={content}
                onChange={setContent}
                disabled={readOnly}
                autoSize
                rows={12}
                aria-label="记忆正文（Markdown）"
              />
            );
          }
          if (active === 'preview') {
            return <MarkdownPreview text={content} />;
          }
          return (
            <div className="ec-memory-editor__structured">
              {structuredKeys.length === 0 && <p className="ec-memory-editor__hint">该条目暂无结构化数据。</p>}
              {structuredKeys.map((key) => (
                <StructuredField
                  key={key}
                  label={sectionLabel(item.scope, key)}
                  value={structured[key]}
                  disabled={readOnly}
                  onChange={(next) => setStructured((prev) => ({ ...prev, [key]: next }))}
                />
              ))}
              <details className="ec-memory-editor__raw">
                <summary>以 JSON 编辑全部结构化数据</summary>
                <Textarea value={jsonDraft} onChange={setJsonDraft} rows={8} aria-label="结构化 JSON" />
                {jsonError && (
                  <p className="ec-memory-editor__error" role="alert">
                    {jsonError}
                  </p>
                )}
                <Button variant="secondary" size="sm" onClick={applyJson} disabled={readOnly}>
                  应用 JSON
                </Button>
              </details>
            </div>
          );
        }}
      />

      <footer className="ec-memory-editor__foot">
        <Button variant="primary" onClick={() => void handleSave()} disabled={disabled} loading={busy}>
          保存
        </Button>
        {message && (
          <span className="ec-memory-editor__message" role="status">
            {message}
          </span>
        )}
      </footer>
    </section>
  );
}

interface StructuredFieldProps {
  label: string;
  value: unknown;
  disabled: boolean;
  onChange: (next: unknown) => void;
}

/**
 * 结构化字段编辑：
 * - 字符串 → 多行文本
 * - 基本类型数组 → 一行一项
 * - 其它（对象 / 对象数组）→ JSON 文本
 */
function StructuredField({ label, value, disabled, onChange }: StructuredFieldProps): JSX.Element {
  const [raw, setRaw] = useState(() => toEditable(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRaw(toEditable(value));
    setError(null);
  }, [value]);

  const isPlainText = typeof value === 'string';
  const isLineList = Array.isArray(value) && value.every((entry) => typeof entry !== 'object' || entry === null);

  return (
    <label className="ec-memory-editor__structured-field">
      <span className="ec-memory-editor__structured-label">{label}</span>
      <Textarea
        value={raw}
        disabled={disabled}
        rows={isPlainText ? 2 : Math.min(8, Math.max(3, raw.split('\n').length))}
        aria-label={label}
        onChange={(next) => {
          setRaw(next);
          if (isPlainText) {
            onChange(next);
            return;
          }
          if (isLineList) {
            onChange(
              next
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            );
            return;
          }
          try {
            const parsed: unknown = JSON.parse(next);
            onChange(parsed);
            setError(null);
          } catch {
            // 编辑中的 JSON 允许暂时非法，只记录错误、等用户改好
            setError('JSON 尚未闭合');
          }
        }}
      />
      {error && (
        <span className="ec-memory-editor__error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

function toEditable(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry !== 'object' || entry === null)) {
    return value.map((entry) => String(entry)).join('\n');
  }
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
