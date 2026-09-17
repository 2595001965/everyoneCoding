/**
 * 冲突解决器（T8-03 渲染层）。
 *
 * 展示包内冲突条目，逐条提供"保留本地 / 采用包内 / 两者都保留"三选一；
 * 顶部按对象类型提供批量决策下拉。默认推荐"保留本地"（绝不自动覆盖）。
 * 未决策条数以徽标提示，用于驱动向导禁用"执行导入"。
 */

import { Badge, Select } from '@ec/ui';

import type { ConflictResolution, PackageDiffItem, PackageObjectType } from './package-api';

const RESOLUTIONS: ConflictResolution[] = ['keepLocal', 'takeNew', 'keepBoth'];

const RESOLUTION_LABELS: Record<ConflictResolution, string> = {
  keepLocal: '保留本地',
  takeNew: '采用包内',
  keepBoth: '两者都保留',
};

export interface ConflictResolverProps {
  items: PackageDiffItem[];
  decisions: Record<string, ConflictResolution>;
  onChange: (id: string, resolution: ConflictResolution) => void;
  onBatchChange: (type: PackageObjectType, resolution: ConflictResolution) => void;
}

export function ConflictResolver({ items, decisions, onChange, onBatchChange }: ConflictResolverProps): JSX.Element {
  const undecided = items.filter((i) => decisions[i.incoming.id] === undefined);
  const types = [...new Set(items.map((i) => i.incoming.type))];

  return (
    <div className="conflict-resolver">
      <div className="conflict-resolver__header">
        <span data-testid="conflict-total">冲突条目：{items.length}</span>
        {undecided.length > 0 && (
          <Badge color="warning" data-testid="conflict-undecided">
            {undecided.length} 项未决策
          </Badge>
        )}
      </div>

      <div className="conflict-resolver__batch">
        {types.map((type) => (
          <div key={type} className="conflict-resolver__batch-row">
            <span>{type} 批量决策</span>
            <Select
              aria-label={`${type}-batch`}
              placeholder="请选择"
              options={RESOLUTIONS.map((r) => ({ label: RESOLUTION_LABELS[r], value: r }))}
              value=""
              onChange={(v) => {
                if (v !== '') onBatchChange(type, v as ConflictResolution);
              }}
            />
          </div>
        ))}
      </div>

      <ul className="conflict-resolver__list">
        {items.map((item) => {
          const current = decisions[item.incoming.id];
          return (
            <li key={item.incoming.id} data-testid={`conflict-${item.incoming.id}`} className="conflict-resolver__item">
              <div className="conflict-resolver__item-head">
                <span className="conflict-resolver__name">{item.incoming.name}</span>
                <span className="conflict-resolver__type">{item.incoming.type}</span>
              </div>
              <div className="conflict-resolver__meta">
                包内 updatedAt {item.incoming.updatedAt} / 本地 {item.local ? `updatedAt ${item.local.updatedAt}` : '无'}
              </div>
              <div className="conflict-resolver__actions">
                {RESOLUTIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={current === r}
                    className={current === r ? 'is-active' : ''}
                    onClick={() => onChange(item.incoming.id, r)}
                  >
                    {RESOLUTION_LABELS[r]}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
