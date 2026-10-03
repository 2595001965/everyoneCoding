/**
 * 导出向导（T8-02 / FR-PKG-12）。
 *
 * 组合范围选择、加密口令、脱敏开关与进度展示；调用 `usePackageApi().exportPackage`。
 * 全程结构化回显（进度 / 计数 / 错误清单），不依赖命令行。
 *
 * - 未注入端口：显示装配引导而非崩溃；
 * - 加密：勾选后要求输入两遍一致口令；
 * - 脱敏开关关闭：弹 @ec/ui Modal 二次确认（脱敏默认开启为硬约束）。
 *
 * 仅从 './package-api' 导入类型，绝不 import '@ec/package-kit'。
 */

import * as React from 'react';
import { Button, Checkbox, Modal, Select } from '@ec/ui';

import { usePackageApi } from './package-api';
import type {
  ExportPlanPreset,
  ExportJobRequest,
  ExportJobResult,
  ExportProgressSnapshot,
  ExportSelection,
} from './package-api';
import { ScopeSelector } from './ScopeSelector';
import { ExportProgress } from './ExportProgress';

const DEFAULT_SELECTION: ExportSelection = {
  scope: 'all',
  projectIds: [],
  content: {
    memory: { longterm: true, project: true, feature: true, page: true, issue: true },
    documents: true,
    code: true,
    pipeline: true,
    anchors: true,
    registry: true,
    attachments: true,
  },
};

export interface ExportWizardProps {
  /** 可选：可用项目列表（scope=selected 时多选） */
  projects?: ReadonlyArray<{ id: string; name: string }>;
  /** 可选：已存方案（由外壳注入） */
  presets?: ReadonlyArray<{ name: string }>;
  onSavedPreset?: (name: string) => void;
  onDeletedPreset?: (name: string) => void;
  onLoadedPreset?: (name: string) => void;
}

