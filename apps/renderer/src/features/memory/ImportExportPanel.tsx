import { useState } from 'react';

import { Button, Input, Modal, Select, Switch, Table, Tag, Textarea, type Column } from '@ec/ui';

import type {
  ImportClassification,
  ImportPreviewModel,
  ImportPreviewRow,
  ImportResolution,
  MemoryExportFormat,
} from './memory-api';

/**
 * 记忆导入 / 导出面板（FR-MEM-22）。
 *
 * 导出：JSON（全字段）/ Markdown（按层级分文件），可含归档条目。
 * 导入：先解析出四类差异预览（新增 / 冲突 / 无变化 / 缺失），**默认不覆盖本地**，
 * 冲突逐条决策（保留本地 / 采用导入 / 合并 / 两者都保留），也支持按分类批量决策。
 *
 * 数据只在本地文件间流转（D-02 / D-05），没有云端上传。
 */

const CLASSIFICATION_LABELS: Record<ImportClassification, string> = {
  added: '新增',
  conflicted: '冲突',
  unchanged: '无变化',
  missing: '缺失',
};

const CLASSIFICATION_COLORS: Record<ImportClassification, 'success' | 'warning' | 'neutral' | 'danger'> = {
  added: 'success',
  conflicted: 'warning',
  unchanged: 'neutral',
  missing: 'danger',
};

const RESOLUTION_OPTIONS: Array<{ value: ImportResolution; label: string }> = [
  { value: 'keepLocal', label: '保留本地' },
  { value: 'takeNew', label: '采用导入' },
  { value: 'merge', label: '合并' },
  { value: 'keepBoth', label: '两者都保留' },
];

export interface ImportExportPanelProps {
  onExport: (format: MemoryExportFormat, includeArchived: boolean) => Promise<void> | void;
  onPreviewImport: (
    files: Array<{ name: string; content: string }>,
  ) => Promise<ImportPreviewModel> | ImportPreviewModel;
  onCommitImport: (decisions: Array<{ id: string; resolution: ImportResolution }>) => Promise<void> | void;
  /** 导出结果摘要（由外壳回传：文件名列表） */
  lastExportNames?: readonly string[];
}

