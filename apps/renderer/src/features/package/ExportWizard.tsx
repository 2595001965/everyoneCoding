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
import { Button, Checkbox, Input, Modal } from '@ec/ui';

import { usePackageApi } from './package-api';
import type { ExportJobRequest, ExportJobResult, ExportProgressSnapshot, ExportSelection } from './package-api';
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
  const [selection, setSelection] = React.useState<ExportSelection>(DEFAULT_SELECTION);
  const [useDefaultExcludes, setUseDefaultExcludes] = React.useState(true);
  const [redact, setRedact] = React.useState(true);
  const [encryptEnabled, setEncryptEnabled] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [redactConfirmOpen, setRedactConfirmOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState<ExportProgressSnapshot | null>(null);
  const [result, setResult] = React.useState<ExportJobResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  if (api === null) {
    return (
      <div className="ec-export-wizard" data-testid="export-wizard">
        <div className="ec-export-guidance" data-testid="export-guidance">
          尚未装配归档端口（PackageApi）。请在 Node 侧外壳中通过 globalThis.__EC_PACKAGE__ 注入后再打开导出向导。
        </div>
      </div>
    );
  }

  const passwordOk = !encryptEnabled || (password.length > 0 && password === confirmPassword);
  const canExport = !exporting && passwordOk;

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
    const outputPath = await api.pickExportPath('everyonecoding.ecpkg');
    if (outputPath === null) return;
    setExporting(true);
    setResult(null);
    setError(null);
    setSnapshot(null);
    try {
      const request: ExportJobRequest = {
        outputPath,
        selection,
        useDefaultExcludes,
        redact,
        onProgress: (s: ExportProgressSnapshot) => setSnapshot(s),
      };
      if (encryptEnabled && password.length > 0) request.password = password;
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
      <ScopeSelector
        selection={selection}
        projects={props.projects ?? []}
        presets={(props.presets ?? []).map((p) => ({ name: p.name, selection: DEFAULT_SELECTION, useDefaultExcludes: true, redact: true, savedAt: 0 }))}
        useDefaultExcludes={useDefaultExcludes}
        onChange={setSelection}
        onToggleDefaultExcludes={setUseDefaultExcludes}
        onSavePreset={(name) => props.onSavedPreset?.(name)}
        onLoadPreset={(name) => props.onLoadedPreset?.(name)}
        onDeletePreset={(name) => props.onDeletedPreset?.(name)}
      />

      <section className="ec-export-wizard__security">
        <h3>安全选项</h3>
        <Checkbox label="加密导出（需设置口令）" checked={encryptEnabled} onChange={setEncryptEnabled} />
        {encryptEnabled && (
          <div className="ec-export-wizard__password" data-testid="password-fields">
            <Input
              aria-label="导出口令"
              type="password"
              placeholder="导出口令"
              value={password}
              onChange={setPassword}
            />
            <Input
              aria-label="确认口令"
              type="password"
              placeholder="再次输入口令"
              value={confirmPassword}
              onChange={setConfirmPassword}
            />
            {!passwordOk && <span className="ec-export-wizard__hint">两次口令不一致</span>}
          </div>
        )}
        <Checkbox label="导出时脱敏（默认开启，关闭需二次确认）" checked={redact} onChange={handleRedactChange} />
      </section>

      <div className="ec-export-wizard__actions">
        <Button data-testid="export-start" disabled={!canExport} onClick={() => void handleExport()}>
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
          <div>加密：{result.encrypted ? '是' : '否'}</div>
          <div>脱敏：{result.redacted ? '是' : '否'}</div>
        </div>
      )}

      <Modal open={redactConfirmOpen} title="确认关闭脱敏？" footer={null}>
        <div data-testid="redact-confirm">
          <p>关闭脱敏后，密钥、连接串等敏感信息将以明文写入 .ecpkg，存在泄露风险。确认关闭吗？</p>
          <Button data-testid="confirm-disable-redact" onClick={() => { setRedact(false); setRedactConfirmOpen(false); }}>
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
