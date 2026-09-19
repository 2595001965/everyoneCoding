/**
 * 冲突解决（T6-04 要点 2）：**三栏**（当前 / 结果 / 传入）逐块选择。
 *
 * 硬约束 D-04：AI 是代码的唯一写入口，**UI 不提供任何可编辑代码的控件**
 * （没有 textarea / contentEditable）。用户只能选择「采用哪一侧」，结果经
 * `applyResolution` 交给 AI 写入管线落盘；「两侧都要」走 `requestAiMerge`。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, EmptyState, Tag } from '@ec/ui';
import {
  CONFLICT_RESOLUTION_LABELS,
  resolveBlock,
  resolveConflictFile,
  summarizeConflicts,
  type ConflictBlock,
  type ConflictFile,
  type ConflictResolution,
} from '@ec/git';

import { useGitApi } from './git-api';

export interface ConflictEditorProps {
  /** 应用解决结果后回调 */
  onApplied?: () => void;
}

type Choices = Record<number, ConflictResolution>;

const OPTIONS: readonly { key: Exclude<ConflictResolution, 'ai' | 'unresolved'>; label: string }[] =
  [
    { key: 'ours', label: '采用当前' },
    { key: 'theirs', label: '采用传入' },
    { key: 'both', label: '两侧都要（交给 AI 合并）' },
  ];

