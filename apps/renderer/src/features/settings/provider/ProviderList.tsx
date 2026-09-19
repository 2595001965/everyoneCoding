import { Button, EmptyState, Switch, Tag } from '@ec/ui';
import { PROTOCOL_LABELS, type Provider } from '@ec/ai';

/**
 * Provider 列表：启用开关、排序、编辑与删除。
 *
 * 为什么不用虚拟表格：Provider 数量通常是个位数，且行内带开关与按钮；
 * 虚拟化在没有滚动度量的环境（jsdom 测试、初次渲染）里会渲染不出内容，
 * 导致行内操作不可达。这里用普通列表，保证内容始终可见、可操作。
 */

export interface ProviderListProps {
  providers: Provider[];
  selectedId?: string | null;
  busy?: boolean;
  onSelect(provider: Provider): void;
  onToggle(id: string, enabled: boolean): void;
  onMove(id: string, direction: -1 | 1): void;
  onDelete(provider: Provider): void;
  onCreate(): void;
}

export function ProviderList({
  providers,
  selectedId = null,
  busy = false,
  onSelect,
  onToggle,
  onMove,
  onDelete,
  onCreate,
}: ProviderListProps): JSX.Element {
  return (
    <section className="ec-ai__section" aria-label="模型服务列表">
      <header className="ec-ai__section-head">
        <div>
          <h2 className="ec-ai__section-title">模型服务</h2>
          <p className="ec-ai__hint">
            支持任意 OpenAI / Anthropic 兼容中转；排序决定容灾切换顺序，Key 只保存在本机密钥环。
          </p>
        </div>
        <Button variant="primary" onClick={onCreate} disabled={busy}>
          新增服务
        </Button>
      </header>

      {providers.length === 0 ? (
        <EmptyState
          title="还没有配置模型服务"
          description="新增一个 OpenAI 或 Anthropic 兼容中转后，需求生成、代码生成等能力即可使用。"
          action={
            <Button variant="primary" onClick={onCreate}>
              新增服务
            </Button>
          }
        />
      ) : (
        <ul className="ec-ai__sources">
          {providers.map((row, index) => (
            <li
              key={row.id}
              className={
                row.id === selectedId ? 'ec-ai__source ec-ai__source--active' : 'ec-ai__source'
              }
            >
              <button type="button" className="ec-ai__source-main" onClick={() => onSelect(row)}>
                <span className="ec-ai__name">
                  {row.name}
                  <Tag color="neutral">{PROTOCOL_LABELS[row.protocol]}</Tag>
                  {row.keyRef ? (
                    <Tag color="neutral">已配置 Key</Tag>
                  ) : (
                    <Tag color="warning">未配置 Key</Tag>
                  )}
                </span>
                <code className="ec-ai__url">{row.baseUrl}</code>
              </button>

              <span className="ec-ai__row-actions">
                <Switch
                  checked={row.enabled}
                  onChange={(checked) => onToggle(row.id, checked)}
                  label="启用"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onMove(row.id, -1)}
                  disabled={index === 0}
                >
                  上移
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onMove(row.id, 1)}
                  disabled={index === providers.length - 1}
                >
                  下移
                </Button>
                <Button size="sm" variant="secondary" onClick={() => onDelete(row)}>
                  删除
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="ec-ai__hint">未配置 Key 的服务不会被调度。</p>
    </section>
  );
}