export function ImportExportPanel({
  onExport,
  onPreviewImport,
  onCommitImport,
  lastExportNames = [],
}: ImportExportPanelProps): JSX.Element {
  const [includeArchived, setIncludeArchived] = useState(true);
  const [fileName, setFileName] = useState('memories.json');
  const [pasteText, setPasteText] = useState('');
  const [preview, setPreview] = useState<ImportPreviewModel | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ImportResolution>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openPreview = async (): Promise<void> => {
    if (pasteText.trim().length === 0) {
      setError('请先粘贴导出内容，或选择导出的文件');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const model = await onPreviewImport([{ name: fileName, content: pasteText }]);
      setPreview(model);
      const initial: Record<string, ImportResolution> = {};
      for (const row of model.rows) initial[row.id] = defaultResolution(row.classification);
      setDecisions(initial);
    } catch (err) {
      setError(`解析失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const commit = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    try {
      await onCommitImport(
        preview.rows
          .filter((row) => row.classification !== 'unchanged')
          .map((row) => ({ id: row.id, resolution: decisions[row.id] ?? defaultResolution(row.classification) })),
      );
      setPreview(null);
      setPasteText('');
    } finally {
      setBusy(false);
    }
  };

  const columns: Array<Column<ImportPreviewRow>> = [
    {
      key: 'title',
      title: '条目',
      render: (row) => (
        <span className="ec-import__title">
          {row.classification === 'missing' ? row.localTitle : row.incomingTitle ?? row.title}
        </span>
      ),
    },
    {
      key: 'classification',
      title: '差异',
      width: 90,
      render: (row) => (
        <Tag color={CLASSIFICATION_COLORS[row.classification]}>{CLASSIFICATION_LABELS[row.classification]}</Tag>
      ),
    },
    {
      key: 'resolution',
      title: '处理方式',
      width: 160,
      render: (row) => (
        <Select
          options={RESOLUTION_OPTIONS}
          value={decisions[row.id] ?? defaultResolution(row.classification)}
          onChange={(value) => setDecisions((prev) => ({ ...prev, [row.id]: value as ImportResolution }))}
          aria-label={`「${row.title}」的处理方式`}
          size="sm"
        />
      ),
    },
  ];

  return (
    <section className="ec-import" aria-label="记忆导入导出">
      <header className="ec-import__head">
        <h2 className="ec-import__title">导入 / 导出</h2>
        <p className="ec-import__desc">
          记忆只在本机保存，跨设备传递通过导出的文件手动完成，不经云端同步。
        </p>
      </header>

      <div className="ec-import__row">
        <Button size="sm" variant="secondary" onClick={() => void onExport('json', includeArchived)}>
          导出 JSON
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void onExport('markdown', includeArchived)}>
          导出 Markdown
        </Button>
        <Switch checked={includeArchived} onChange={setIncludeArchived} label="包含已归档条目" />
        {lastExportNames.length > 0 && (
          <span className="ec-import__hint" role="status">
            已导出：{lastExportNames.join('、')}
          </span>
        )}
      </div>

      <div className="ec-import__row">
        <Input
          value={fileName}
          onChange={setFileName}
          aria-label="导入文件标识"
          placeholder="memories.json"
          className="ec-import__filename"
        />
        <Button size="sm" variant="primary" loading={busy} onClick={() => void openPreview()}>
          解析并预览差异
        </Button>
      </div>

      <Textarea
        value={pasteText}
        onChange={setPasteText}
        rows={6}
        aria-label="粘贴导出内容"
        placeholder="把导出的 JSON / JSONL / Markdown 内容粘贴到这里"
      />
      {error && (
        <p className="ec-import__error" role="alert">
          {error}
        </p>
      )}

      <Modal
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title="导入冲突合并预览"
        size="lg"
        footer={
          <div className="ec-import__modal-foot">
            <Button variant="secondary" onClick={() => setPreview(null)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void commit()}>
              确认导入
            </Button>
          </div>
        }
      >
        {preview && (
          <div className="ec-import__preview">
            <p className="ec-import__summary">
              新增 {preview.counts.added} / 冲突 {preview.counts.conflicted} / 无变化 {preview.counts.unchanged} / 缺失{' '}
              {preview.counts.missing}；默认不覆盖本地，请在下方逐条确认。
            </p>
            <div className="ec-import__batch">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setBulk(preview, setDecisions, 'conflicted', 'keepLocal')}
              >
                冲突全部保留本地
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setBulk(preview, setDecisions, 'conflicted', 'merge')}>
                冲突全部合并
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setBulk(preview, setDecisions, 'conflicted', 'keepBoth')}>
                冲突全部两者保留
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setBulk(preview, setDecisions, 'added', 'takeNew')}>
                新增全部导入
              </Button>
            </div>
            <Table
              columns={columns}
              rows={preview.rows}
              rowKey={(row) => row.id}
              rowHeight={44}
              height={320}
              aria-label="导入差异预览"
            />
          </div>
        )}
      </Modal>
    </section>
  );
}

function defaultResolution(classification: ImportClassification): ImportResolution {
  // 默认不覆盖本地：冲突保留本地、缺失不动、新增导入
  if (classification === 'added') return 'takeNew';
  return 'keepLocal';
}

function setBulk(
  preview: ImportPreviewModel,
  setDecisions: (update: (prev: Record<string, ImportResolution>) => Record<string, ImportResolution>) => void,
  classification: ImportClassification,
  resolution: ImportResolution,
): void {
  setDecisions((prev) => {
    const next = { ...prev };
    for (const row of preview.rows) {
      if (row.classification === classification) next[row.id] = resolution;
    }
    return next;
  });
}
