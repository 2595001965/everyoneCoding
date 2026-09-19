/**
 * 历史筛选（T6-03 要点 3）：按文件 / 作者 / 关键词筛选提交。
 *
 * 纯受控组件：自身不发起请求，条件变化只回调上层；由 `HistoryTimeline`/工作区
 * 把过滤条件转成 `api.log({ path, author, keyword })`（用户永不接触命令行）。
 */
import { Input, SearchInput } from '@ec/ui';

export interface HistoryFilterValue {
  /** 文件路径（工作区相对路径，正斜杠） */
  path: string;
  /** 作者（姓名或邮箱片段） */
  author: string;
  /** 提交信息关键词 */
  keyword: string;
}

export const EMPTY_HISTORY_FILTER: HistoryFilterValue = { path: '', author: '', keyword: '' };

/**
 * 过滤条件 → `GitApi.log` 的入参。
 * 空字符串视为「不限制」，转成 undefined 而不是空串（避免把 `--author=` 传下去）。
 */
export function toLogOptions(value: HistoryFilterValue): {
  path?: string;
  author?: string;
  keyword?: string;
} {
  return {
    ...(value.path.trim().length > 0 ? { path: value.path.trim() } : {}),
    ...(value.author.trim().length > 0 ? { author: value.author.trim() } : {}),
    ...(value.keyword.trim().length > 0 ? { keyword: value.keyword.trim() } : {}),
  };
}

export interface HistoryFilterProps {
  value: HistoryFilterValue;
  onChange: (value: HistoryFilterValue) => void;
}

export function HistoryFilter({ value, onChange }: HistoryFilterProps): JSX.Element {
  return (
    <div
      className="ec-history-filter"
      data-testid="history-filter"
      style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
    >
      <Input
        aria-label="按文件筛选"
        placeholder="文件路径，例如 src/app.ts"
        value={value.path}
        onChange={(next) => onChange({ ...value, path: next })}
        data-testid="filter-path"
      />
      <Input
        aria-label="按作者筛选"
        placeholder="作者"
        value={value.author}
        onChange={(next) => onChange({ ...value, author: next })}
        data-testid="filter-author"
      />
      <SearchInput
        aria-label="按关键词筛选"
        placeholder="提交信息关键词"
        value={value.keyword}
        onChange={(next) => onChange({ ...value, keyword: next })}
        data-testid="filter-keyword"
      />
      <button
        type="button"
        onClick={() => onChange({ ...EMPTY_HISTORY_FILTER })}
        data-testid="filter-reset"
        style={{
          padding: '4px 10px',
          border: '1px solid var(--ec-color-border)',
          borderRadius: 6,
          cursor: 'pointer',
          background: 'var(--ec-color-surface)',
          color: 'var(--ec-color-text)',
        }}
      >
        重置
      </button>
    </div>
  );
}
