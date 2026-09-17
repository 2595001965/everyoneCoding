import { Button, Checkbox, Input, Select, Switch, Textarea } from '@ec/ui';
import { PROTOCOL_LABELS } from '@ec/ai';

import type { ProviderDraft } from './useProviderSettings';
import { ConnectionTest, type TestState } from './ConnectionTest';
import type { ConnectionTestResult } from '@ec/ai';

/**
 * Provider 编辑表单。
 *
 * 安全约定：
 * - Key 输入框为密码态，保存后不回填（返回值里只有引用）
 * - 自定义请求头与手填模型用文本域，出错时给出可定位的提示
 */

export interface ProviderEditorProps {
  draft: ProviderDraft;
  isNew: boolean;
  busy?: boolean;
  error?: string | null;
  testState: TestState;
  testResult: ConnectionTestResult | null;
  onChange(patch: Partial<ProviderDraft>): void;
  onSave(): void;
  onCancel(): void;
  onTest(): void;
}

const PROTOCOL_OPTIONS = [
  { value: 'openai', label: PROTOCOL_LABELS.openai },
  { value: 'anthropic', label: PROTOCOL_LABELS.anthropic },
];

export function ProviderEditor({
  draft,
  isNew,
  busy = false,
  error = null,
  testState,
  testResult,
  onChange,
  onSave,
  onCancel,
  onTest,
}: ProviderEditorProps): JSX.Element {
  return (
    <section className="ec-ai__editor" aria-label={isNew ? '新增模型服务' : '编辑模型服务'}>
      <h2 className="ec-ai__section-title">{isNew ? '新增模型服务' : `编辑：${draft.name}`}</h2>

      <div className="ec-ai__grid">
        <label className="ec-ai__field">
          <span>名称</span>
          <Input
            value={draft.name}
            onChange={(value) => onChange({ name: value })}
            placeholder="例如：团队中转"
          />
        </label>

        <label className="ec-ai__field">
          <span>协议</span>
          <Select
            options={PROTOCOL_OPTIONS}
            value={draft.protocol}
            onChange={(value) => onChange({ protocol: value === 'anthropic' ? 'anthropic' : 'openai' })}
          />
        </label>

        <label className="ec-ai__field ec-ai__field--wide">
          <span>Base URL</span>
          <Input
            value={draft.baseUrl}
            onChange={(value) => onChange({ baseUrl: value })}
            placeholder="https://api.openai.com/v1 或 https://your-relay.com/v1"
          />
          <em className="ec-ai__hint">带不带 /v1 都能正确拼接；必须是 http/https 地址。</em>
        </label>

        <label className="ec-ai__field ec-ai__field--wide">
          <span>API Key</span>
          <Input
            type="password"
            inputMode="text"
            autoComplete="new-password"
            value={draft.apiKey}
            onChange={(value) => onChange({ apiKey: value })}
            placeholder={draft.id ? '留空表示不修改' : 'sk-...'}
          />
          <em className="ec-ai__hint">密钥只写入本机密钥环（DPAPI），数据库与日志中均为引用。</em>
        </label>

        <label className="ec-ai__field">
          <span>超时（毫秒）</span>
          <Input
            value={String(draft.timeoutMs)}
            onChange={(value) => onChange({ timeoutMs: Number.parseInt(value, 10) || 30_000 })}
          />
          <em className="ec-ai__hint">1 秒 ~ 600 秒</em>
        </label>

        <div className="ec-ai__field">
          <span>能力</span>
          <div className="ec-ai__checks">
            <Checkbox
              checked={draft.supportsStream}
              onChange={(checked) => onChange({ supportsStream: checked })}
              label="流式"
            />
            <Checkbox
              checked={draft.supportsTools}
              onChange={(checked) => onChange({ supportsTools: checked })}
              label="工具调用"
            />
            <Checkbox
              checked={draft.supportsVision}
              onChange={(checked) => onChange({ supportsVision: checked })}
              label="视觉"
            />
          </div>
        </div>

        <div className="ec-ai__field">
          <span>启用</span>
          <Switch checked={draft.enabled} onChange={(checked) => onChange({ enabled: checked })} />
        </div>

        <label className="ec-ai__field ec-ai__field--wide">
          <span>自定义请求头（JSON）</span>
          <Textarea
            value={draft.headersText}
            onChange={(value) => onChange({ headersText: value })}
            placeholder={'{\n  "HTTP-Referer": "https://example.com"\n}'}
          />
        </label>

        <label className="ec-ai__field ec-ai__field--wide">
          <span>手动填写模型（每行一个）</span>
          <Textarea
            value={draft.manualModelsText}
            onChange={(value) => onChange({ manualModelsText: value })}
            placeholder={'gpt-4o\ngpt-4o-mini'}
          />
          <em className="ec-ai__hint">当中转不提供 /models 时使用这份列表。</em>
        </label>
      </div>

      {error ? <p className="ec-ai__error">{error}</p> : null}

      <ConnectionTest state={testState} result={testResult} onTest={onTest} disabled={busy || draft.baseUrl.trim().length === 0} />

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
