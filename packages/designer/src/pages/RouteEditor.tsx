/**
 * RouteEditor：编辑一条跳转边（navigate 动作）的目标页面与路由参数（T3-07）。
 *
 * - 目标页面：从项目内页面里选择，写回时转换为该页面的 route；
 * - 路由参数：RouteParam[]（name / type / required / 默认值），可增删；
 * - 通过 Modal 承载，保存时回调 onSave 交由上层写回 page-store。
 */
import * as React from 'react';
import { Button, Input, Modal, Select, Switch } from '@ec/ui';

import type { PageDsl, RouteParam } from '../dsl/types';
import type { RouteEdge } from './route-table';

export interface RouteEditorProps {
  edge: RouteEdge;
  pages: PageDsl[];
  onClose: () => void;
  onSave: (patch: { target: string; params: RouteParam[] }) => void;
}

const PARAM_TYPES: ReadonlyArray<RouteParam['type']> = ['string', 'number', 'boolean'];

export function RouteEditor({
  edge,
  pages,
  onClose,
  onSave,
}: RouteEditorProps): React.ReactElement {
  const [targetPageId, setTargetPageId] = React.useState<string>(
    edge.toPageId ?? pages[0]?.id ?? '',
  );
  const [params, setParams] = React.useState<RouteParam[]>(() =>
    edge.params.map((p) => ({ ...p })),
  );

  const targetPage = pages.find((p) => p.id === targetPageId) ?? null;

  const updateParam = (index: number, patch: Partial<RouteParam>): void => {
    setParams((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  const addParam = (): void => {
    setParams((prev) => [...prev, { name: '', type: 'string', required: false }]);
  };

  const removeParam = (index: number): void => {
    setParams((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = (): void => {
    const target = targetPage?.route ?? edge.route;
    onSave({ target, params: params.filter((p) => p.name.trim().length > 0) });
  };

  return (
    <Modal
      open
      title={`编辑跳转：${edge.fromPageName} → ${edge.route}`}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleSave}>
            保存
          </Button>
        </>
      }
    >
      <div className="ec-route-editor">
        <label className="ec-route-editor__field">
          <span>目标页面</span>
          <Select
            aria-label="目标页面"
            value={targetPageId}
            options={pages.map((p) => ({ value: p.id, label: `${p.name}（${p.route}）` }))}
            onChange={setTargetPageId}
          />
        </label>

        <div className="ec-route-editor__params">
          <div className="ec-route-editor__params-header">
            <span>路由参数</span>
            <Button size="sm" onClick={addParam}>
              新增参数
            </Button>
          </div>
          {params.length === 0 ? (
            <p className="ec-route-editor__empty">暂无参数</p>
          ) : (
            <ul className="ec-route-editor__param-list">
              {params.map((param, index) => (
                <li key={index} className="ec-route-editor__param-row">
                  <Input
                    aria-label="参数名"
                    placeholder="参数名"
                    value={param.name}
                    onChange={(value) => updateParam(index, { name: value })}
                  />
                  <Select
                    aria-label="参数类型"
                    value={param.type}
                    options={PARAM_TYPES.map((t) => ({ value: t, label: t }))}
                    onChange={(value) => updateParam(index, { type: value as RouteParam['type'] })}
                  />
                  <label className="ec-route-editor__required" title="是否必填">
                    <Switch
                      aria-label="是否必填"
                      checked={param.required}
                      onChange={(checked) => updateParam(index, { required: checked })}
                    />
                    <span>必填</span>
                  </label>
                  <Input
                    aria-label="默认值"
                    placeholder="默认值"
                    value={param.defaultValue === undefined ? '' : String(param.defaultValue)}
                    onChange={(value) => updateParam(index, { defaultValue: value })}
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => removeParam(index)}
                    aria-label="删除参数"
                  >
                    删除
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
