import { useCallback, useState } from 'react';

import type { ConnectionTestResult, Model, Provider } from '@ec/ai';

import { ProviderList } from './provider/ProviderList';
import { ProviderEditor } from './provider/ProviderEditor';
import { ModelCapabilityTable } from './provider/ModelCapabilityTable';
import { PurposeBindingPanel } from './provider/PurposeBinding';
import { GenerationTest } from './provider/GenerationTest';
import { useProviderSettings } from './provider/useProviderSettings';
import type { TestState } from './provider/ConnectionTest';

/**
 * 模型服务设置页容器（T1-06）。
 *
 * 结构：列表 → 编辑（含连接测试）→ 能力矩阵 → 用途绑定 → 用量概览。
 * Key 掩码由后端保证（UI 侧保存后不回填明文）。
 */

export function ProviderSettings(): JSX.Element {
  const state = useProviderSettings();
  const [testState, setTestState] = useState<TestState>('idle');
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Provider | null>(null);

  const { testDraft, draft } = state;
  const runTest = useCallback(async (): Promise<void> => {
    if (!draft.baseUrl.trim()) return;
    setTestState('running');
    try {
      const result = await testDraft();
      setTestResult(result);
      setTestState(result.ok ? 'ok' : 'failed');
    } catch (error) {
      setTestResult(null);
      setTestState('failed');
      void error;
    }
  }, [testDraft, draft]);

  const isNew = state.editingId === null;

  return (
    <div className="ec-ai">
      <ProviderList
        providers={state.providers}
        selectedId={state.editingId}
        busy={state.busy}
        onSelect={(provider) => {
          state.startEdit(provider);
          setTestState('idle');
          setTestResult(null);
        }}
        onToggle={state.toggleEnabled}
        onMove={state.move}
        onDelete={(provider) => setConfirmDelete(provider)}
        onCreate={() => {
          state.startCreate();
          setTestState('idle');
          setTestResult(null);
        }}
      />

      {state.error ? <p className="ec-ai__error">{state.error}</p> : null}

      <ProviderEditor
        draft={state.draft}
        isNew={isNew}
        busy={state.busy}
        error={state.error}
        testState={testState}
        testResult={testResult}
        onChange={state.updateDraft}
        onSave={() => void state.saveDraft()}
        onCancel={state.cancelEdit}
        onTest={() => void runTest()}
      />

      {!isNew ? (
        <ModelCapabilityTable
          models={state.models}
          busy={state.busy}
          onPatch={state.patchCapability}
          onAdd={(name) => state.addModel(state.editingId as string, name)}
          onRefresh={() => void state.refreshModelList(state.editingId as string)}
        />
      ) : null}

      <PurposeBindingPanel binding={state.binding} models={state.allModels as Model[]} onChange={state.setBinding} />

      {state.providers.length > 0 ? <GenerationTest /> : null}

      <section className="ec-ai__section" aria-label="本月用量">
        <h2 className="ec-ai__section-title">本月用量</h2>
        <p className="ec-ai__hint">
          请求 {state.usage.requests} 次 · 令牌 {state.usage.totalTokens.toLocaleString()} · 费用 $
          {state.usage.cost.toFixed(4)}
          {state.usage.complete ? '' : '（部分模型未填单价，费用为下限）'}
        </p>
      </section>

      {confirmDelete ? (
        <div className="ec-ai__notice" role="alertdialog" aria-label="确认删除">
          <strong>确认删除「{confirmDelete.name}」？</strong>
          <p className="ec-ai__hint">该服务的模型列表与已保存的 Key 会一并移除，此操作不可撤销。</p>
          <span className="ec-ai__row-actions">
            <button
              type="button"
              className="ec-ai__btn-danger"
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                void state.removeProvider(target.id);
              }}
            >
              确认删除
            </button>
            <button type="button" className="ec-ai__btn-ghost" onClick={() => setConfirmDelete(null)}>
              取消
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
