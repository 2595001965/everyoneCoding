import * as React from 'react';

import { Button, EmptyState, Input, Tag } from '@ec/ui';

import type { PageDsl } from '../dsl/types';
import {
  collectMasterInstances,
  detachInstance,
  masterUsage,
  syncInstances,
  type MasterDefinition,
  type MasterRegistry,
} from './master-sync';

/**
 * 母版面板（T3-11 要点 3）。
 *
 * 列出母版与其全部实例；修改母版后可对**每个实例**单独选择「同步更新」或「脱离」。
 * 脱离后的实例会被标记，且不再随母版变化。
 */

export interface MasterPanelProps {
  registry: MasterRegistry;
  /** 当前打开的页面（用于实例列表与写回） */
  page: PageDsl;
  /** 写回页面 DSL（同步 / 脱离后） */
  onChange?: (dsl: PageDsl) => void;
  /** 母版在项目内的全部页面（用于统计使用情况） */
  allPages?: readonly PageDsl[];
}

export function MasterPanel({ registry, page, onChange, allPages }: MasterPanelProps): React.ReactElement {
  const masters = registry.list();

  if (masters.length === 0) {
    return (
      <div className="ec-master-panel" data-testid="master-panel">
        <EmptyState title="还没有母版" description="把常用结构保存为母版后，即可在多处复用并统一更新。" />
      </div>
    );
  }

  return (
    <div className="ec-master-panel" data-testid="master-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {masters.map((master) => (
        <MasterSection
          key={master.id}
          master={master}
          registry={registry}
          page={page}
          {...(onChange ? { onChange } : {})}
          {...(allPages ? { allPages } : {})}
        />
      ))}
    </div>
  );
}

function MasterSection({
  master,
  registry,
  page,
  onChange,
  allPages,
}: {
  master: MasterDefinition;
  registry: MasterRegistry;
  page: PageDsl;
  onChange?: (dsl: PageDsl) => void;
  allPages?: readonly PageDsl[];
}): React.ReactElement {
  const instances = collectMasterInstances(page, master.id);
  const usage = masterUsage(allPages ?? [page], master.id);
  const [pendingSync, setPendingSync] = React.useState<string[]>([]);

  return (
    <section data-testid={`master-${master.id}`} style={{ display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid #e9ecef', borderRadius: 6, padding: 8 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={{ fontSize: 13 }}>{master.name}</strong>
        <Tag color="info">{`${usage.total} 个实例`}</Tag>
        {usage.detached > 0 && <Tag color="warning">{`${usage.detached} 个已脱离`}</Tag>}
        <Tag color="info">{`更新于 ${new Date(master.updatedAt).toLocaleTimeString('zh-CN')}`}</Tag>
      </header>

      {instances.length === 0 ? (
        <p style={{ fontSize: 12, opacity: 0.6 }}>当前页面没有使用该母版</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {instances.map((instance) => (
            <li key={instance.elementId} data-testid={`master-instance-${instance.elementId}`} data-detached={instance.detached ? 'true' : 'false'} style={{ fontSize: 12 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  aria-label={`选择实例 ${instance.elementId}`}
                  checked={pendingSync.includes(instance.elementId)}
                  onChange={(event) =>
                    setPendingSync((prev) =>
                      event.target.checked ? [...prev, instance.elementId] : prev.filter((id) => id !== instance.elementId),
                    )
                  }
                />
                <span>{instance.name ?? instance.elementId}</span>
                <span style={{ opacity: 0.6 }}>{instance.elementId}</span>
              </label>
              {instance.detached && <Tag color="warning">已脱离</Tag>}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (onChange) onChange(detachInstance(page, instance.elementId));
                }}
              >
                脱离
              </Button>
              <Button
                size="sm"
                variant="secondary"
                data-testid={`sync-${instance.elementId}`}
                onClick={() => {
                  if (!onChange) return;
                  const result = syncInstances(page, master, { elementIds: [instance.elementId] });
                  onChange(result.dsl);
                }}
              >
                同步更新
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Input
          aria-label={`${master.name} 版本说明`}
          value={master.note ?? ''}
          placeholder="本次修改说明（可选）"
          onChange={(next) => registry.update(master.id, { note: next })}
        />
        <Button
          size="sm"
          variant="primary"
          data-testid={`sync-selected-${master.id}`}
          disabled={pendingSync.length === 0}
          onClick={() => {
            if (!onChange) return;
            const result = syncInstances(page, master, { elementIds: pendingSync });
            onChange(result.dsl);
            setPendingSync([]);
          }}
        >
          {`同步选中的 ${pendingSync.length} 个实例`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={instances.length === 0}
          onClick={() => {
            if (!onChange) return;
            const result = syncInstances(page, master);
            onChange(result.dsl);
          }}
        >
          全部同步
        </Button>
      </div>
    </section>
  );
}
