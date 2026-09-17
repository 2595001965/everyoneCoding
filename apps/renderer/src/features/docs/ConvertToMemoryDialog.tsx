/**
 * ConvertToMemoryDialog（T9-04 / FR-DOC-04）：选中文档或片段 → 一键转为记忆。
 *
 * 契约：摘要由 AI 端口生成（`previewConvertToMemory`），**端口缺失时如实报错并给引导，
 * 不用内置模板顶替**；生成的草稿可编辑，提交时保留原文链接（docId + 段落锚点）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Modal, Select, Textarea } from '@ec/ui';
import {
  DOC_MEMORY_SCOPE_LABELS,
  DOC_MEMORY_SCOPES,
  type ConvertDraft,
  type DocMemoryNode,
  type DocMemoryScope,
  type DocSection,
} from '@ec/core';

import { useDocs } from './docs-api';

export interface ConvertToMemoryDialogProps {
  open: boolean;
  projectId: string;
  documentId: string;
  documentTitle: string;
  sections: DocSection[];
  onClose: () => void;
  onConverted: (node: DocMemoryNode) => void;
}

export function ConvertToMemoryDialog({
  open,
  projectId,
  documentId,
  documentTitle,
  sections,
  onClose,
  onConverted,
}: ConvertToMemoryDialogProps): JSX.Element {
  const api = useDocs();
  const [scope, setScope] = useState<DocMemoryScope>('project');
  const [anchor, setAnchor] = useState<string>('');
  const [draft, setDraft] = useState<ConvertDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开重置（避免上一次的草稿串场）
  useEffect(() => {
    if (!open) {
      setDraft(null);
      setError(null);
      setAnchor('');
      setScope('project');
    }
  }, [open]);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.previewConvertToMemory({
        docId: documentId,
        scope,
        ...(anchor ? { anchor } : {}),
      });
      setDraft(next);
    } catch (cause: unknown) {
      // AI 端口缺失 / 正文为空 → 如实展示，让用户知道为什么不能自动摘要
      setError(cause instanceof Error ? cause.message : String(cause));
      setDraft(null);
    } finally {
      setBusy(false);
    }
  }, [anchor, api, documentId, scope]);

  const commit = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const node = await api.commitConvertToMemory({ projectId, draft, scope });
      onConverted(node);
      onClose();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, draft, onClose, onConverted, projectId, scope]);

  const sectionOptions = [
    { value: '', label: '整篇文档' },
    ...sections
      .filter((section) => section.level > 0)
      .map((section) => ({
        value: section.anchor,
        label: `${'　'.repeat(Math.max(0, section.level - 1))}${section.heading}`,
      })),
  ];

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`转为记忆：《${documentTitle}》`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          {draft ? (
            <Button variant="primary" loading={busy} onClick={() => void commit()}>
              保存为记忆
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => void generate()}>
              生成结构化摘要
            </Button>
          )}
        </>
      }
    >
      <div className="ec-docs__form">
        <label className="ec-docs__field">
          <span>记忆层级</span>
          <Select
            aria-label="记忆层级"
            value={scope}
            options={DOC_MEMORY_SCOPES.map((value) => ({ value, label: DOC_MEMORY_SCOPE_LABELS[value] }))}
            onChange={(value) => setScope(value as DocMemoryScope)}
          />
        </label>
        <label className="ec-docs__field">
          <span>范围</span>
          <Select
            aria-label="转换范围"
            value={anchor}
            options={sectionOptions}
            onChange={setAnchor}
          />
        </label>

        {draft ? (
          <>
            <label className="ec-docs__field">
              <span>标题（可编辑）</span>
              <Input value={draft.title} onChange={(value) => setDraft({ ...draft, title: value })} aria-label="记忆标题" />
            </label>
            <label className="ec-docs__field">
              <span>摘要内容（可编辑）</span>
              <Textarea
                value={draft.content}
                onChange={(value) => setDraft({ ...draft, content: value })}
                rows={10}
                aria-label="记忆摘要"
              />
            </label>
            <p className="ec-docs__hint">
              {`原文链接将被保留：docId=${draft.sourceRef.docId}${draft.sourceRef.anchor ? `#${draft.sourceRef.anchor}` : ''}`}
            </p>
          </>
        ) : null}

        {error ? <p className="ec-docs__error">{error}</p> : null}
      </div>
    </Modal>
  );
}
