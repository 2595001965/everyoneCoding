import { Button, EmptyState, Tag } from '@ec/ui';
import type { RemoteConfigSource } from '@ec/ai';

/**
 * 远程配置源列表。
 *
 * 硬约束：这里管理的是**用户自己填的 URL**，不依赖任何平台服务端（D-02 / D-06），
 * 因此未配置任何源时整块能力默认关闭。
 */

export interface RemoteConfigListProps {
  sources: RemoteConfigSource[];
  selectedId?: string | null;
  busy?: boolean;
  onSelect(source: RemoteConfigSource): void;
  onCreate(): void;
  onRemove(source: RemoteConfigSource): void;
  onToggle(id: string, enabled: boolean): void;
  onFetch(id: string): void;
}

const STATUS_LABEL: Record<
  string,
  { text: string; color: 'neutral' | 'success' | 'danger' | 'warning' }
> = {
  idle: { text: '未拉取', color: 'neutral' },
  success: { text: '拉取成功', color: 'success' },
  unreachable: { text: '不可达', color: 'danger' },
  signature_failed: { text: '签名校验失败', color: 'danger' },
  invalid: { text: '格式非法', color: 'warning' },
};

export function RemoteConfigList({
  sources,
  selectedId = null,
  busy = false,
  onSelect,
  onCreate,
  onRemove,
  onToggle,
  onFetch,
}: RemoteConfigListProps): JSX.Element {
  return (
    <section className="ec-ai__section" aria-label="远程配置源">
      <header className="ec-ai__section-head">
        <div>
          <h2 className="ec-ai__section-title">远程配置源</h2>
          <p className="ec-ai__hint">
            直连你填写的 URL
            拉取配置（不经平台服务端）；未配置任何源时该能力关闭，拉取失败会自动回退本地缓存。
          </p>
        </div>
        <Button variant="primary" onClick={onCreate} disabled={busy}>
          新增配置源
        </Button>
      </header>

      {sources.length === 0 ? (
        <EmptyState
          title="还没有远程配置源"
          description="如果你或团队维护了一份共享配置 JSON，可以在这里登记地址；不配置也完全不影响使用。"
          action={
            <Button variant="primary" onClick={onCreate}>
              新增配置源
            </Button>
          }
        />
      ) : (
        <ul className="ec-ai__sources">
          {sources.map((source) => {
            const status =
              STATUS_LABEL[source.lastStatus ?? 'idle'] ?? STATUS_LABEL['idle' as const];
            return (
              <li
                key={source.id}
                className={
                  source.id === selectedId ? 'ec-ai__source ec-ai__source--active' : 'ec-ai__source'
                }
              >
                <button
                  type="button"
                  className="ec-ai__source-main"
                  onClick={() => onSelect(source)}
                >
                  <span className="ec-ai__name">
                    {source.name}
                    <Tag color={source.enabled ? 'success' : 'neutral'}>
                      {source.enabled ? '启用' : '停用'}
                    </Tag>
                    <Tag color={status?.color ?? 'neutral'}>{status?.text ?? '未知'}</Tag>
                  </span>
                  <code className="ec-ai__url">{source.url}</code>
                  <span className="ec-ai__hint">
                    {source.lastFetchAt
                      ? `上次拉取：${new Date(source.lastFetchAt).toLocaleString()}`
                      : '尚未拉取'}
                    {source.lastError ? ` · ${source.lastError}` : ''}
                    {source.publicKey ? ' · 已配置公钥' : ' · 未校验签名'}
                  </span>
                </button>
                <span className="ec-ai__row-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onFetch(source.id)}
                    disabled={busy}
                  >
                    立即拉取
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onToggle(source.id, !source.enabled)}
                    disabled={busy}
                  >
                    {source.enabled ? '停用' : '启用'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRemove(source)}
                    disabled={busy}
                  >
                    删除
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
