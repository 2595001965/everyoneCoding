import { useMemo, useState } from 'react';

import type { ApplyPlan, ConfigDiffItem, RemoteConfigSource, RemoteFetchResult } from '@ec/ai';

import { useAiSettings } from '../ai-settings-context';
import { RemoteConfigList } from './RemoteConfigList';
import {
  RemoteConfigEditor,
  EMPTY_SOURCE_DRAFT,
  type RemoteSourceDraft,
} from './RemoteConfigEditor';
import { DiffPreview } from './DiffPreview';

/**
 * 远程配置页容器：源列表 → 拉取 → 差异预览 → 应用。
 * 所有失败路径都不抛异常，而是显示在页面里（拉取失败要能用本地缓存、不阻塞启动）。
 */

export interface UseRemoteConfigResult {
  sources: RemoteConfigSource[];
  draft: RemoteSourceDraft;
  editingId: string | null;
  selectedId: string | null;
  busy: boolean;
  error: string | null;
  message: string | null;
  diff: { items: ConfigDiffItem[]; summary: string; revision: string | null } | null;
  plan: ApplyPlan | null;
  fetchResult: RemoteFetchResult | null;
  startCreate(): void;
  startEdit(source: RemoteConfigSource): void;
  updateDraft(patch: Partial<RemoteSourceDraft>): void;
  cancelEdit(): void;
  saveDraft(): void;
  remove(source: RemoteConfigSource): void;
  toggle(id: string, enabled: boolean): void;
  fetchSource(id: string): Promise<void>;
  preview(id: string): Promise<void>;
  apply(id: string, options: { overwriteLocal: boolean; ackDefaultModel: boolean }): Promise<void>;
  ack(revision: string): void;
  closeDiff(): void;
}

export function useRemoteConfig(): UseRemoteConfigResult {
  const api = useAiSettings();
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<RemoteSourceDraft>(EMPTY_SOURCE_DRAFT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [diff, setDiff] = useState<UseRemoteConfigResult['diff']>(null);
  const [plan, setPlan] = useState<ApplyPlan | null>(null);
  const [fetchResult, setFetchResult] = useState<RemoteFetchResult | null>(null);

  // revision 是「数据已变更」信号：读取它以表明依赖意图（AI 侧为命令式 API，无订阅）
  const sources = useMemo(() => (void revision, api.listRemoteSources()), [api, revision]);
  const refresh = (): void => setRevision((value) => value + 1);

  const run = async (task: () => void | Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await task();
      refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return {
    sources,
    draft,
    editingId: draft.id ?? null,
    selectedId,
    busy,
    error,
    message,
    diff,
    plan,
    fetchResult,
    startCreate: () => setDraft({ ...EMPTY_SOURCE_DRAFT }),
    startEdit: (source) =>
      setDraft({
        id: source.id,
        name: source.name,
        url: source.url,
        publicKey: source.publicKey ?? '',
        enabled: source.enabled,
        updateIntervalMin: source.updateIntervalMin,
      }),
    updateDraft: (patch) => setDraft((current) => ({ ...current, ...patch })),
    cancelEdit: () => setDraft({ ...EMPTY_SOURCE_DRAFT }),
    saveDraft: () => {
      void run(() => {
        const payload = {
          name: draft.name,
          url: draft.url,
          publicKey: draft.publicKey.trim().length > 0 ? draft.publicKey.trim() : null,
          enabled: draft.enabled,
          updateIntervalMin: draft.updateIntervalMin,
        };
        if (draft.id) api.updateRemoteSource(draft.id, payload);
        else api.createRemoteSource(payload);
        setDraft({ ...EMPTY_SOURCE_DRAFT });
        setMessage('配置源已保存');
      });
    },
    remove: (source) => {
      void run(() => {
        api.removeRemoteSource(source.id);
        setMessage(`已删除配置源「${source.name}」`);
      });
    },
    toggle: (id, enabled) => {
      void run(() => {
        api.updateRemoteSource(id, { enabled });
      });
    },
    fetchSource: async (id) => {
      setSelectedId(id);
      await run(async () => {
        const result = await api.fetchRemoteSource(id);
        setFetchResult(result);
        setMessage(result.ok ? result.message : `拉取失败：${result.message}`);
      });
    },
    preview: async (id) => {
      setSelectedId(id);
      await run(async () => {
        const next = await api.previewRemoteSource(id);
        setDiff(next);
        setPlan(null);
      });
    },
    apply: async (id, options) => {
      await run(async () => {
        const applied = await api.applyRemoteSource(id, options);
        setPlan(applied);
        setMessage('配置已应用（本地已有的同名服务按"本地优先"保留）');
        setDiff(null);
      });
    },
    ack: (rev) => {
      void run(() => {
        if (selectedId) api.ackRemoteRevision(selectedId, rev);
        setMessage('已记录，后续不再提示该版本');
      });
    },
    closeDiff: () => {
      setDiff(null);
      setPlan(null);
    },
  };
}

export function RemoteConfigSettings(): JSX.Element {
  const state = useRemoteConfig();

  return (
    <div className="ec-ai">
      <RemoteConfigList
        sources={state.sources}
        selectedId={state.selectedId}
        busy={state.busy}
        onSelect={(source) => {
          state.startEdit(source);
          void state.preview(source.id);
        }}
        onCreate={state.startCreate}
        onRemove={state.remove}
        onToggle={state.toggle}
        onFetch={(id) => void state.fetchSource(id)}
      />

      {state.error ? <p className="ec-ai__error">{state.error}</p> : null}
      {state.message ? <p className="ec-ai__hint">{state.message}</p> : null}

      <RemoteConfigEditor
        draft={state.draft}
        isNew={state.editingId === null}
        busy={state.busy}
        error={state.error}
        onChange={state.updateDraft}
        onSave={state.saveDraft}
        onCancel={state.cancelEdit}
      />

      {state.diff ? (
        <DiffPreview
          items={state.diff.items}
          summary={state.diff.summary}
          revision={state.diff.revision}
          plan={state.plan}
          busy={state.busy}
          onApply={(options) => {
            if (state.selectedId) void state.apply(state.selectedId, options);
          }}
          onAck={state.ack}
          onClose={state.closeDiff}
        />
      ) : null}
    </div>
  );
}
