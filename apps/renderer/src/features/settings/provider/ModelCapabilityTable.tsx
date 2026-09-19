import { useState } from 'react';

import { Button, Checkbox, Input, Tag } from '@ec/ui';
import type { CapabilityPatch, Model } from '@ec/ai';

/**
 * 模型能力矩阵：上下文长度、工具、视觉、单价均可就地编辑。
 *
 * 人工修正过的模型会打上标记，远程拉取不会覆盖（FR-MDL-04）。
 * 同样不使用虚拟表格：单元格内是可编辑控件，虚拟化会让未进入窗口的行无法编辑。
 */

export interface ModelCapabilityTableProps {
  models: Model[];
  onPatch(modelId: string, patch: CapabilityPatch): void;
  onAdd(name: string): void;
  onRefresh?(): void;
  busy?: boolean;
}

export function ModelCapabilityTable({
  models,
  onPatch,
  onAdd,
  onRefresh,
  busy = false,
}: ModelCapabilityTableProps): JSX.Element {
  return (
    <section className="ec-ai__section" aria-label="模型能力矩阵">
      <header className="ec-ai__section-head">
        <div>
          <h2 className="ec-ai__section-title">模型能力矩阵</h2>
          <p className="ec-ai__hint">单价用于费用统计；留空表示未知，统计时显示「—」而不是 0。</p>
        </div>
        <span className="ec-ai__row-actions">
          <ManualModelInput onAdd={onAdd} disabled={busy} />
          {onRefresh ? (
            <Button size="sm" variant="secondary" onClick={onRefresh} disabled={busy}>
              拉取远端模型
            </Button>
          ) : null}
        </span>
      </header>

      {models.length === 0 ? (
        <p className="ec-ai__hint">暂无模型，可先手动添加或点击「拉取远端模型」。</p>
      ) : (
        <div className="ec-ai__table-scroll">
          <table className="ec-ai__table">
            <thead>
              <tr>
                <th scope="col">模型</th>
                <th scope="col">上下文长度</th>
                <th scope="col">工具</th>
                <th scope="col">视觉</th>
                <th scope="col">输入单价 $/M</th>
                <th scope="col">输出单价 $/M</th>
              </tr>
            </thead>
            <tbody>
              {models.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <span className="ec-ai__name">
                      {row.displayName ?? row.name}
                      {row.capability.manualOverride ? <Tag color="info">人工修正</Tag> : null}
                    </span>
                  </th>
                  <td>
                    <Input
                      value={
                        row.capability.contextWindow === null
                          ? ''
                          : String(row.capability.contextWindow)
                      }
                      onChange={(value) =>
                        onPatch(row.id, {
                          contextWindow:
                            value.trim().length === 0 ? null : Number.parseInt(value, 10) || null,
                        })
                      }
                    />
                  </td>
                  <td>
                    <Checkbox
                      checked={row.capability.supportsTools}
                      onChange={(checked) => onPatch(row.id, { supportsTools: checked })}
                      label="工具"
                    />
                  </td>
                  <td>
                    <Checkbox
                      checked={row.capability.supportsVision}
                      onChange={(checked) => onPatch(row.id, { supportsVision: checked })}
                      label="视觉"
                    />
                  </td>
                  <td>
                    <Input
                      value={
                        row.capability.inputPricePerMTok === null
                          ? ''
                          : String(row.capability.inputPricePerMTok)
                      }
                      onChange={(value) =>
                        onPatch(row.id, {
                          inputPricePerMTok:
                            value.trim().length === 0 ? null : Number.parseFloat(value) || null,
                        })
                      }
                    />
                  </td>
                  <td>
                    <Input
                      value={
                        row.capability.outputPricePerMTok === null
                          ? ''
                          : String(row.capability.outputPricePerMTok)
                      }
                      onChange={(value) =>
                        onPatch(row.id, {
                          outputPricePerMTok:
                            value.trim().length === 0 ? null : Number.parseFloat(value) || null,
                        })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ManualModelInput({
  onAdd,
  disabled,
}: {
  onAdd(name: string): void;
  disabled?: boolean;
}): JSX.Element {
  const [name, setName] = useState('');

  const submit = (): void => {
    const value = name.trim();
    if (value.length === 0) return;
    onAdd(value);
    setName('');
  };

  return (
    <span className="ec-ai__inline-form">
      <Input
        value={name}
        onChange={setName}
        placeholder="手动添加模型名"
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
        }}
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={submit}
        disabled={disabled || name.trim().length === 0}
      >
        添加
      </Button>
    </span>
  );
}
