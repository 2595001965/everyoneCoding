import { Button, Input, Switch, Textarea } from '@ec/ui';

/**
 * 远程配置源编辑：名称、URL、可选公钥、启用与更新频率。
 * 公钥留空即跳过签名校验（由 @ec/ai 的 verifier 保证"填了就必须有签名"）。
 */

export interface RemoteSourceDraft {
  id?: string;
  name: string;
  url: string;
  publicKey: string;
  enabled: boolean;
  updateIntervalMin: number;
}

export const EMPTY_SOURCE_DRAFT: RemoteSourceDraft = {
  name: '',
  url: '',
  publicKey: '',
  enabled: false,
  updateIntervalMin: 1440,
};

export interface RemoteConfigEditorProps {
  draft: RemoteSourceDraft;
  isNew: boolean;
  busy?: boolean;
  error?: string | null;
  onChange(patch: Partial<RemoteSourceDraft>): void;
  onSave(): void;
  onCancel(): void;
}

export function RemoteConfigEditor({
  draft,
  isNew,
  busy = false,
  error = null,
  onChange,
  onSave,
  onCancel,
}: RemoteConfigEditorProps): JSX.Element {
  return (
    <section className="ec-ai__editor" aria-label={isNew ? '新增配置源' : '编辑配置源'}>
      <h2 className="ec-ai__section-title">{isNew ? '新增配置源' : `编辑：${draft.name}`}</h2>

      <div className="ec-ai__grid">
        <label className="ec-ai__field">
          <span>名称</span>
          <Input
            value={draft.name}
            onChange={(value) => onChange({ name: value })}
            placeholder="例如：团队共享配置"
          />
        </label>

        <label className="ec-ai__field">
          <span>更新频率（分钟）</span>
          <Input
            value={String(draft.updateIntervalMin)}
            onChange={(value) =>
              onChange({ updateIntervalMin: Number.parseInt(value, 10) || 1440 })
            }
          />
        </label>

        <label className="ec-ai__field ec-ai__field--wide">
          <span>配置地址 URL</span>
          <Input
            value={draft.url}
            onChange={(value) => onChange({ url: value })}
            placeholder="https://example.com/ai-config.json"
          />
        </label>

        <label className="ec-ai__field ec-ai__field--wide">
          <span>Ed25519 公钥（可选，PEM 或 base64）</span>
          <Textarea
            value={draft.publicKey}
            onChange={(value) => onChange({ publicKey: value })}
            placeholder="留空表示不校验签名"
          />
          <em className="ec-ai__hint">
            一旦填写，响应必须带签名字段（x-signature 或正文 signature），否则视为拉取失败。
          </em>
        </label>

        <div className="ec-ai__field">
          <span>启用</span>
          <Switch checked={draft.enabled} onChange={(checked) => onChange({ enabled: checked })} />
        </div>
      </div>

      {error ? <p className="ec-ai__error">{error}</p> : null}

      <footer className="ec-ai__editor-actions">
        <Button variant="primary" onClick={onSave} loading={busy}>
          保存
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          取消
        </Button>
      </footer>
    </section>
  );
}
