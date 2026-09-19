import { useState } from 'react';

import { Button, Select, Tag } from '@ec/ui';

import type { DiffViewModel, FilePreview, WriteMode, WritePlan, WriteResult } from '@ec/ai';

/**
 * ApplyBar：应用条（T4-05 要点 1、4、5）。
 *
 * 提供三件事：
 * 1. **三种写入模式的选择**：新建 / 增量补丁 / 预览后应用 —— 注意三者都是
 *    "AI 产出的内容如何落地"，**没有"手动编辑"模式**（D-04）；
 * 2. **选择性应用**：按文件（或按块）选择后只应用选中的部分；
 * 3. **结果回显**：应用成功列出写入文件，失败时展示错误与回滚情况；也可发起「要求 AI 重改」。
 */

export interface ApplyBarProps {
  plan: WritePlan;
  model: DiffViewModel;
  /** 应用执行（由外壳的 WritePipeline 完成，事务性） */
  onApply: (plan: WritePlan, mode: WriteMode) => Promise<WriteResult>;
  onRequestRework?: ((paths: readonly string[]) => void) | undefined;
  /** 模式切换（调用方据此重新 plan） */
  onModeChange?: ((mode: WriteMode) => void) | undefined;
}

const MODE_OPTIONS = [
  { value: 'create', label: '新建文件' },
  { value: 'patch', label: '增量补丁' },
  { value: 'preview', label: '预览后应用' },
];

export function ApplyBar({
  plan,
  model,
  onApply,
  onRequestRework,
  onModeChange,
}: ApplyBarProps): JSX.Element {
  const [mode, setMode] = useState<WriteMode>(plan.mode);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WriteResult | null>(null);

  const selectedPaths = model.files.filter((file) => file.selected).map((file) => file.path);
  const blocked = model.files.filter((file) => file.blocked);

  const selectable = model.files.length;
  const actions = {
    create: '新建',
    patch: '修改',
    delete: '删除',
  } satisfies Record<FilePreview['action'], string>;

  return (
    <section className="ec-apply-bar" aria-label="代码应用条" data-plan-id={plan.id}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Select
          size="sm"
          aria-label="写入模式"
          value={mode}
          options={MODE_OPTIONS}
          onChange={(value) => {
            const next = value as WriteMode;
            setMode(next);
            onModeChange?.(next);
          }}
        />
        <Tag color="info">{`${selectedPaths.length}/${selectable} 个文件已选中`}</Tag>
        {blocked.length > 0 && <Tag color="danger">{`${blocked.length} 个文件被拒绝`}</Tag>}
        <span style={{ flex: 1 }} />
        <Button
          variant="primary"
          size="sm"
          loading={running}
          disabled={selectedPaths.length === 0}
          aria-label="应用变更"
          onClick={() => {
            setRunning(true);
            void onApply(plan, mode)
              .then((outcome) => setResult(outcome))
              .finally(() => setRunning(false));
          }}
        >
          应用变更
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="要求 AI 重改"
          disabled={onRequestRework === undefined || selectedPaths.length === 0}
          onClick={() => onRequestRework?.(selectedPaths)}
        >
          要求 AI 重改
        </Button>
      </header>

      <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ec-text-secondary, #64748b)' }}>
        {selectedPaths.length > 0
          ? `将应用：${selectedPaths.map((path) => `${actions[model.files.find((file) => file.path === path)?.action ?? 'patch']} ${path}`).join('；')}`
          : '未选择任何文件；请在上方勾选要应用的文件。'}
      </p>

      {blocked.length > 0 && (
        <ul
          role="list"
          aria-label="被拒绝的文件"
          style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: '#b91c1c' }}
        >
          {blocked.map((file) => (
            <li key={file.path}>{`${file.path}：${file.blockReason ?? '冲突'}`}</li>
          ))}
        </ul>
      )}

      {result !== null && (
        <div
          role="status"
          data-testid="ec-apply-result"
          data-apply-ok={result.ok ? 'true' : 'false'}
          style={{ marginTop: 8, fontSize: 12 }}
        >
          {result.ok ? (
            <span style={{ color: '#166534' }}>
              {`已应用 ${result.applied.length} 个文件${result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个` : ''}。`}
            </span>
          ) : (
            <span style={{ color: '#b91c1c' }}>
              {`应用失败：${result.error ?? '未知错误'}${result.rolledBack.length > 0 ? `（已回滚 ${result.rolledBack.length} 个文件，未留中间态）` : ''}`}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
