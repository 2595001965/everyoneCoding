/**
 * DocLibrary（T9-04 / FR-DOC-01）：文档库列表 + 导入 + 回收站。
 *
 * 导入分工：markdown / txt 直接在 UI 粘贴文本；docx / pdf / image 由外壳按文件路径读取
 * （渲染层无文件系统权限），端口方法为 `importFromFile`。
 *
 * 检索：关键词同时过滤标题，并经 `searchDocuments` 做正文全文检索（含图片 OCR 文字），
 * 命中项带段落锚点，点击直接打开文档并定位到该段。
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
import {
  DOC_FORMAT_LABELS,
  DOC_FORMATS,
  type DocFormat,
  type DocSearchHit,
  type DocSummary,
} from '@ec/core';

import { useDocs, type OcrStatus } from './docs-api';

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
  /** 选中文档；从检索命中进入时带上段落锚点 */
  onSelect: (id: string, anchor?: string) => void;
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
  const [hits, setHits] = useState<DocSearchHit[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

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

  // 正文全文检索（去抖 250ms；回收站视图不检索；文档增删后随 docs 重新检索）
  useEffect(() => {
    const query = keyword.trim();
    if (!query || showRecycleBin) {
      setHits([]);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.searchDocuments(projectId, query).then(
        (result) => {
          if (cancelled) return;
          setHits(result);
          setSearchError(null);
        },
        (cause: unknown) => {
          if (cancelled) return;
          setHits([]);
          setSearchError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, keyword, projectId, showRecycleBin, docs]);

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
          placeholder="搜索标题或正文（含图片识别文字）"
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
      {searchError ? <p className="ec-docs__error">{`正文检索失败：${searchError}`}</p> : null}

      {hits.length > 0 ? (
        <ul className="ec-docs__hits" aria-label="正文命中">
          {hits.map((hit) => (
            <li key={`${hit.docId}#${hit.anchor}`}>
              <button type="button" onClick={() => onSelect(hit.docId, hit.anchor)}>
                <strong>{hit.title}</strong>
                <Tag color="neutral">{DOC_FORMAT_LABELS[hit.format] ?? hit.format}</Tag>
                {hit.page !== undefined ? <span>{`第 ${hit.page} 页`}</span> : null}
                <span className="ec-docs__hit-snippet">{hit.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {visible.length === 0 && !loading && hits.length === 0 ? (
        <EmptyState
          title={showRecycleBin ? '回收站为空' : '还没有文档'}
          description={
            showRecycleBin
              ? '删除的文档会在这里保留，可恢复或彻底删除。'
              : keyword.trim()
                ? '标题与正文都没有匹配的内容。'
                : '支持导入 Markdown / Word / PDF / TXT / 图片（OCR），导入后可关联到记忆节点。'
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
  const [ocr, setOcr] = useState<OcrStatus | null>(null);
  const [ocrLanguage, setOcrLanguage] = useState('');

  const supported = api.supportedFormats();
  const isText = TEXT_FORMATS.includes(format);
  const isImage = format === 'image';

  // 选中图片格式时探测一次 OCR 引擎（可用性 + 已装识别语言 + 安装引导）
  useEffect(() => {
    if (!open || !isImage) return;
    let cancelled = false;
    setOcr(null);
    api.ocrStatus().then(
      (status) => {
        if (cancelled) return;
        setOcr(status);
        setOcrLanguage((current) =>
          current && status.languages.includes(current) ? current : (status.languages[0] ?? ''),
        );
      },
      (cause: unknown) => {
        if (cancelled) return;
        setOcr({
          available: false,
          reason: `OCR 状态检测失败：${cause instanceof Error ? cause.message : String(cause)}`,
          languages: [],
          detail: '',
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, isImage, open]);

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
            ...(isImage && ocrLanguage ? { ocrLanguage } : {}),
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

  const ocrBlocked = isImage && ocr?.available !== true;
  const canSubmit = isText ? text.trim().length > 0 : filePath.trim().length > 0 && !ocrBlocked;

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
        {isImage ? (
          <OcrPanel status={ocr} language={ocrLanguage} onLanguage={setOcrLanguage} />
        ) : null}
        {error ? <p className="ec-docs__error">{error}</p> : null}
      </div>
    </Modal>
  );
}

/** 图片导入的 OCR 面板：检测中 / 可用（选识别语言）/ 不可用（原因 + 安装引导） */
function OcrPanel({
  status,
  language,
  onLanguage,
}: {
  status: OcrStatus | null;
  language: string;
  onLanguage: (value: string) => void;
}): JSX.Element {
  if (status === null) {
    return (
      <p className="ec-docs__hint" role="status">
        正在检测本机文字识别（OCR）引擎…
      </p>
    );
  }
  if (!status.available) {
    return (
      <div className="ec-docs__error" role="alert" aria-label="OCR 不可用">
        <p>{`文字识别不可用：${status.reason ?? '未知原因'}`}</p>
        <p>
          安装方法：Windows 设置 → 时间和语言 → 语言和区域 → 添加语言（如「中文(简体)」或
          「English」），并确认勾选“光学字符识别”组件；安装完成后重新打开本对话框即可。
        </p>
        {status.languages.length > 0 ? (
          <p>{`已装识别语言：${status.languages.join(' / ')}`}</p>
        ) : null}
      </div>
    );
  }
  return (
    <label className="ec-docs__field">
      <span>识别语言（按图中文字选择；列表为本机已装的 OCR 语言）</span>
      <Select
        aria-label="识别语言"
        value={language}
        options={status.languages.map((tag) => ({ value: tag, label: ocrLanguageLabel(tag) }))}
        onChange={onLanguage}
      />
    </label>
  );
}

function ocrLanguageLabel(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh-hans') || lower === 'zh-cn') return `简体中文（${tag}）`;
  if (lower.startsWith('zh-hant') || lower === 'zh-tw') return `繁体中文（${tag}）`;
  if (lower.startsWith('en')) return `英语（${tag}）`;
  if (lower.startsWith('ja')) return `日语（${tag}）`;
  return tag;
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
