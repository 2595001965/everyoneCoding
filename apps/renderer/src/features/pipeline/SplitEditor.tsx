import type { ReactElement } from 'react';
import { useReducer, useState } from 'react';
import type { SplitModel } from '@ec/pipeline';
import { SplitGraph } from './SplitGraph';
import { Button, Checkbox, Input, Select } from '@ec/ui';

export interface SplitEditorProps {
  projectId: string;
  model: SplitModel;
  onChange(model: SplitModel): void;
}

/** 生成唯一 id（合并/拆分新节点用） */
function makeId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** 拆分编辑器：在 SplitGraph 上选中节点后，手动增删边 / 合并 / 拆分 */
export function SplitEditor({ model, onChange }: SplitEditorProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [mergeSelected, setMergeSelected] = useState<string[]>([]);
  const [addEdgeTarget, setAddEdgeTarget] = useState<string>('');
  const [newFeatureName, setNewFeatureName] = useState('');
  const [splitA, setSplitA] = useState('');
  const [splitB, setSplitB] = useState('');

  const graph = model.graphRef();
  const nodeIds = model.nodeIds();
  const cycles = model.detectCycles();
  const hasCycle = cycles.length > 0;

  const selectedData = selected !== null ? graph.nodeData(selected) ?? null : null;
  const isFeature = selectedData?.kind === 'feature';
  const upstream = selected !== null ? graph.dependencies(selected) : [];

  /** 提交一次变更：执行 model 方法 → 强制本地重渲染 → 回传父级 */
  const commit = (fn: () => void): void => {
    fn();
    bump();
    onChange(model);
  };

  const toggleMerge = (id: string, checked: boolean): void => {
    setMergeSelected((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
  };

  const handleAddEdge = (): void => {
    if (selected === null || addEdgeTarget === '' || addEdgeTarget === selected) return;
    const from = selected;
    const to = addEdgeTarget;
    commit(() => model.addEdge(from, to));
    setAddEdgeTarget('');
  };

  const handleRemoveEdge = (dep: string): void => {
    if (selected === null) return;
    const from = selected;
    const to = dep;
    commit(() => model.removeEdge(from, to));
  };

  const handleMerge = (): void => {
    if (mergeSelected.length < 2 || newFeatureName.trim() === '') return;
    const name = newFeatureName.trim();
    const ids = mergeSelected;
    commit(() => model.mergeNodes(ids, { id: makeId('f-'), name }));
    setMergeSelected([]);
    setNewFeatureName('');
    setSelected(null);
  };

  const handleSplit = (): void => {
    if (selected === null || !isFeature || splitA.trim() === '' || splitB.trim() === '') return;
    const featureId = selected;
    const parts = [
      { id: makeId('f-'), name: splitA.trim() },
      { id: makeId('f-'), name: splitB.trim() },
    ];
    commit(() => model.splitFeature(featureId, parts));
    setSplitA('');
    setSplitB('');
    setSelected(null);
  };

  const nodeOptions = nodeIds.map((id) => {
    const data = graph.nodeData(id);
    return { value: id, label: `${data?.name ?? id}（${data?.kind === 'feature' ? '功能' : '页面'}）` };
  });

  return (
    <div className="ec-pipe-split-editor" style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div style={{ flex: '1 1 60%', minWidth: 0, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        <SplitGraph model={model} highlightedIds={selected !== null ? [selected] : []} onNodeClick={setSelected} />
      </div>

      <div
        style={{
          flex: '1 1 40%',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          overflowY: 'auto',
          padding: 4,
        }}
      >
        {hasCycle && (
          <div style={{ background: '#fef2f2', color: '#dc2626', borderRadius: 6, padding: '8px 10px' }}>
            <div style={{ fontWeight: 600 }}>检测到环形依赖，请删除回边：</div>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {cycles.map((cycle, i) => (
                <li key={i}>{cycle.join(' → ')}</li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ color: '#475569', fontSize: 13 }}>
          已选节点：<strong>{selected !== null ? (selectedData?.name ?? selected) : '（在左侧点击选择）'}</strong>
          {selectedData !== null && `（${selectedData.kind === 'feature' ? '功能' : '页面'}）`}
        </div>

        {/* 添加依赖边 */}
        <fieldset style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
          <legend style={{ fontSize: 13, fontWeight: 600 }}>添加依赖边</legend>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>让所选节点依赖于：</span>
            <div style={{ minWidth: 180 }}>
              <Select
                options={nodeOptions}
                value={addEdgeTarget}
                onChange={setAddEdgeTarget}
                placeholder="选择上游节点"
                aria-label="上游依赖节点"
              />
            </div>
          </div>
          <Button variant="secondary" size="sm" style={{ marginTop: 8 }} disabled={selected === null || addEdgeTarget === ''} onClick={handleAddEdge}>
            添加依赖
          </Button>
        </fieldset>

        {/* 删除边 */}
        <fieldset style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
          <legend style={{ fontSize: 13, fontWeight: 600 }}>删除依赖边</legend>
          {selected === null && <div style={{ fontSize: 12, color: '#9ca3af' }}>请先选择节点</div>}
          {selected !== null && upstream.length === 0 && <div style={{ fontSize: 12, color: '#9ca3af' }}>该节点无出边</div>}
          {upstream.map((dep) => (
            <div key={dep} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '2px 0' }}>
              <span>{graph.nodeData(dep)?.name ?? dep}</span>
              <Button variant="ghost" size="sm" onClick={() => handleRemoveEdge(dep)}>
                删除
              </Button>
            </div>
          ))}
        </fieldset>

        {/* 合并节点 */}
        <fieldset style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
          <legend style={{ fontSize: 13, fontWeight: 600 }}>合并节点</legend>
          <div style={{ maxHeight: 120, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {nodeIds.map((id) => (
              <Checkbox
                key={id}
                checked={mergeSelected.includes(id)}
                onChange={(checked) => toggleMerge(id, checked)}
                label={graph.nodeData(id)?.name ?? id}
              />
            ))}
          </div>
          <Input
            value={newFeatureName}
            onChange={setNewFeatureName}
            placeholder="合并后的新功能名称"
            style={{ marginTop: 8 }}
          />
          <Button
            variant="secondary"
            size="sm"
            style={{ marginTop: 8 }}
            disabled={mergeSelected.length < 2 || newFeatureName.trim() === ''}
            onClick={handleMerge}
          >
            合并为功能
          </Button>
        </fieldset>

        {/* 拆分功能 */}
        <fieldset style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
          <legend style={{ fontSize: 13, fontWeight: 600 }}>拆分功能</legend>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
            仅当选中节点为「功能」时可用，拆分为两个新功能。
          </div>
          <Input value={splitA} onChange={setSplitA} placeholder="新功能一名称" />
          <Input value={splitB} onChange={setSplitB} placeholder="新功能二名称" style={{ marginTop: 6 }} />
          <Button
            variant="secondary"
            size="sm"
            style={{ marginTop: 8 }}
            disabled={!isFeature || splitA.trim() === '' || splitB.trim() === ''}
            onClick={handleSplit}
          >
            拆分功能
          </Button>
        </fieldset>
      </div>
    </div>
  );
}
