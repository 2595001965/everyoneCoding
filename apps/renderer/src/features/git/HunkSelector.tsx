/**
 * Hunk 级勾选（T6-02 要点 3）：每个 hunk 一个 checkbox，勾选后「提交选中变更」
 * 用 `buildHunkPatch` 把选中 hunk 组装成可提交 patch，交给上层落盘。
 *
 * 注意：渲染层不直接写文件，patch 仅作为「提交选中变更」的请求载荷传出。
 */
import { useCallback, useState } from 'react';

import { Button } from '@ec/ui';
import { buildHunkPatch, type GitDiffFile } from '@ec/git';

export interface HunkSelectorProps {
  file: GitDiffFile;
  /** 选中 hunk 组装出的 patch（已通过 buildHunkPatch）；传 null 表示未选任何 hunk */
  onCommitSelected?: (patch: string) => void;
}

export function HunkSelector({ file, onCommitSelected }: HunkSelectorProps): JSX.Element | null {
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const toggle = useCallback((index: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }, []);

  const commit = useCallback(() => {
    if (selected.size === 0) return;
    const patch = buildHunkPatch(file, [...selected]);
    onCommitSelected?.(patch);
  }, [file, selected, onCommitSelected]);

  if (file.skipped || file.hunks.length === 0) return null;

  return (
    <div className="ec-hunk-selector" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="ec-hunk-selector__title" style={{ fontWeight: 600 }}>
        选择要提交的代码块（{file.path}）
      </div>
      {file.hunks.map((hunk) => (
        <label
          key={hunk.index}
          className="ec-hunk-selector__hunk"
          style={{ display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <input
            type="checkbox"
            checked={selected.has(hunk.index)}
            onChange={(e) => toggle(hunk.index, e.target.checked)}
            aria-label={`选择代码块 ${hunk.index}`}
            data-testid={`hunk-check-${hunk.index}`}
          />
          <span
            className="ec-hunk-selector__hdr"
            style={{ fontFamily: 'monospace', color: 'var(--ec-color-text-secondary)' }}
          >
            {hunk.header}
          </span>
        </label>
      ))}
      <Button
        size="sm"
        variant="primary"
        onClick={commit}
        disabled={selected.size === 0}
        data-testid="commit-selected"
      >
        提交选中变更（{selected.size}）
      </Button>
    </div>
  );
}
