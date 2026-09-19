/**
 * DocLibrary（T9-04 / FR-DOC-01）：文档库列表 + 导入 + 回收站。
 *
 * 导入分工：markdown / txt 直接在 UI 粘贴文本；docx / pdf / image 由外壳按文件路径读取
 * （渲染层无文件系统权限），端口方法为 `importFromFile`。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  EmptyState,
  Input,
  Modal,
  Select,
  Table,
  Tag,
  Textarea,
  type Column,
} from '@ec/ui';
import { DOC_FORMAT_LABELS, DOC_FORMATS, type DocFormat, type DocSummary } from '@ec/core';

import { useDocs } from './docs-api';

const KIND_LABELS: Record<string, string> = {
  requirement: '需求文档',
  tech: '技术文档',
  design: '设计文档',
  api: '接口文档',
  imported: '导入文档',
};

const TEXT_FORMATS: DocFormat[] = ['markdown', 'txt'];

export interface DocLibraryProps {
  projectId: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 数据变更后通知外层（关联面板 / 仪表盘刷新） */
  onChanged?: () => void;
}

export function DocLibrary({
  projectId,
  selectedId,
  onSelect,
  onChanged,
}: DocLibraryProps): JSX.Element {
  const api = useDocs();
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocSummary | null>(null);
  const [purging, setPurging] = useState<DocSummary | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listDocuments(projectId, { includeDeleted: showRecycleBin });
      setDocs(list);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [api, projectId, showRecycleBin]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase();
    const filtered = showRecycleBin ? docs.filter((doc) => doc.deletedAt !== null) : docs;
    if (!trimmed) return filtered;
    return filtered.filter((doc) => doc.title.toLowerCase().includes(trimmed));
  }, [docs, keyword, showRecycleBin]);

  const handleDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    await api.deleteDocument(pendingDelete.id);
    setPendingDelete(null);
    await reload();
    onChanged?.();
  };

  const handleRestore = async (id: string): Promise<void> => {
    await api.restoreDocument(id);
    await reload();
    onChanged?.();
  };

  const handlePurge = async (): Promise<void> => {
    if (!purging) return;
    await api.purgeDocument(purging.id);
    setPurging(null);
    await reload();
    onChanged?.();
  };

  const columns: Column<DocSummary>[] = [
    {
      key: 'title',
      title: '标题',
      render: (row) => (
        <span className="ec-docs__title">
          {row.title}
          {row.version > 1 ? <Tag color="info">{`v${row.version}`}</Tag> : null}
        </span>
      ),
    },
    { key: 'kind', title: '类型', width: 110, render: (row) => KIND_LABELS[row.kind] ?? row.kind },
    {
      key: 'format',
      title: '格式',
      width: 110,
      render: (row) => DOC_FORMAT_LABELS[row.format] ?? row.format,
    },
    {
      key: 'sections',
      title: '章节',
      width: 80,
      align: 'right',
      render: (row) => `${row.sections.filter((section) => section.level > 0).length}`,
    },
    { key: 'updatedAt', title: '更新时间', width: 170, render: (row) => formatTime(row.updatedAt) },
    {
      key: 'actions',
      title: '操作',
      width: 160,
      render: (row) =>
        row.deletedAt !== null ? (
          <span className="ec-docs__actions">
            <Button size="sm" variant="ghost" onClick={() => void handleRestore(row.id)}>
              恢复
            </Button>
            <Button size="sm" variant="danger" onClick={() => setPurging(row)}>
              彻底删除
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setPendingDelete(row)}>
            删除
          </Button>
        ),
    },
  ];

  return (
    <section className="ec-docs__library" aria-label="文档库">
      <header className="ec-docs__toolbar">
        <Input
          value={keyword}
          onChange={setKeyword}
          placeholder="搜索文档标题"
          aria-label="搜索文档"
        />
        <Checkbox
          checked={showRecycleBin}
          onChange={(checked: boolean) => setShowRecycleBin(checked)}
          label="回收站"
        />
        <Button variant="primary" onClick={() => setImportOpen(true)}>
          导入文档
        </Button>
      </header>

      {error ? <p className="ec-docs__error">{error}</p> : null}

      {visible.length === 0 && !loading ? (
        <EmptyState
          title={showRecycleBin ? '回收站为空' : '还没有文档'}
          description={
            showRecycleBin
              ? '删除的文档会在这里保留，可恢复或彻底删除。'
              : '支持导入 Markdown / Word / PDF / TXT，导入后可关联到记忆节点。'
          }
        />
      ) : (
        <Table
          aria-label="文档列表"
          columns={columns}
          rows={visible}
          rowKey={(row) => row.id}
          height={320}
          onRowSelect={(_key, row) => onSelect(row.id)}
          {...(selectedId !== null ? { selectedKey: selectedId } : {})}
        />
      )}

      <ImportDocDialog
        open={importOpen}
        projectId={projectId}
        onClose={() => setImportOpen(false)}
        onImported={async (doc) => {
          setImportOpen(false);
          await reload();
          onSelect(doc.id);
          onChanged?.();
        }}
      />

      <Modal
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="删除文档"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button variant="danger" onClick={() => void handleDelete()}>
              确认删除
            </Button>
          </>
        }
      >
        <p>{`确认删除《${pendingDelete?.title ?? ''}》？删除后进入回收站，可恢复。`}</p>
      </Modal>

      <Modal
        open={purging !== null}
        onOpenChange={(open) => {
          if (!open) setPurging(null);
        }}
        title="彻底删除文档"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPurging(null)}>
              取消
            </Button>
            <Button variant="danger" onClick={() => void handlePurge()}>
              彻底删除
            </Button>
          </>
        }
      >
        <p>{`彻底删除后无法恢复，《${purging?.title ?? ''}》的版本历史与记忆关联将一并移除。`}</p>
      </Modal>
    </section>
  );
}

