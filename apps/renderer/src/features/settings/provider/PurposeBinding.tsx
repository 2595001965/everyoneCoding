import { Select, Switch } from '@ec/ui';
import {
  AI_PURPOSES,
  PURPOSE_LABELS,
  resolveModelId,
  type AiPurpose,
  type Model,
  type Provider,
  type PurposeBinding,
} from '@ec/ai';

/**
 * 用途化模型绑定（FR-MDL-05，V2-MDL-03）。
 * 「全部使用默认模型」打开时六个下拉失效并统一走默认模型。
 *
 * 路由身份（V2-MDL-02）：同一模型名可存在于多个 Provider，选项必须显示
 * 「Provider / Model」完整路由；绑定值指向的模型被删除后如实标注失效，
 * 不冒充仍绑定在别的 Provider 的同名模型上。
 */

export interface PurposeBindingProps {
  binding: PurposeBinding;
  models: Model[];
  providers: Provider[];
  onChange(next: PurposeBinding): void;
}

export function PurposeBindingPanel({
  binding,
  models,
  providers,
  onChange,
}: PurposeBindingProps): JSX.Element {
  // 按「Provider 顺序 → 模型名」排列，让同一服务的模型在列表中相邻
  const providerOrder = new Map(providers.map((provider, index) => [provider.id, index]));
  const ordered = [...models].sort((a, b) => {
    const pa = providerOrder.get(a.providerId) ?? Number.MAX_SAFE_INTEGER;
    const pb = providerOrder.get(b.providerId) ?? Number.MAX_SAFE_INTEGER;
    return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
  });
  const options = ordered.map((model) => ({
    value: model.id,
    label: routeLabel(providers, model),
  }));

  return (
    <section className="ec-ai__section" aria-label="用途化模型绑定">
      <header className="ec-ai__section-head">
        <div>
          <h2 className="ec-ai__section-title">用途化模型绑定</h2>
          <p className="ec-ai__hint">
            不同用途可用不同模型，例如「代码生成」用强模型、「提交信息」用廉价模型。
            同名模型可能来自不同服务，选择时认准「服务 / 模型」完整路由。
          </p>
        </div>
        <Switch
          checked={binding.useDefaultForAll}
          onChange={(checked) => onChange({ ...binding, useDefaultForAll: checked })}
          label="全部使用默认模型"
        />
      </header>

      <div className="ec-ai__grid">
        <label className="ec-ai__field">
          <span>默认模型</span>
          <Select
            options={options}
            value={binding.defaultModelId ?? ''}
            placeholder="未选择"
            onChange={(value) =>
              onChange({ ...binding, defaultModelId: value.length > 0 ? value : null })
            }
          />
          <em className="ec-ai__hint">{bindingHint(providers, models, binding.defaultModelId)}</em>
        </label>

        {AI_PURPOSES.map((purpose: AiPurpose) => (
          <label key={purpose} className="ec-ai__field">
            <span>{PURPOSE_LABELS[purpose]}</span>
            <Select
              options={options}
              value={binding.bindings[purpose] ?? ''}
              placeholder="跟随默认模型"
              disabled={binding.useDefaultForAll}
              clearable
              onChange={(value) => {
                const bindings = { ...binding.bindings };
                if (value.length === 0) delete bindings[purpose];
                else bindings[purpose] = value;
                onChange({ ...binding, bindings });
              }}
            />
            <em className="ec-ai__hint">
              实际生效：{bindingHint(providers, models, resolveModelId(binding, purpose))}
            </em>
          </label>
        ))}
      </div>
    </section>
  );
}

/** 完整路由显示：`服务名 / 模型名`（V2-MDL-03），不裸显模型 ID */
export function routeLabel(providers: Provider[], model: Model): string {
  const provider = providers.find((item) => item.id === model.providerId);
  const modelName = model.displayName && model.displayName.trim() ? model.displayName : model.name;
  return provider ? `${provider.name} / ${modelName}` : modelName;
}

/** 绑定值 → 展示文本；引用不存在的模型时如实报失效，不猜测替代路由 */
function bindingHint(providers: Provider[], models: Model[], modelId: string | null): string {
  if (!modelId) return '未配置';
  const model = models.find((item) => item.id === modelId);
  if (!model) return '已失效（原模型已删除，请重新选择）';
  return routeLabel(providers, model);
}
