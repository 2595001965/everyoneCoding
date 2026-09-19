import { Select, Switch } from '@ec/ui';
import {
  AI_PURPOSES,
  PURPOSE_LABELS,
  resolveModelId,
  type AiPurpose,
  type Model,
  type PurposeBinding,
} from '@ec/ai';

/**
 * 用途化模型绑定（FR-MDL-05）。
 * 「全部使用默认模型」打开时六个下拉失效并统一走默认模型。
 */

export interface PurposeBindingProps {
  binding: PurposeBinding;
  models: Model[];
  onChange(next: PurposeBinding): void;
}

export function PurposeBindingPanel({
  binding,
  models,
  onChange,
}: PurposeBindingProps): JSX.Element {
  const options = models.map((model) => ({
    value: model.id,
    label: model.displayName ?? model.name,
  }));

  return (
    <section className="ec-ai__section" aria-label="用途化模型绑定">
      <header className="ec-ai__section-head">
        <div>
          <h2 className="ec-ai__section-title">用途化模型绑定</h2>
          <p className="ec-ai__hint">
            不同用途可用不同模型，例如「代码生成」用强模型、「提交信息」用廉价模型。
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
              实际生效：{modelLabel(models, resolveModelId(binding, purpose))}
            </em>
          </label>
        ))}
      </div>
    </section>
  );
}

function modelLabel(models: Model[], modelId: string | null): string {
  if (!modelId) return '未配置';
  return models.find((model) => model.id === modelId)?.name ?? modelId;
}