interface ImportDocDialogProps {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onImported: (doc: DocSummary) => void | Promise<void>;
}

function ImportDocDialog({
  open,
  projectId,
  onClose,
  onImported,
}: ImportDocDialogProps): JSX.Element {
  const api = useDocs();
  const [format, setFormat] = useState<DocFormat>('markdown');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [filePath, setFilePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported = api.supportedFormats();
  const isText = TEXT_FORMATS.includes(format);

  const options = DOC_FORMATS.map((value) => ({
    value,
    label: supported.includes(value)
      ? DOC_FORMAT_LABELS[value]
      : `${DOC_FORMAT_LABELS[value]}（当前环境不可解析）`,
    disabled: !supported.includes(value),
  }));

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const doc = isText
        ? await api.importDocument({
            projectId,
            format,
            raw: text,
            ...(title.trim() ? { title: title.trim() } : {}),
          })
        : await api.importFromFile({
            projectId,
            format,
            filePath: filePath.trim(),
            ...(title.trim() ? { title: title.trim() } : {}),
          });
      setText('');
      setTitle('');
      setFilePath('');
      await onImported(doc);
    } catch (cause: unknown) {
      // 解析失败/不支持 OCR 都要如实展示，不静默吞掉
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = isText ? text.trim().length > 0 : filePath.trim().length > 0;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="导入文档"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            导入
          </Button>
        </>
      }
    >
      <div className="ec-docs__form">
        <label className="ec-docs__field">
          <span>格式</span>
          <Select
            aria-label="文档格式"
            value={format}
            options={options}
            onChange={(value) => setFormat(value as DocFormat)}
          />
        </label>
        <label className="ec-docs__field">
          <span>标题（留空则取文档内首个标题）</span>
          <Input value={title} onChange={setTitle} placeholder="文档标题" aria-label="文档标题" />
        </label>
        {isText ? (
          <label className="ec-docs__field">
            <span>内容</span>
            <Textarea
              value={text}
              onChange={setText}
              autoSize={false}
              rows={10}
              placeholder={'# 需求文档\n\n## 功能\n- 登录：支持邮箱与第三方登录'}
              aria-label="文档内容"
            />
          </label>
        ) : (
          <label className="ec-docs__field">
            <span>文件路径（由客户端读取并解析）</span>
            <Input
              value={filePath}
              onChange={setFilePath}
              placeholder="D:\\docs\\需求说明.pdf"
              aria-label="文件路径"
            />
          </label>
        )}
        {error ? <p className="ec-docs__error">{error}</p> : null}
      </div>
    </Modal>
  );
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
