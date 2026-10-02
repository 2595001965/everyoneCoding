import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState } from '@ec/ui';
import {
  sortApiEndpoints,
  type ApiEndpointDetail,
  type ApiIndexPort,
  type ApiIndexSnapshot,
  type ApiSort,
  type IndexedApiCall,
} from '@ec/registry';
import type { SourceRef } from '@ec/core';
import { useNavLocation } from '../../runtime/nav-location';
import './api-index.css';

const time = (value: number | null): string =>
  value === null ? '未知' : new Date(value).toLocaleString('zh-CN');
const sources = {
  user: '人工覆盖',
  contract: '契约标签',
  feature: '项目功能',
  rule: '离线规则建议',
  unclassified: '未分类',
};
const creationSources = {
  tool_event: '工具创建事件',
  git_inferred: 'Git 首次出现推断',
  unknown: '未知',
};
const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function ApiWorkbench({
  api,
  projectId,
}: {
  api: ApiIndexPort;
  projectId: string;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<ApiIndexSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [sort, setSort] = useState<ApiSort>('created_desc');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApiEndpointDetail | null>(null);
  const [group, setGroup] = useState('');
  const [tags, setTags] = useState('');
  const [tab, setTab] = useState<'endpoints' | 'pending' | 'external'>('endpoints');
  const alive = useRef(true),
    detailVersion = useRef(0);
  const location = useNavLocation((s) => s.target);
  const load = useCallback(
    async (rescan = false): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        let next = await (rescan ? api.rescan() : api.list());
        if (!rescan && next.scannedAt === null) next = await api.rescan();
        if (alive.current) {
          setSnapshot(next);
          setDetail(null);
        }
      } catch (cause) {
        if (alive.current) setError(errorText(cause));
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [api],
  );
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  useEffect(() => {
    const focus = (): void => {
      void api
        .list()
        .then((next) => {
          if (alive.current) setSnapshot(next);
        })
        .catch((cause) => {
          if (alive.current) setError(errorText(cause));
        });
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [api]);
  useEffect(() => {
    if (location?.projectId === projectId && location.endpointIds?.[0])
      setSelected(location.endpointIds[0]);
  }, [location, projectId]);
  useEffect(() => {
    if (!selected) return;
    const version = ++detailVersion.current;
    void api
      .detail(selected)
      .then((next) => {
        if (!alive.current || version !== detailVersion.current) return;
        setDetail(next);
        setGroup(next.endpoint.classification.group ?? '');
        setTags(next.endpoint.classification.tags.join(', '));
      })
      .catch((cause) => {
        if (alive.current && version === detailVersion.current) setError(errorText(cause));
      });
  }, [api, selected, snapshot]);
  const endpoints = useMemo(
    () => snapshot?.endpoints.filter((e) => e.status !== 'removed') ?? [],
    [snapshot],
  );
  const groups = [...new Set(endpoints.map((e) => e.classification.group ?? '未分类'))].sort();
  const allTags = [...new Set(endpoints.flatMap((e) => e.classification.tags))].sort();
  const filtered = useMemo(
    () =>
      sortApiEndpoints(
        endpoints.filter(
          (e) =>
            (!groupFilter || (e.classification.group ?? '未分类') === groupFilter) &&
            (!serviceFilter || e.serviceId === serviceFilter) &&
            (!tagFilter || e.classification.tags.includes(tagFilter)) &&
            [
              e.title,
              e.method,
              e.normalizedPath,
              e.serviceId,
              e.classification.group ?? '',
              ...e.classification.tags,
            ]
              .join(' ')
              .toLowerCase()
              .includes(query.toLowerCase()),
        ),
        sort,
      ),
    [endpoints, groupFilter, serviceFilter, tagFilter, query, sort],
  );
  const navigate = (ref: SourceRef): void => {
    void api.navigate(ref).catch((cause) => setError(errorText(cause)));
  };
  const refList = (refs: readonly SourceRef[]): JSX.Element => (
    <ul className="ec-api-refs">
      {refs.length ? (
        refs.map((ref, i) => (
          <li key={`${ref.filePath}:${ref.startLine}:${i}`}>
            <button type="button" onClick={() => navigate(ref)}>
              {ref.filePath}
              {ref.startLine === null ? '（文件级）' : `:${ref.startLine}`} {ref.symbol ?? ''}
            </button>
          </li>
        ))
      ) : (
        <li>未识别</li>
      )}
    </ul>
  );
  const save = async (reset = false): Promise<void> => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await api.classify({
        endpointId: detail.endpoint.endpointId,
        revision: detail.endpoint.revision,
        group: group.trim() || null,
        tags: tags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
        reset,
      });
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (call: IndexedApiCall, endpointId: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(
        await api.confirmCall({ callId: call.callId, revision: call.revision, endpointId }),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const calls =
    snapshot?.calls.filter((c) =>
      tab === 'external' ? c.status === 'external' : c.status === 'pending_confirmation',
    ) ?? [];
  return (
    <section className="ec-api-workbench" aria-label="源码接口工作台">
      <header className="ec-api-toolbar">
        <p>从项目源码和本地契约识别 HTTP 接口。第三方请求仅展示本地调用证据。</p>
        <Button
          disabled={busy}
          onClick={() => {
            void load(true);
          }}
        >
          {busy ? '正在扫描…' : '重新扫描源码'}
        </Button>
      </header>
      {error && <p role="alert">{error}</p>}
      {snapshot?.stale && (
        <p role="status" className="ec-api-warning">
          源码已变化，当前索引已失效；请重新扫描后确认调用关系。
        </p>
      )}
      <p className="ec-api-meta">
        有效接口 {endpoints.length} · 待确认调用{' '}
        {snapshot?.calls.filter((c) => c.status === 'pending_confirmation').length ?? 0} · 最近扫描{' '}
        {time(snapshot?.scannedAt ?? null)}
      </p>
      {!!snapshot?.warnings.length && (
        <details>
          <summary>识别范围与未解析证据（{snapshot.warnings.length}）</summary>
          <ul>
            {snapshot.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <nav aria-label="接口视图" className="ec-api-tabs">
        {(
          [
            ['endpoints', '项目接口'],
            ['pending', '待确认调用'],
            ['external', '第三方请求'],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'endpoints' ? (
        <>
          <div className="ec-api-filters">
            <label>
              搜索接口
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="路径、方法、功能或标签"
              />
            </label>
            <label>
              功能分组
              <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
                <option value="">全部功能</option>
                {groups.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label>
              服务
              <select value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)}>
                <option value="">全部服务</option>
                {snapshot?.services.map((s) => (
                  <option key={s.serviceId} value={s.serviceId}>
                    {s.name} · {s.serviceId}
                  </option>
                ))}
              </select>
            </label>
            <label>
              标签
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                <option value="">全部标签</option>
                {allTags.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              排序
              <select value={sort} onChange={(e) => setSort(e.target.value as ApiSort)}>
                <option value="created_desc">创建时间降序</option>
                <option value="created_asc">创建时间升序</option>
                <option value="modified_desc">最近修改（源码文件）</option>
              </select>
            </label>
          </div>
          <div className="ec-api-columns">
            <div aria-label="接口列表" className="ec-api-list">
              {!filtered.length && (
                <EmptyState
                  title={busy ? '正在识别源码接口' : '没有匹配的接口'}
                  description="显式路由与本地 OpenAPI 会显示在这里；DSL apiDeps 不作为自动识别结果。"
                />
              )}
              {groups
                .filter((g) => filtered.some((e) => (e.classification.group ?? '未分类') === g))
                .map((g) => (
                  <section key={g}>
                    <h2>{g}</h2>
                    {filtered
                      .filter((e) => (e.classification.group ?? '未分类') === g)
                      .map((e) => (
                        <button
                          type="button"
                          className="ec-api-row"
                          aria-pressed={selected === e.endpointId}
                          key={e.endpointId}
                          onClick={() => {
                            if (selected !== e.endpointId) setDetail(null);
                            setSelected(e.endpointId);
                          }}
                        >
                          <strong>
                            {e.method}{' '}
                            {e.status === 'pending_confirmation' ? '路径待解析' : e.normalizedPath}
                          </strong>
                          <span>
                            {e.title} · {e.serviceId}
                          </span>
                          <span>
                            {sources[e.classification.source]} · {e.classification.tags.join(' / ')}
                          </span>
                          <span>
                            创建时间：{time(e.createdAt)}（{creationSources[e.createdAtSource]}）
                            {e.createdAt === null ? ` · 首次发现 ${time(e.firstSeenAt)}` : ''}
                          </span>
                        </button>
                      ))}
                  </section>
                ))}
            </div>
            <aside aria-label="接口详情" className="ec-api-detail">
              {!detail ? (
                <p>选择接口查看详情与证据。</p>
              ) : (
                <>
                  <h2>{detail.endpoint.title}</h2>
                  <p>
                    <strong>
                      {detail.endpoint.method}{' '}
                      {detail.endpoint.status === 'pending_confirmation'
                        ? '路径待解析'
                        : detail.endpoint.normalizedPath}
                    </strong>
                  </p>
                  <p>
                    服务：{detail.endpoint.serviceId} · 版本 {detail.endpoint.revision} ·{' '}
                    {detail.endpoint.status === 'removed'
                      ? '已删除（保留历史）'
                      : detail.endpoint.status === 'pending_confirmation'
                        ? '待确认'
                        : '有效'}
                  </p>
                  <dl>
                    <dt>创建时间</dt>
                    <dd>
                      {time(detail.endpoint.createdAt)} ·{' '}
                      {creationSources[detail.endpoint.createdAtSource]}
                    </dd>
                    <dt>时间证据</dt>
                    <dd>{detail.endpoint.timeReason}</dd>
                    <dt>首次发现</dt>
                    <dd>{time(detail.endpoint.firstSeenAt)}</dd>
                    <dt>源码文件修改</dt>
                    <dd>{time(detail.endpoint.modifiedAt)}（文件 mtime，仅用于修改时间）</dd>
                  </dl>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void save();
                    }}
                  >
                    <label>
                      人工功能分组
                      <input
                        value={group}
                        onChange={(e) => setGroup(e.target.value)}
                        maxLength={120}
                      />
                    </label>
                    <label>
                      人工标签
                      <input
                        value={tags}
                        onChange={(e) => setTags(e.target.value)}
                        placeholder="逗号分隔"
                      />
                    </label>
                    <p>
                      当前归类来源：{sources[detail.endpoint.classification.source]}；覆盖版本{' '}
                      {detail.endpoint.manualClassification?.revision ?? 0}
                    </p>
                    <Button disabled={busy} type="submit">
                      保存人工覆盖
                    </Button>{' '}
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void save(true);
                      }}
                    >
                      恢复自动建议
                    </Button>
                  </form>
                  <h3>入参/请求线索</h3>
                  <pre>
                    {detail.endpoint.parameters === null
                      ? '未识别'
                      : JSON.stringify(detail.endpoint.parameters, null, 2)}
                  </pre>
                  <h3>响应线索</h3>
                  <pre>
                    {detail.endpoint.response === null
                      ? '未识别'
                      : JSON.stringify(detail.endpoint.response, null, 2)}
                  </pre>
                  <h3>认证线索</h3>
                  <pre>
                    {detail.endpoint.authentication.length
                      ? detail.endpoint.authentication.join('\n')
                      : '未识别（不能据此认定无需认证）'}
                  </pre>
                  <h3>声明与证据</h3>
                  {detail.endpoint.evidence.map((ev, i) => (
                    <div key={i}>
                      {refList([ev.sourceRef])}
                      <p>
                        {ev.kind} · 置信度 {ev.confidence ?? '未知'}
                      </p>
                      <pre>{ev.detail}</pre>
                    </div>
                  ))}
                  <h3>调用方</h3>
                  {detail.calls.length ? (
                    detail.calls.map((c) => (
                      <div key={c.callId}>
                        {refList([c.sourceRef])}
                        <p>
                          {c.status === 'resolved' ? '已关联' : '候选，待确认'}{' '}
                          {c.confirmedByUser ? '· 人工确认' : ''}
                        </p>
                        <pre>{c.expression}</pre>
                      </div>
                    ))
                  ) : (
                    <p>暂无调用证据</p>
                  )}
                  <h3>实现链路（Service 方法）</h3>
                  {refList(detail.endpoint.implementation)}
                  <h3>关联元素</h3>
                  {detail.elements.length ? (
                    detail.elements.map((e) => (
                      <button
                        key={e.elementId}
                        type="button"
                        onClick={() => api.navigateElement(e)}
                      >
                        {e.name}
                      </button>
                    ))
                  ) : (
                    <p>暂无锚点证明的元素关联</p>
                  )}
                  <h3>测试引用线索（未验证覆盖）</h3>
                  {refList(detail.endpoint.tests)}
                  <h3>本地文档/契约</h3>
                  {refList(detail.endpoint.documents)}
                  {!!detail.endpoint.routeHistory.length && (
                    <details>
                      <summary>路由历史（稳定接口 ID）</summary>
                      <pre>{JSON.stringify(detail.endpoint.routeHistory, null, 2)}</pre>
                    </details>
                  )}
                </>
              )}
            </aside>
          </div>
        </>
      ) : (
        <div className="ec-api-calls">
          {!calls.length && <p>暂无{tab === 'external' ? '第三方请求' : '待确认调用'}。</p>}
          {calls.map((c) => (
            <article key={c.callId}>
              <h2>
                {c.method ?? '方法未解析'} {c.path ?? 'URL 未解析'}
              </h2>
              {refList([c.sourceRef])}
              <pre>{c.expression}</pre>
              <p>{c.reason}</p>
              {tab === 'pending' && (
                <>
                  <p>
                    候选：
                    {c.endpointIds.length
                      ? c.endpointIds
                          .map((id) => endpoints.find((e) => e.endpointId === id))
                          .filter(Boolean)
                          .map((e) => `${e!.serviceId} · ${e!.method} ${e!.normalizedPath}`)
                          .join('；')
                      : '无静态候选，可人工指定关系'}
                  </p>
                  <label>
                    确认项目接口
                    <select
                      disabled={busy || snapshot?.stale}
                      value=""
                      onChange={(e) => {
                        if (e.target.value) void confirm(c, e.target.value);
                      }}
                    >
                      <option value="">选择后确认关系</option>
                      {endpoints
                        .filter((e) => e.status === 'active')
                        .map((e) => (
                          <option key={e.endpointId} value={e.endpointId}>
                            {e.serviceId} · {e.method} {e.normalizedPath}
                          </option>
                        ))}
                    </select>
                  </label>
                  {c.confirmedEndpointId && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void confirm(c, null);
                      }}
                    >
                      清除历史人工关系
                    </Button>
                  )}
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