export function ExportWizard(props: ExportWizardProps): React.ReactElement {
  const api = usePackageApi();
  const [archiveKind, setArchiveKind] = React.useState<'source' | 'backup'>('source');
  const [sourceProjectId, setSourceProjectId] = React.useState(props.projects?.[0]?.id ?? '');
  const [savedPresets, setSavedPresets] = React.useState<ExportPlanPreset[]>([]);
  React.useEffect(() => {
    if (api)
      void api
        .listExportPresets()
        .then(setSavedPresets)
        .catch(() => {});
  }, [api]);
  React.useEffect(() => {
    if (!sourceProjectId && props.projects?.[0]) setSourceProjectId(props.projects[0].id);
  }, [props.projects, sourceProjectId]);
  const [selection, setSelection] = React.useState<ExportSelection>(DEFAULT_SELECTION);
  const [useDefaultExcludes, setUseDefaultExcludes] = React.useState(true);
  const [redact, setRedact] = React.useState(true);
  const [redactConfirmOpen, setRedactConfirmOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState<ExportProgressSnapshot | null>(null);
  const [result, setResult] = React.useState<ExportJobResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  if (api === null) {
    return (
      <div className="ec-export-wizard" data-testid="export-wizard">
        <div className="ec-export-guidance" data-testid="export-guidance">
          尚未装配归档端口（PackageApi）。请在 Node 侧外壳中通过 globalThis.__EC_PACKAGE__
          注入后再打开导出向导。
        </div>
      </div>
    );
  }

  const canExport =
    !exporting &&
    (archiveKind === 'source'
      ? sourceProjectId.length > 0
      : selection.scope === 'all' || selection.projectIds.length > 0);

  const handleRedactChange = (value: boolean): void => {
    if (value) {
      setRedact(true);
      return;
    }
    // 关闭脱敏：二次确认（硬约束）
    setRedactConfirmOpen(true);
  };

  const handleExport = async (): Promise<void> => {
    if (!api || !canExport) return;
    const outputPath = await api.pickExportPath(
      archiveKind === 'source' ? 'source.zip' : 'everyonecoding-backup.zip',
    );
    if (outputPath === null) return;
    setExporting(true);
    setResult(null);
    setError(null);
    setSnapshot(null);
    try {
      const request: ExportJobRequest = {
        archiveFormat: 'standard-zip',
        archiveKind,
        outputPath,
        selection:
          archiveKind === 'source'
            ? {
                scope: 'project',
                projectIds: [sourceProjectId],
                content: {
                  memory: {
                    longterm: false,
                    project: false,
                    feature: false,
                    page: false,
                    issue: false,
                  },
                  documents: false,
                  code: true,
                  pipeline: false,
                  anchors: false,
                  registry: false,
                  attachments: false,
                },
              }
            : selection,
        useDefaultExcludes,
        redact,
        onProgress: (s: ExportProgressSnapshot) => setSnapshot(s),
      };
      const res = await api.exportPackage(request);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="ec-export-wizard" data-testid="export-wizard">
      <label>
        导出类型
        <Select
          aria-label="导出类型"
          options={[
            { value: 'source', label: '源码 ZIP（无产品元数据）' },
            { value: 'backup', label: '完整数据备份 ZIP（用于恢复本地数据）' },
          ]}
          value={archiveKind}
          onChange={(value) => setArchiveKind(value as 'source' | 'backup')}
        />
      </label>
      {archiveKind === 'source' ? (
        <label>
          源码项目
          <Select
            aria-label="源码项目"
            options={(props.projects ?? []).map((project) => ({
              value: project.id,
              label: project.name,
            }))}
            value={sourceProjectId}
            onChange={setSourceProjectId}
          />
          <p>ZIP 解压后的根目录直接是源码，可用普通打开文件夹/ZIP 接入。</p>
        </label>
      ) : (
        <ScopeSelector
          selection={selection}
          projects={props.projects ?? []}
          presets={savedPresets}
          useDefaultExcludes={useDefaultExcludes}
          onChange={setSelection}
          onToggleDefaultExcludes={setUseDefaultExcludes}
          onSavePreset={(name) => {
            void api
              .saveExportPreset({
                name,
                selection,
                useDefaultExcludes,
                redact,
                savedAt: Date.now(),
              })
              .then(() => api.listExportPresets())
              .then(setSavedPresets);
            props.onSavedPreset?.(name);
          }}
          onLoadPreset={(name) => {
            const preset = savedPresets.find((p) => p.name === name);
            if (preset) {
              setSelection(preset.selection);
              setUseDefaultExcludes(preset.useDefaultExcludes);
              setRedact(preset.redact);
            }
            props.onLoadedPreset?.(name);
          }}
          onDeletePreset={(name) => {
            void api
              .deleteExportPreset(name)
              .then(() => api.listExportPresets())
              .then(setSavedPresets);
            props.onDeletedPreset?.(name);
          }}
        />
      )}

      <section className="ec-export-wizard__security">
        <h3>安全选项</h3>
        <Checkbox
          label="导出时脱敏（默认开启，关闭需二次确认）"
          checked={redact}
          onChange={handleRedactChange}
        />
      </section>

      <div className="ec-export-wizard__actions">
        <Button
          data-testid="export-start"
          disabled={!canExport}
          onClick={() => void handleExport()}
        >
          {exporting ? '导出中…' : '开始导出'}
        </Button>
      </div>

      {snapshot !== null && <ExportProgress snapshot={snapshot} />}
      {error !== null && (
        <div className="ec-export-wizard__error" data-testid="export-error">
          {error}
        </div>
      )}
      {result !== null && (
        <div className="ec-export-wizard__result" data-testid="export-result">
          <div>导出完成</div>
          <div>输出路径：{result.outputPath}</div>
          <div>包大小：{result.archiveSizeBytes} 字节</div>
          <div>耗时：{result.durationMs} ms</div>
          <div>
            格式：普通 ZIP（{archiveKind === 'source' ? '无产品元数据' : '含可读恢复信息'}）
          </div>
          <div>脱敏：{result.redacted ? '是' : '否'}</div>
        </div>
      )}

      <Modal open={redactConfirmOpen} title="确认关闭脱敏？" footer={null}>
        <div data-testid="redact-confirm">
          <p>关闭脱敏后，密钥和连接串将以明文写入 ZIP，存在泄露风险。确认关闭吗？</p>
          <Button
            data-testid="confirm-disable-redact"
            onClick={() => {
              setRedact(false);
              setRedactConfirmOpen(false);
            }}
          >
            确认关闭
          </Button>
          <Button data-testid="cancel-disable-redact" onClick={() => setRedactConfirmOpen(false)}>
            再想想
          </Button>
        </div>
      </Modal>
    </div>
  );
}