export function ConflictEditor({ onApplied }: ConflictEditorProps): JSX.Element {
  const api = useGitApi();
  const [files, setFiles] = useState<ConflictFile[]>([]);
  const [choices, setChoices] = useState<Record<string, Choices>>({});
  const [aiRequest, setAiRequest] = useState<{
    path: string;
    instruction: string;
    context: string;
  } | null>(null);
  const [message, setMessage] = useState('解决合并冲突');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const result = await api.conflicts();
    if (result.ok && result.data !== null) {
      setFiles(result.data);
      setChoices({});
    }
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const choose = useCallback((path: string, blockIndex: number, resolution: ConflictResolution) => {
    setChoices((prev) => ({
      ...prev,
      [path]: { ...(prev[path] ?? {}), [blockIndex]: resolution },
    }));
  }, []);

  /** 把本地选择合并进协议文件（不修改领域层对象） */
  const effective = useMemo<ConflictFile[]>(
    () =>
      files.map((file) => ({
        ...file,
        blocks: file.blocks.map((block) => ({
          ...block,
          resolution: choices[file.path]?.[block.index] ?? 'unresolved',
        })),
      })),
    [files, choices],
  );

  const summary = useMemo(() => summarizeConflicts(effective), [effective]);
  const allResolved = summary.blocks > 0 && summary.unresolved === 0;

  const requestAi = useCallback(
    async (path: string, blockIndex: number) => {
      const result = await api.requestAiMerge({ path, blockIndex });
      if (result.ok && result.data !== null) {
        setAiRequest({ path, instruction: result.data.instruction, context: result.data.context });
      } else {
        setNotice(result.error?.message ?? 'AI 合并请求失败');
      }
    },
    [api],
  );

  const apply = useCallback(async () => {
    if (!allResolved) return;
    setBusy(true);
    for (const file of effective) {
      const fileChoices: Choices = {};
      for (const block of file.blocks) {
        const resolution = choices[file.path]?.[block.index];
        if (resolution !== undefined && resolution !== 'unresolved')
          fileChoices[block.index] = resolution;
      }
      const resolved = resolveConflictFile(file, fileChoices);
      const result = await api.applyResolution({
        path: file.path,
        content: resolved.content,
        message,
      });
      if (!result.ok) {
        setNotice(result.error?.message ?? '应用解决结果失败');
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    setNotice('解决结果已交给 AI 写入管线落盘');
    await reload();
    onApplied?.();
  }, [api, effective, choices, message, allResolved, reload, onApplied]);

  if (loading) {
    return <span role="status">读取冲突中…</span>;
  }

  if (files.length === 0) {
    return (
      <EmptyState
        title="当前没有冲突"
        description="需要先执行合并或拉取并产生冲突，这里才会出现待解决内容。"
      />
    );
  }

  return (
    <div
      className="ec-conflict-editor"
      data-testid="conflict-editor"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div className="ec-conflict-editor__summary" role="status" data-testid="conflict-summary">
        共 {summary.files} 个文件、{summary.blocks} 个冲突块，未解决{' '}
        <strong>{summary.unresolved}</strong> 块
      </div>

      {files.map((file) => (
        <section
          key={file.path}
          className="ec-conflict-editor__file"
          data-testid={`conflict-file-${file.path}`}
        >
          <header style={{ fontWeight: 600, fontFamily: 'monospace' }}>{file.path}</header>

          <div
            className="ec-conflict-editor__cols"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 8,
              fontWeight: 600,
              color: 'var(--ec-color-text-secondary)',
            }}
          >
            <span>{file.oursLabel || '当前'}</span>
            <span>结果</span>
            <span>{file.theirsLabel || '传入'}</span>
          </div>

          {file.blocks.map((block) => {
            const resolution = choices[file.path]?.[block.index] ?? 'unresolved';
            const resolvedLines =
              resolution === 'unresolved' ? [] : resolveBlock(block, resolution);
            return (
              <div
                key={block.index}
                className="ec-conflict-editor__block"
                data-testid={`conflict-block-${file.path}-${block.index}`}
              >
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <CodeColumn lines={block.ours} testId="col-ours" />
                  <CodeColumn lines={resolvedLines} testId="col-result" placeholder="尚未选择" />
                  <CodeColumn lines={block.theirs} testId="col-theirs" />
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                  {OPTIONS.map((option) => (
                    <Button
                      key={option.key}
                      size="sm"
                      variant={resolution === option.key ? 'primary' : 'ghost'}
                      onClick={() => {
                        choose(file.path, block.index, option.key);
                        if (option.key === 'both') void requestAi(file.path, block.index);
                      }}
                      data-testid={`resolve-${option.key}-${file.path}-${block.index}`}
                    >
                      {option.label}
                    </Button>
                  ))}
                  <Tag
                    color={resolution === 'unresolved' ? 'warning' : 'success'}
                    data-testid={`resolution-${file.path}-${block.index}`}
                  >
                    {CONFLICT_RESOLUTION_LABELS[resolution]}
                  </Tag>
                </div>
              </div>
            );
          })}
        </section>
      ))}

      {aiRequest !== null && (
        <div className="ec-conflict-editor__ai" role="status" data-testid="ai-merge-request">
          <div>
            已将 {aiRequest.path} 的冲突交给 AI
            合并（这里只展示将要发送的指令与上下文，不接受手写代码）：
          </div>
          <pre data-testid="ai-merge-instruction">{aiRequest.instruction}</pre>
          <pre data-testid="ai-merge-context">{aiRequest.context}</pre>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ color: 'var(--ec-color-text-secondary)' }}>
          提交说明
          <input
            aria-label="解决提交说明"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="conflict-message"
            style={{
              marginLeft: 8,
              padding: '4px 8px',
              border: '1px solid var(--ec-color-border)',
              borderRadius: 6,
              background: 'var(--ec-color-surface)',
              color: 'var(--ec-color-text)',
            }}
          />
        </label>
        <Button
          size="sm"
          variant="primary"
          onClick={apply}
          disabled={!allResolved}
          loading={busy}
          data-testid="conflict-apply"
        >
          应用解决结果
        </Button>
        <Button size="sm" onClick={() => void reload()} data-testid="conflict-reload">
          重新扫描
        </Button>
        {notice !== null && (
          <span
            role="status"
            style={{ color: 'var(--ec-color-text-secondary)' }}
            data-testid="conflict-notice"
          >
            {notice}
          </span>
        )}
      </div>
    </div>
  );
}

/** 只读代码列：用 `<pre>` 展示，绝不使用可编辑控件（D-04） */
function CodeColumn({
  lines,
  testId,
  placeholder,
}: {
  lines: readonly string[];
  testId: string;
  placeholder?: string;
}): JSX.Element {
  return (
    <pre
      data-testid={testId}
      style={{
        margin: 0,
        padding: 6,
        minHeight: 40,
        fontFamily: 'monospace',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        background: 'var(--ec-color-bg-subtle)',
        borderRadius: 6,
        color: 'var(--ec-color-text)',
      }}
    >
      {lines.length === 0 ? (placeholder ?? '') : lines.join('\n')}
    </pre>
  );
}

/** 供测试与上层复用的「块选择」辅助类型 */
export type { ConflictBlock };
