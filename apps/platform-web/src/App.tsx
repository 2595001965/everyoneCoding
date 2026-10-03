import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api, queryString } from './api';
import type {
  AdminModel,
  AdminProvider,
  AuditEvent,
  AuthPayload,
  BillingAttempt,
  CatalogModel,
  CatalogSnapshot,
  Identity,
  PriceRates,
  PriceVersion,
  ReconciliationCase,
  Wallet,
} from './types';

interface Session {
  identity: Identity;
  accessToken: string;
}

interface AuthContextValue {
  session: Session | null;
  authenticate: (result: AuthPayload) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthContext is missing');
  return context;
}

function useSiteData(): {
  catalog: CatalogSnapshot | null;
  status: 'loading' | 'ready' | 'error';
  refreshedAt: number | null;
  refresh: () => Promise<void>;
  error: string | null;
} {
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setStatus((old) => (old === 'ready' ? old : 'loading'));
    setError(null);
    try {
      const result = await api<CatalogSnapshot>('/api/catalog');
      setCatalog(result);
      setRefreshedAt(Date.now());
      setStatus('ready');
    } catch (cause) {
      setStatus('error');
      setError(errorText(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { catalog, status, refreshedAt, refresh, error };
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const trace = error.traceId ? `（追踪号 ${error.traceId}）` : '';
    return `${error.message}${trace}`;
  }
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试';
}

function secureDownloadUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function money(micros: number | null | undefined, currency: string): string {
  if (micros === null || micros === undefined) return '待结算';
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    }).format(micros / 1_000_000);
  } catch {
    return `${(micros / 1_000_000).toFixed(6)} ${currency}`;
  }
}

function rate(microsPerMillion: number | null): string {
  return microsPerMillion === null
    ? '未知'
    : `${(microsPerMillion / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} / 百万 Token`;
}

function dateTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    value,
  );
}

function idShort(value: string | null | undefined): string {
  return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : '未提供';
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: '可用',
    maintenance: '维护中',
    disabled: '已停用',
    reserved: '预占中',
    unknown_pending_reconciliation: '待对账',
    reconciliation_required: '待人工处理',
    settled: '已结算',
    released: '已释放',
    reversed: '已冲正',
    open: '待处理',
    resolved: '已处理',
  };
  return labels[status] ?? status;
}

function statusClass(status: string): string {
  if (status === 'active' || status === 'settled' || status === 'resolved')
    return 'status status--good';
  if (
    status === 'maintenance' ||
    status === 'reserved' ||
    status.includes('reconciliation') ||
    status === 'open'
  )
    return 'status status--warning';
  return 'status status--muted';
}

function Button(props: {
  children: React.ReactNode;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`button button--${props.variant ?? 'primary'}`}
      type={props.type ?? 'button'}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function Alert({
  children,
  tone = 'error',
}: {
  children: React.ReactNode;
  tone?: 'error' | 'success' | 'info';
}) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <span className="empty__mark">∅</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function Spinner({ label = '正在读取' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [health, setHealth] = useState<'loading' | 'ok' | 'error'>('loading');
  const navigate = useNavigate();
  const location = useLocation();
  const site = useSiteData();
  const auth = useMemo<AuthContextValue>(
    () => ({
      session,
      authenticate: (result) =>
        setSession({ identity: result.identity, accessToken: result.tokens.accessToken }),
      logout: () => {
        setSession(null);
        navigate('/');
      },
    }),
    [session, navigate],
  );

  useEffect(() => {
    let mounted = true;
    const check = async (): Promise<void> => {
      try {
        const result = await api<{ status: string }>('/health');
        if (mounted) setHealth(result.status === 'ok' ? 'ok' : 'error');
      } catch {
        if (mounted) setHealth('error');
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <AuthContext.Provider value={auth}>
      <div className="site-shell">
        <header className="site-header">
          <Link className="brand" to="/" aria-label="EveryoneCoding 首页">
            <span className="brand__mark">EC</span>
            <span className="brand__name">
              EveryoneCoding<span>平台服务</span>
            </span>
          </Link>
          <nav className="top-nav" aria-label="主导航">
            <Link className={location.pathname === '/catalog' ? 'is-active' : ''} to="/catalog">
              服务目录
            </Link>
            <Link className={location.pathname === '/privacy' ? 'is-active' : ''} to="/privacy">
              隐私与安全
            </Link>
            {session ? (
              <Link className={location.pathname === '/account' ? 'is-active' : ''} to="/account">
                用户中心
              </Link>
            ) : (
              <Link to="/auth">账号登录</Link>
            )}
          </nav>
          <div className="header-end">
            <span className={`health-pill health-pill--${health}`}>
              <i />
              {health === 'ok' ? '服务正常' : health === 'loading' ? '检查服务' : '服务不可用'}
            </span>
            {session && (
              <button className="user-chip" type="button" onClick={() => navigate('/account')}>
                {session.identity.displayName}
              </button>
            )}
          </div>
        </header>

        <main id="main-content">
          <Routes>
            <Route path="/" element={<HomePage site={site} health={health} />} />
            <Route path="/catalog" element={<CatalogPage site={site} />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/auth" element={<AuthPage />} />
            <Route
              path="/account"
              element={
                session ? (
                  <AccountPage site={site} />
                ) : (
                  <Navigate to="/auth" replace state={{ from: '/account' }} />
                )
              }
            />
            <Route
              path="/admin"
              element={
                session ? (
                  <AdminPage site={site} />
                ) : (
                  <Navigate to="/auth" replace state={{ from: '/admin' }} />
                )
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>

        <footer className="site-footer">
          <span>© EveryoneCoding · Apache-2.0</span>
          <span>平台账务按服务端账本展示；未知用量和价格不会按 0 处理。</span>
          <Link to="/privacy">隐私与安全说明</Link>
        </footer>
      </div>
    </AuthContext.Provider>
  );
}

function HomePage({ site, health }: { site: ReturnType<typeof useSiteData>; health: string }) {
  const { session } = useAuth();
  const electron = secureDownloadUrl(import.meta.env.VITE_EC_ELECTRON_DOWNLOAD_URL);
  const tauri = secureDownloadUrl(import.meta.env.VITE_EC_TAURI_DOWNLOAD_URL);
  return (
    <>
      <section className="hero wrap">
        <div className="hero__copy">
          <div className="eyebrow">
            <span className="eyebrow__line" />
            本地开发工作台 · 可选平台服务
          </div>
          <h1>
            把代码留在
            <br />
            <em>自己的工作区。</em>
          </h1>
          <p className="hero__lead">
            EveryoneCoding 的设计、源码和 BYOK
            工作流在桌面端运行。平台网站负责公开服务目录、账号与托管请求账单。
          </p>
          <div className="hero__actions">
            <Link className="button button--primary" to="/catalog">
              查看服务目录 <span aria-hidden="true">↗</span>
            </Link>
            <Link className="button button--secondary" to={session ? '/account' : '/auth'}>
              {session ? '进入用户中心' : '登录或注册'}
            </Link>
          </div>
          <div className="hero__foot">
            <span className={`health-dot health-dot--${health}`} />
            {health === 'ok'
              ? '账号与目录 API 可达'
              : health === 'loading'
                ? '正在检查服务状态'
                : '账号服务暂时不可达'}
          </div>
        </div>
        <div className="hero__art" aria-label="本地代码与平台服务的关系示意图" role="img">
          <div className="orbit orbit--outer" />
          <div className="orbit orbit--inner" />
          <div className="art-card art-card--local">
            <span className="art-card__icon">⌘</span>
            <div>
              <strong>你的工作区</strong>
              <small>源码 · 会话 · BYOK</small>
            </div>
            <b>本地</b>
          </div>
          <div className="art-card art-card--platform">
            <span className="art-card__icon art-card__icon--bright">↗</span>
            <div>
              <strong>平台托管</strong>
              <small>目录 · 流量 · 账务</small>
            </div>
            <b>可选</b>
          </div>
          <div className="art-center">
            <span>EC</span>
            <small>
              YOU
              <br />
              CONTROL
            </small>
          </div>
          <div className="art-caption">你的代码不会因开通账号自动同步</div>
        </div>
      </section>

      <section className="wrap section-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">平台服务</p>
            <h2>你需要时，再连接平台。</h2>
          </div>
          <span className="section-note">账号、托管路由和平台账务彼此明确</span>
        </div>
        <div className="feature-grid">
          <article className="feature-card">
            <span className="feature-num">01</span>
            <h3>公开服务目录</h3>
            <p>逐 Provider 和模型展示服务状态与已发布价格。没有可靠价格时明确标为未知。</p>
            <Link to="/catalog">
              浏览目录 <span>→</span>
            </Link>
          </article>
          <article className="feature-card">
            <span className="feature-num">02</span>
            <h3>用户账单</h3>
            <p>查看自己的余额、冻结额、平台 attempt、价格版本与结算状态，支持筛选和翻页。</p>
            <Link to={session ? '/account' : '/auth'}>
              {session ? '打开用户中心' : '登录后查看'} <span>→</span>
            </Link>
          </article>
          <article className="feature-card">
            <span className="feature-num">03</span>
            <h3>运营管理</h3>
            <p>管理员通过服务端 allowlist 管理渠道、发布不可变价格、登记人工额度和查看审计。</p>
            <Link to="/admin">
              管理员入口 <span>→</span>
            </Link>
          </article>
        </div>
      </section>

      <section className="download-band">
        <div className="wrap download-band__inner">
          <div>
            <p className="eyebrow">桌面工作台</p>
            <h2>双形态桌面端</h2>
            <p>下载地址由发行环境配置；当前没有配置的渠道不会显示虚构的下载链接。</p>
          </div>
          <div className="download-links">
            <DownloadLink label="Electron 版" href={electron} />
            <DownloadLink label="Tauri 版" href={tauri} />
          </div>
        </div>
      </section>

      <section className="wrap section-block status-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">运行状态</p>
            <h2>公开可见，状态如实。</h2>
          </div>
          <Button variant="quiet" onClick={() => void site.refresh()}>
            刷新目录 <span aria-hidden="true">↻</span>
          </Button>
        </div>
        <div className="status-grid">
          <div className="status-card">
            <span>账号服务</span>
            <strong className={`health-text health-text--${health}`}>
              {health === 'ok' ? '正常' : health === 'loading' ? '检查中' : '不可用'}
            </strong>
            <small>最近检查会定时更新</small>
          </div>
          <div className="status-card">
            <span>公开目录</span>
            <strong>
              {site.status === 'ready'
                ? `${site.catalog?.providers.length ?? 0} 个渠道`
                : site.status === 'loading'
                  ? '读取中'
                  : '读取失败'}
            </strong>
            <small>
              {site.refreshedAt
                ? `快照时间 ${dateTime(site.catalog?.generatedAt)}`
                : '由账号服务实时提供'}
            </small>
          </div>
          <div className="status-card">
            <span>目录隐私边界</span>
            <strong>无上游凭据</strong>
            <small>公开快照不包含内部上游地址或密钥</small>
          </div>
        </div>
      </section>
    </>
  );
}

function DownloadLink({ label, href }: { label: string; href: string | undefined }) {
  return href ? (
    <a className="download-link" href={href} rel="noopener noreferrer">
      <span>↓</span>
      {label}
      <small>打开已配置的发行地址</small>
    </a>
  ) : (
    <div className="download-link download-link--off" aria-disabled="true">
      <span>—</span>
      {label}
      <small>发行地址暂未配置</small>
    </div>
  );
}

function CatalogPage({ site }: { site: ReturnType<typeof useSiteData> }) {
  const [filter, setFilter] = useState('');
  const [showReferences, setShowReferences] = useState(false);
  const catalog = site.catalog;
  const providerMap = useMemo(
    () => new Map(catalog?.providers.map((provider) => [provider.providerId, provider]) ?? []),
    [catalog],
  );
  const latestPrices = useMemo(() => {
    const prices = new Map<string, PriceVersion>();
    for (const price of catalog?.platformPrices ?? []) {
      const current = prices.get(price.providerModelKey);
      if (!current || current.effectiveFrom < price.effectiveFrom)
        prices.set(price.providerModelKey, price);
    }
    return prices;
  }, [catalog]);
  const models = (catalog?.models ?? []).filter((model) => {
    const provider = providerMap.get(model.providerId);
    const text =
      `${model.displayName ?? ''} ${model.canonicalModel ?? ''} ${provider?.displayName ?? ''}`.toLowerCase();
    return text.includes(filter.toLowerCase());
  });
  return (
    <section className="wrap page-wrap">
      <PageTitle
        eyebrow="公开目录"
        title="模型服务目录"
        subtitle="目录只展示已公开的 Provider、模型与服务端价格；相同模型名按 Provider 独立计价。"
      />
      <div className="catalog-toolbar">
        <label className="field field--search">
          <span>搜索</span>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="渠道或模型名称"
          />
        </label>
        <span className="section-note">
          {site.refreshedAt
            ? `目录更新于 ${dateTime(catalog?.generatedAt)}`
            : '价格来源与版本随目录展示'}
        </span>
        <Button variant="quiet" onClick={() => void site.refresh()}>
          刷新
        </Button>
      </div>
      {site.error && catalog && (
        <Alert tone="info">目录刷新失败，当前展示的是上次成功读取的快照：{site.error}</Alert>
      )}
      {site.status === 'loading' && !catalog ? (
        <Spinner label="正在读取公开服务目录" />
      ) : site.error && !catalog ? (
        <ErrorPanel message={site.error} retry={() => void site.refresh()} />
      ) : models.length === 0 ? (
        <Empty
          title={filter ? '没有匹配的模型' : '当前没有公开模型'}
          detail={
            filter ? '调整渠道或模型关键字后再试。' : '平台尚未发布可公开展示的 Provider 和模型。'
          }
        />
      ) : (
        <div className="catalog-list">
          {models.map((model) => {
            const provider = providerMap.get(model.providerId);
            const key = `${model.providerId}/${model.modelId}`;
            const price = latestPrices.get(key);
            const official = catalog?.officialPrices.find(
              (entry) =>
                entry.canonicalVendor === model.canonicalVendor &&
                entry.canonicalModel === model.canonicalModel,
            );
            return (
              <article className="catalog-card" key={key}>
                <div className="catalog-card__main">
                  <div className="catalog-card__top">
                    <span className="protocol-tag">
                      {model.protocol === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容'}
                    </span>
                    <span className={statusClass(provider?.status ?? 'disabled')}>
                      {statusLabel(provider?.status ?? 'disabled')}
                    </span>
                  </div>
                  <h3>{model.displayName ?? model.canonicalModel ?? '未命名模型'}</h3>
                  <p>
                    {provider?.displayName ?? '未知 Provider'}
                    {model.canonicalVendor && model.canonicalModel
                      ? ` · ${model.canonicalVendor}/${model.canonicalModel}`
                      : ' · 官方身份未核验'}
                  </p>
                  <div className="catalog-meta">
                    <span>
                      上下文{' '}
                      {model.contextWindowTokens
                        ? `${model.contextWindowTokens.toLocaleString()} tokens`
                        : '未知'}
                    </span>
                    <span>更新于 {dateTime(provider?.updatedAt)}</span>
                  </div>
                  {provider?.status === 'maintenance' && provider.statusReason && (
                    <p className="maintenance-note">维护原因：{provider.statusReason}</p>
                  )}
                </div>
                <div className="catalog-card__price">
                  <div className="catalog-card__price-heading">
                    <strong>
                      {price
                        ? `${price.currency} 平台价格`
                        : official
                          ? `${official.currency} 厂商参考`
                          : '价格未知'}
                    </strong>
                    <span>
                      {price
                        ? `平台版本 v${price.version}`
                        : official
                          ? `官方证据 v${official.version}`
                          : '不会套用其他渠道价格'}
                    </span>
                  </div>
                  <PriceRows rates={price?.rates ?? official?.rates ?? null} />
                  <p className="price-source">
                    {price ? (
                      `自 ${dateTime(price.effectiveFrom)} 生效${price.source.evidenceUrl ? ` · 依据 ${price.source.evidenceUrl}` : ''}`
                    ) : official ? (
                      <>
                        <a href={official.sourceUrl} target="_blank" rel="noreferrer">
                          官方来源
                        </a>{' '}
                        · 核验于 {dateTime(official.verifiedAt)}；{official.conditions}
                      </>
                    ) : (
                      '无已发布价格，价格不可计算时平台会拒绝收费请求。'
                    )}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="catalog-disclosure">
        <div>
          <strong>价格说明</strong>
          <p>
            价格按精确 Provider + Model 路由发布。缓存写费率是该桶完整费率；未知收费项不会填
            0，也不会从其他渠道补入。
          </p>
        </div>
        <Button variant="quiet" onClick={() => setShowReferences((value) => !value)}>
          {showReferences ? '隐藏价格版本' : '查看历史版本'}
        </Button>
      </div>
      {showReferences && catalog && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>路由</th>
                <th>来源</th>
                <th>币种</th>
                <th>版本</th>
                <th>生效时间</th>
                <th>输入 / 百万</th>
                <th>缓存读 / 百万</th>
                <th>输出 / 百万</th>
              </tr>
            </thead>
            <tbody>
              {catalog.platformPrices.map((price) => (
                <tr key={price.priceVersionId}>
                  <td>
                    <code>
                      {idShort(price.providerModelKey.split('/')[0])} /{' '}
                      {idShort(price.providerModelKey.split('/')[1])}
                    </code>
                  </td>
                  <td>平台发布</td>
                  <td>{price.currency}</td>
                  <td>v{price.version}</td>
                  <td>{dateTime(price.effectiveFrom)}</td>
                  <td>{rate(price.rates.uncachedInput)}</td>
                  <td>{rate(price.rates.cacheRead)}</td>
                  <td>{rate(price.rates.output)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PriceRows({ rates }: { rates: PriceRates | null }) {
  if (!rates) return <p className="unknown-price">无报价记录</p>;
  return (
    <div className="price-rows">
      <span>
        输入<strong>{rate(rates.uncachedInput)}</strong>
      </span>
      <span>
        缓存读<strong>{rate(rates.cacheRead)}</strong>
      </span>
      <span>
        缓存写
        <strong>
          {rates.cacheWriteByTtl === null
            ? '未知'
            : Object.keys(rates.cacheWriteByTtl).length
              ? Object.entries(rates.cacheWriteByTtl)
                  .map(([ttl, value]) => `${ttl}: ${rate(value)}`)
                  .join(' · ')
              : '无此计费桶'}
        </strong>
      </span>
      <span>
        输出<strong>{rate(rates.output)}</strong>
      </span>
    </div>
  );
}

function PrivacyPage() {
  return (
    <section className="wrap page-wrap">
      <PageTitle
        eyebrow="安全与数据"
        title="你提交什么，平台就处理什么。"
        subtitle="桌面项目、源码、会话内容和 BYOK 密钥不会因注册账号而自动同步。"
      />
      <div className="privacy-grid">
        <article className="privacy-card">
          <span>01</span>
          <h3>平台托管请求</h3>
          <p>
            托管请求会临时经过平台服务转发；账务持久化保存请求摘要、路由、用量、价格快照和状态，不保存聊天正文。
          </p>
        </article>
        <article className="privacy-card">
          <span>02</span>
          <h3>最小标识</h3>
          <p>
            项目和会话筛选只使用不透明标识。不要在这些 ID 中写入项目名、文件路径、源码或个人信息。
          </p>
        </article>
        <article className="privacy-card">
          <span>03</span>
          <h3>凭据边界</h3>
          <p>
            Provider
            上游凭据只由服务端引用和读取；管理台只显示是否登记凭据引用及最近变更时间，不显示原始引用或密钥。BYOK
            密钥留在桌面设备。
          </p>
        </article>
        <article className="privacy-card">
          <span>04</span>
          <h3>本地登录会话</h3>
          <p>
            网站 access token 只保存在当前页面内存中，不写入 localStorage、sessionStorage 或
            Cookie。刷新页面或关闭标签页后需要重新登录。
          </p>
        </article>
        <article className="privacy-card">
          <span>05</span>
          <h3>日志与账务</h3>
          <p>
            账务记录按不可变账本语义保留；应用日志脱敏。诊断日志保留周期需由实际部署者确定并在正式上线前公开。
          </p>
        </article>
        <article className="privacy-card">
          <span>06</span>
          <h3>支付说明</h3>
          <p>
            当前没有在线充值或支付回调。管理员人工入账会明确记为“人工账务调整”，不会显示成支付成功。
          </p>
        </article>
      </div>
      <div className="notice-band">
        <strong>部署提示</strong>
        <p>
          正式公网访问必须置于受信任的 TLS
          反向代理后，限制账号服务仅供站点容器访问，并单独设定数据保留与备份周期。本仓库的本地
          Compose 配置只绑定回环地址。
        </p>
      </div>
    </section>
  );
}

function AuthPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { session, authenticate } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/account';
  if (session) return <Navigate to={from} replace />;
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<AuthPayload>(
        mode === 'register' ? '/api/auth/register' : '/api/auth/login',
        {
          method: 'POST',
          body: { email, password, ...(mode === 'register' && displayName ? { displayName } : {}) },
        },
      );
      authenticate(result);
      navigate(from, { replace: true });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="wrap auth-wrap">
      <div className="auth-aside">
        <p className="eyebrow">账号中心</p>
        <h1>{mode === 'login' ? '欢迎回来。' : '创建你的平台账号。'}</h1>
        <p>平台账号用于查看个人平台账务和选择平台托管模型。桌面端 BYOK 工作流不要求登录。</p>
        <div className="auth-aside__line">
          <span />
          邮箱与密码由现有账号服务校验
        </div>
      </div>
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <div className="auth-card__top">
          <span className="brand__mark">EC</span>
          <div>
            <h2>{mode === 'login' ? '登录' : '注册'}</h2>
            <p>登录令牌只在当前页面内存中保留。</p>
          </div>
        </div>
        {error && <Alert>{error}</Alert>}
        {mode === 'register' && (
          <label className="field">
            <span>显示名称</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="nickname"
              maxLength={64}
            />
          </label>
        )}
        <label className="field">
          <span>邮箱</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
            maxLength={254}
          />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={8}
            maxLength={128}
          />
        </label>
        {mode === 'register' && (
          <p className="field-help">密码至少 8 位，并包含大写、小写、数字或特殊字符中的两类。</p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? '正在提交…' : mode === 'login' ? '登录账号' : '创建账号'}
        </Button>
        <div className="auth-switch">
          {mode === 'login' ? '还没有账号？' : '已有账号？'}{' '}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? '注册' : '登录'}
          </button>
        </div>
        <p className="auth-disclaimer">
          继续前请阅读 <Link to="/privacy">隐私与安全说明</Link>。本地访问不代表平台已启用公网服务。
        </p>
      </form>
    </section>
  );
}

function AccountPage({ site }: { site: ReturnType<typeof useSiteData> }) {
  const { session, logout } = useAuth();
  if (!session) return <Navigate to="/auth" replace />;
  return (
    <AccountConsole
      key={session.identity.accountId}
      session={session}
      logout={logout}
      models={site.catalog?.models ?? []}
    />
  );
}

function AccountConsole({
  session,
  logout,
  models,
}: {
  session: Session;
  logout: () => void;
  models: CatalogModel[];
}) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [attempts, setAttempts] = useState<BillingAttempt[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [ledger, setLedger] = useState<Array<Record<string, unknown>>>([]);
  const [currency, setCurrency] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [projectId, setProjectId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [detail, setDetail] = useState<BillingAttempt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadWallets = useCallback(async (): Promise<void> => {
    const result = await api<{ wallets: Wallet[] }>('/api/wallets', { token: session.accessToken });
    setWallets(result.wallets);
    if (
      result.wallets.length > 0 &&
      !result.wallets.some((wallet) => wallet.currency === currency)
    ) {
      setCurrency(result.wallets[0]?.currency ?? '');
    }
  }, [session.accessToken, currency]);

  const filterValues = useCallback(
    (cursor?: string) => {
      const from = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : undefined;
      const to = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : undefined;
      return {
        limit: 50,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
        ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}),
        ...(providerId ? { providerId } : {}),
        ...(modelId ? { modelId } : {}),
        ...(cursor ? { cursor } : {}),
      };
    },
    [fromDate, toDate, projectId, sessionId, providerId, modelId],
  );

  const loadAttempts = useCallback(
    async (cursor?: string): Promise<void> => {
      const result = await api<{ attempts: BillingAttempt[]; nextCursor: string | null }>(
        `/api/billing/attempts${queryString(filterValues(cursor))}`,
        { token: session.accessToken },
      );
      setAttempts((current) => (cursor ? [...current, ...result.attempts] : result.attempts));
      setNextCursor(result.nextCursor);
    },
    [filterValues, session.accessToken],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await Promise.all([loadWallets(), loadAttempts()]);
      setNotice(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, [loadWallets, loadAttempts]);

  const loadedOnceRef = useRef(false);
  useEffect(() => {
    // Mount-once load: refresh identity changes with the filter inputs, but re-fetching on every
    // filter change would duplicate the dedicated filter effects below.
    if (loadedOnceRef.current) return;
    loadedOnceRef.current = true;
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!currency) {
      setLedger([]);
      return;
    }
    let mounted = true;
    void api<{ entries: Array<Record<string, unknown>> }>(
      `/api/wallets/${encodeURIComponent(currency)}/ledger?limit=50`,
      { token: session.accessToken },
    )
      .then((result) => {
        if (mounted) setLedger(result.entries);
      })
      .catch((cause: unknown) => {
        if (mounted) setError(errorText(cause));
      });
    return () => {
      mounted = false;
    };
  }, [currency, session.accessToken, wallets]);

  const applyFilters = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loadAttempts();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const sendVerification = async (): Promise<void> => {
    setError(null);
    try {
      await api('/api/auth/email/verify', {
        method: 'POST',
        body: { email: session.identity.login },
      });
      setNotice('验证邮件已请求。请查看注册邮箱；邮箱投递由部署环境配置。');
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  return (
    <section className="wrap page-wrap account-page">
      <div className="page-title-row">
        <PageTitle
          eyebrow="个人账号"
          title="你的平台账单"
          subtitle="数据由账号服务按当前 access token 限定到本人；桌面端本地用量不会混入平台账本。"
        />
        <Button variant="secondary" onClick={logout}>
          退出登录
        </Button>
      </div>
      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <ErrorPanel message={error} retry={() => void refresh()} />}
      <div className="account-identity">
        <div className="avatar-mark">{session.identity.displayName.slice(0, 1).toUpperCase()}</div>
        <div>
          <strong>{session.identity.displayName}</strong>
          <span>{session.identity.login}</span>
        </div>
        <div className="identity-id">
          <small>账号标识</small>
          <code>{session.identity.accountId}</code>
        </div>
        <div className="identity-verified">
          <span className={statusClass(session.identity.emailVerified ? 'active' : 'maintenance')}>
            {session.identity.emailVerified ? '邮箱已验证' : '邮箱待验证'}
          </span>
          {!session.identity.emailVerified && (
            <button type="button" onClick={() => void sendVerification()}>
              发送验证邮件
            </button>
          )}
        </div>
        <small className="session-note">当前页面会话 · 关闭页面后令牌清除</small>
      </div>

      <div className="section-heading section-heading--compact">
        <div>
          <p className="eyebrow">钱包余额</p>
          <h2>余额按币种分开。</h2>
        </div>
        <Button variant="quiet" onClick={() => void refresh()} disabled={busy}>
          刷新账单
        </Button>
      </div>
      {busy && wallets.length === 0 ? (
        <Spinner label="正在读取你的钱包" />
      ) : wallets.length === 0 ? (
        <Empty
          title="尚无平台钱包"
          detail="首次使用平台托管请求或收到管理员人工账务调整后，服务端会创建对应币种钱包。这里不会显示虚构的免费余额。"
        />
      ) : (
        <div className="wallet-grid">
          {wallets.map((wallet) => (
            <article
              className={`wallet-card ${currency === wallet.currency ? 'wallet-card--selected' : ''}`}
              key={wallet.currency}
            >
              <button
                className="wallet-card__select"
                type="button"
                onClick={() => setCurrency(wallet.currency)}
                aria-label={`查看 ${wallet.currency} 钱包流水`}
              >
                {wallet.currency}
                <span>查看流水 →</span>
              </button>
              <div className="wallet-total">{money(wallet.postedMicros, wallet.currency)}</div>
              <div className="wallet-breakdown">
                <span>
                  冻结 / 待结算<strong>{money(wallet.heldMicros, wallet.currency)}</strong>
                </span>
                <span>
                  可用<strong>{money(wallet.availableMicros, wallet.currency)}</strong>
                </span>
              </div>
              <small>账本更新时间 {dateTime(wallet.asOf)}</small>
            </article>
          ))}
        </div>
      )}

      <div className="section-heading section-heading--compact bills-heading">
        <div>
          <p className="eyebrow">托管请求</p>
          <h2>用量与账单明细</h2>
        </div>
        <span className="section-note">价格按受理时的不可变版本解释</span>
      </div>
      <form className="filter-panel" onSubmit={(event) => void applyFilters(event)}>
        <label className="field">
          <span>开始日期</span>
          <input
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
          />
        </label>
        <label className="field">
          <span>结束日期</span>
          <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </label>
        <label className="field">
          <span>Provider</span>
          <select
            value={providerId}
            onChange={(event) => {
              setProviderId(event.target.value);
              setModelId('');
            }}
          >
            <option value="">所有渠道</option>
            {[...new Map(models.map((model) => [model.providerId, model])).values()].map(
              (model) => (
                <option key={model.providerId} value={model.providerId}>
                  {model.providerId.slice(0, 8)}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="field">
          <span>Model</span>
          <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
            <option value="">所有模型</option>
            {models
              .filter((model) => !providerId || model.providerId === providerId)
              .map((model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.displayName ?? model.canonicalModel ?? model.modelId.slice(0, 8)}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>项目标识</span>
          <input
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="不透明 ID"
            maxLength={200}
          />
        </label>
        <label className="field">
          <span>会话标识</span>
          <input
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            placeholder="不透明 ID"
            maxLength={200}
          />
        </label>
        <Button type="submit" disabled={busy}>
          应用筛选
        </Button>
      </form>
      {busy && attempts.length === 0 ? (
        <Spinner label="正在读取账单" />
      ) : attempts.length === 0 ? (
        <Empty
          title="没有匹配的账单记录"
          detail="调整日期、项目、会话或路由筛选条件后重试。未知或未结算的请求不会被显示为零费用。"
        />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>受理时间</th>
                <th>实际路由</th>
                <th>用量</th>
                <th>预占 / 实扣</th>
                <th>状态</th>
                <th>项目 / 会话</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => (
                <tr key={attempt.attemptId}>
                  <td>
                    {dateTime(attempt.createdAt)}
                    <small className="table-sub">请求 {idShort(attempt.logicalRequestId)}</small>
                  </td>
                  <td>
                    <code>
                      {idShort(attempt.providerModelKey.split('/')[0])} /{' '}
                      {idShort(attempt.providerModelKey.split('/')[1])}
                    </code>
                    <small className="table-sub">
                      价格 v{attempt.priceSnapshot.version} · {attempt.priceVersionId.slice(0, 8)}
                    </small>
                  </td>
                  <td>
                    {attempt.usage ? (
                      <>
                        {attempt.usage.totalInput === null
                          ? '未知'
                          : attempt.usage.totalInput.toLocaleString()}{' '}
                        输入 /{' '}
                        {attempt.usage.totalOutput === null
                          ? '未知'
                          : attempt.usage.totalOutput.toLocaleString()}{' '}
                        输出<small className="table-sub">{attempt.usage.quality}</small>
                      </>
                    ) : (
                      '待结算'
                    )}
                  </td>
                  <td>
                    {money(attempt.reservedMicros, attempt.currency)} /{' '}
                    {money(attempt.finalMicros, attempt.currency)}
                  </td>
                  <td>
                    <span className={statusClass(attempt.status)}>
                      {statusLabel(attempt.status)}
                    </span>
                  </td>
                  <td>
                    {idShort(attempt.projectId)}
                    <small className="table-sub">{idShort(attempt.sessionId)}</small>
                  </td>
                  <td>
                    <button className="table-link" type="button" onClick={() => setDetail(attempt)}>
                      详情 ↗
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <div className="pagination">
          <span>当前显示 {attempts.length} 条</span>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void loadAttempts(nextCursor)
                .catch((cause: unknown) => setError(errorText(cause)))
                .finally(() => setBusy(false));
            }}
          >
            加载更多
          </Button>
        </div>
      )}

      {currency && (
        <>
          <div className="section-heading section-heading--compact ledger-heading">
            <div>
              <p className="eyebrow">不可变钱包流水 · {currency}</p>
              <h2>入账与结算记录</h2>
            </div>
          </div>
          {ledger.length === 0 ? (
            <Empty
              title="没有钱包流水"
              detail="人工调整、冻结、结算、释放和冲正会作为独立流水显示。"
            />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>金额</th>
                    <th>posted 变化</th>
                    <th>原因 / 关联</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((entry) => (
                    <tr key={String(entry['entryId'])}>
                      <td>{dateTime(Number(entry['createdAt']))}</td>
                      <td>
                        {String(entry['type']) === 'adjustment'
                          ? '人工账务调整'
                          : statusLabel(String(entry['type']))}
                      </td>
                      <td>{money(Number(entry['amountMicros']), currency)}</td>
                      <td>{money(Number(entry['postedDeltaMicros']), currency)}</td>
                      <td>
                        {String(entry['reason'] ?? '—')}
                        <small className="table-sub">
                          {idShort(String(entry['attemptId'] ?? ''))}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {detail && <AttemptDialog attempt={detail} close={() => setDetail(null)} />}
    </section>
  );
}

function AttemptDialog({ attempt, close }: { attempt: BillingAttempt; close: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={close}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="attempt-heading"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <div>
            <p className="eyebrow">计费 attempt</p>
            <h2 id="attempt-heading">{attempt.attemptId}</h2>
          </div>
          <button className="modal-close" type="button" onClick={close} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="detail-grid">
          <Detail label="状态">
            <span className={statusClass(attempt.status)}>{statusLabel(attempt.status)}</span>
          </Detail>
          <Detail label="派发状态">{attempt.dispatchState}</Detail>
          <Detail label="实际 Provider / Model">
            <code>{attempt.providerModelKey}</code>
          </Detail>
          <Detail label="请求关联 ID">
            <code>{attempt.logicalRequestId}</code>
          </Detail>
          <Detail label="价格版本">
            {attempt.priceVersionId} · v{attempt.priceSnapshot.version}
          </Detail>
          <Detail label="受理时间">{dateTime(attempt.createdAt)}</Detail>
          <Detail label="项目标识">{attempt.projectId ?? '未提供'}</Detail>
          <Detail label="会话标识">{attempt.sessionId ?? '未提供'}</Detail>
          <Detail label="冻结上限">{money(attempt.reservedMicros, attempt.currency)}</Detail>
          <Detail label="最终费用">{money(attempt.finalMicros, attempt.currency)}</Detail>
        </div>
        <div className="detail-price">
          <h3>受理时价格快照</h3>
          <PriceRows rates={attempt.priceSnapshot.rates} />
          <p className="field-help">
            生效于 {dateTime(attempt.priceSnapshot.effectiveFrom)} ·{' '}
            {attempt.priceSnapshot.currency} · 缓存写价格按完整费率解释。
          </p>
        </div>
        {attempt.costLines && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>计费桶</th>
                  <th>Token</th>
                  <th>单价 / 百万</th>
                  <th>金额</th>
                </tr>
              </thead>
              <tbody>
                {attempt.costLines.map((line) => (
                  <tr key={line.bucket}>
                    <td>{line.bucket}</td>
                    <td>{line.tokens.toLocaleString()}</td>
                    <td>{rate(line.rateMicrosPerMillion)}</td>
                    <td>{money(line.amountMicros, attempt.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {attempt.usage && (
          <p className="detail-foot">
            用量质量：{attempt.usage.quality} · 完整输入 {attempt.usage.totalInput ?? '未知'} · 输出{' '}
            {attempt.usage.totalOutput ?? '未知'}
          </p>
        )}
        <div className="modal__actions">
          <Button variant="secondary" onClick={close}>
            关闭
          </Button>
        </div>
      </section>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

type AdminTab = 'channels' | 'models' | 'pricing' | 'wallet' | 'reconciliation' | 'audit';

function AdminPage({ site }: { site: ReturnType<typeof useSiteData> }) {
  const { session } = useAuth();
  if (!session) return <Navigate to="/auth" replace />;
  return <AdminConsole session={session} site={site} />;
}

function AdminConsole({
  session,
  site,
}: {
  session: Session;
  site: ReturnType<typeof useSiteData>;
}) {
  const [tab, setTab] = useState<AdminTab>('channels');
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const token = session.accessToken;
  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const [providerResult, modelResult] = await Promise.all([
        api<{ providers: AdminProvider[] }>('/api/admin/catalog/providers', { token }),
        api<{ models: AdminModel[] }>('/api/admin/catalog/models', { token }),
      ]);
      setProviders(providerResult.providers);
      setModels(modelResult.models);
      setForbidden(false);
    } catch (cause) {
      setForbidden(cause instanceof ApiError && cause.status === 403);
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  if (busy && providers.length === 0 && !error)
    return (
      <section className="wrap page-wrap">
        <PageTitle
          eyebrow="平台运营"
          title="管理员控制台"
          subtitle="管理员身份只由服务端 allowlist 判定。"
        />
        <Spinner label="正在验证平台管理员权限" />
      </section>
    );
  if (forbidden)
    return (
      <section className="wrap page-wrap">
        <PageTitle eyebrow="平台运营" title="管理员控制台" subtitle="该账号没有平台管理员权限。" />
        <Alert>服务端返回 403：普通用户不能查看或调用渠道管理、价格发布和账务调整接口。</Alert>
        <Link className="button button--secondary" to="/account">
          返回用户中心
        </Link>
      </section>
    );

  const tabs: Array<{ id: AdminTab; label: string }> = [
    { id: 'channels', label: '渠道' },
    { id: 'models', label: '模型' },
    { id: 'pricing', label: '价格' },
    { id: 'wallet', label: '人工账务' },
    { id: 'reconciliation', label: '待对账' },
    { id: 'audit', label: '审计' },
  ];
  return (
    <section className="wrap page-wrap admin-page">
      <PageTitle
        eyebrow="平台运营 · 服务端 allowlist"
        title="管理员控制台"
        subtitle="所有改价、渠道变更和人工额度调整均调用真实服务端 API，并写入审计。没有支付商户或测试充值入口。"
      />
      {error && <ErrorPanel message={error} retry={() => void load()} />}
      {notice && <Alert tone="success">{notice}</Alert>}
      <div className="admin-console">
        <aside className="admin-tabs" aria-label="管理功能">
          {tabs.map((item) => (
            <button
              type="button"
              key={item.id}
              className={tab === item.id ? 'admin-tabs__active' : ''}
              onClick={() => {
                setTab(item.id);
                setNotice(null);
              }}
            >
              {item.label}
              <span>
                {item.id === 'channels'
                  ? providers.length
                  : item.id === 'models'
                    ? models.length
                    : ''}
              </span>
            </button>
          ))}
        </aside>
        <div className="admin-content">
          {tab === 'channels' && (
            <ProviderManager
              token={token}
              providers={providers}
              reload={load}
              onNotice={setNotice}
            />
          )}
          {tab === 'models' && (
            <ModelManager
              token={token}
              providers={providers}
              models={models}
              reload={load}
              onNotice={setNotice}
            />
          )}
          {tab === 'pricing' && (
            <PricingManager
              token={token}
              providers={providers}
              models={models}
              publicModels={site.catalog?.models ?? []}
              reload={async () => {
                await load();
                await site.refresh();
              }}
              onNotice={setNotice}
            />
          )}
          {tab === 'wallet' && <ManualLedger token={token} onNotice={setNotice} />}
          {tab === 'reconciliation' && <Reconciliation token={token} onNotice={setNotice} />}
          {tab === 'audit' && <AuditLog token={token} />}
        </div>
      </div>
    </section>
  );
}

function ProviderManager({
  token,
  providers,
  reload,
  onNotice,
}: {
  token: string;
  providers: AdminProvider[];
  reload: () => Promise<void>;
  onNotice: (value: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    onNotice(null);
    try {
      await api('/api/admin/catalog/providers', {
        token,
        method: 'POST',
        body: {
          displayName: name,
          protocol,
          baseUrl,
          credentialRef: credentialRef || null,
          status: 'maintenance',
          statusReason: '新渠道待管理员验证后启用',
        },
      });
      setName('');
      setBaseUrl('');
      setCredentialRef('');
      await reload();
      onNotice('渠道已创建并置于维护状态；添加模型和可结算价格后再启用。');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const changeStatus = async (provider: AdminProvider): Promise<void> => {
    const next = provider.status === 'active' ? 'maintenance' : 'active';
    if (next === 'active' && !provider.credentialConfigured) {
      setError('该渠道没有服务端凭据引用，不能启用。');
      return;
    }
    if (
      !window.confirm(
        `确认将「${provider.displayName}」设为${next === 'active' ? '可用' : '维护中'}？`,
      )
    )
      return;
    setError(null);
    try {
      await api(`/api/admin/catalog/providers/${provider.providerId}`, {
        token,
        method: 'PATCH',
        body: { status: next, statusReason: next === 'maintenance' ? '管理员维护' : null },
      });
      await reload();
      onNotice('渠道状态已更新并记录审计。');
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  return (
    <div className="admin-pane">
      <div className="admin-pane__heading">
        <div>
          <p className="eyebrow">平台上游</p>
          <h2>Provider 渠道</h2>
          <p>公开目录不会回传上游地址、凭据引用或密钥。</p>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="provider-table">
        {providers.length === 0 ? (
          <Empty
            title="还没有 Provider"
            detail="先创建维护中的渠道，再添加模型并核验服务端配置。"
          />
        ) : (
          providers.map((provider) => (
            <article className="provider-row" key={provider.providerId}>
              <div className="provider-row__name">
                <strong>{provider.displayName}</strong>
                <span>
                  {provider.protocol} · {idShort(provider.providerId)}
                </span>
              </div>
              <span className={statusClass(provider.status)}>{statusLabel(provider.status)}</span>
              <div className="credential-state">
                <strong>
                  {provider.credentialConfigured ? '已登记服务端凭据引用' : '未登记凭据引用'}
                </strong>
                <small>
                  {provider.credentialRotatedAt
                    ? `引用最近变更于 ${dateTime(provider.credentialRotatedAt)}`
                    : '未记录引用变更时间'}
                </small>
              </div>
              <Button variant="secondary" onClick={() => void changeStatus(provider)}>
                {provider.status === 'active' ? '转为维护' : '启用渠道'}
              </Button>
            </article>
          ))
        )}
      </div>
      <form className="form-panel" onSubmit={(event) => void create(event)}>
        <h3>新增渠道</h3>
        <div className="form-grid">
          <label className="field">
            <span>展示名称</span>
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
            />
          </label>
          <label className="field">
            <span>协议</span>
            <select
              value={protocol}
              onChange={(event) => setProtocol(event.target.value as 'openai' | 'anthropic')}
            >
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="field field--wide">
            <span>上游基础地址 · HTTPS</span>
            <input
              type="url"
              required
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://provider.example/v1"
            />
          </label>
          <label className="field field--wide">
            <span>服务端凭据引用</span>
            <input
              value={credentialRef}
              onChange={(event) => setCredentialRef(event.target.value)}
              placeholder="env:PROVIDER_KEY 或 secret://provider/key"
              autoComplete="off"
            />
          </label>
        </div>
        <p className="field-help">
          只填写服务端 env:/secret:// 引用名，不要粘贴原始密钥。新渠道以维护状态创建。
        </p>
        <Button type="submit" disabled={busy}>
          {busy ? '正在创建…' : '创建 Provider'}
        </Button>
      </form>
    </div>
  );
}

function ModelManager({
  token,
  providers,
  models,
  reload,
  onNotice,
}: {
  token: string;
  providers: AdminProvider[];
  models: AdminModel[];
  reload: () => Promise<void>;
  onNotice: (value: string | null) => void;
}) {
  const [providerId, setProviderId] = useState(providers[0]?.providerId ?? '');
  const [displayName, setDisplayName] = useState('');
  const [upstreamName, setUpstreamName] = useState('');
  const [canonicalVendor, setCanonicalVendor] = useState('');
  const [canonicalModel, setCanonicalModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    onNotice(null);
    try {
      await api(`/api/admin/catalog/providers/${providerId}/models`, {
        token,
        method: 'POST',
        body: {
          displayName,
          upstreamModelName: upstreamName,
          canonicalVendor: canonicalVendor || null,
          canonicalModel: canonicalModel || null,
          status: 'active',
        },
      });
      setDisplayName('');
      setUpstreamName('');
      setCanonicalVendor('');
      setCanonicalModel('');
      await reload();
      onNotice('模型已加入目录。官方身份未知时不使用其他模型的价格作为估算。');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (model: AdminModel): Promise<void> => {
    const next = model.status === 'active' ? 'disabled' : 'active';
    if (
      !window.confirm(
        `确认${next === 'active' ? '启用' : '停用'}「${model.displayName ?? model.modelId}」？`,
      )
    )
      return;
    try {
      await api(`/api/admin/catalog/providers/${model.providerId}/models/${model.modelId}`, {
        token,
        method: 'PATCH',
        body: { status: next },
      });
      await reload();
      onNotice('模型状态已更新并记录审计。');
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  return (
    <div className="admin-pane">
      <div className="admin-pane__heading">
        <div>
          <p className="eyebrow">精确模型身份</p>
          <h2>Provider 模型</h2>
          <p>同名模型在不同渠道有独立路由、能力和价格。</p>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="provider-table">
        {models.length === 0 ? (
          <Empty title="还没有模型" detail="选择渠道并创建目录模型。" />
        ) : (
          models.map((model) => (
            <article className="provider-row" key={`${model.providerId}/${model.modelId}`}>
              <div className="provider-row__name">
                <strong>{model.displayName ?? model.canonicalModel}</strong>
                <span>
                  {providers.find((provider) => provider.providerId === model.providerId)
                    ?.displayName ?? idShort(model.providerId)}{' '}
                  · {idShort(model.modelId)}
                </span>
              </div>
              <span className={statusClass(model.status)}>{statusLabel(model.status)}</span>
              <div className="credential-state">
                <strong>
                  {model.canonicalVendor && model.canonicalModel
                    ? `${model.canonicalVendor}/${model.canonicalModel}`
                    : '官方身份未核验'}
                </strong>
                <small>上游模型名：{model.upstreamModelName}</small>
              </div>
              <Button variant="secondary" onClick={() => void toggle(model)}>
                {model.status === 'active' ? '停用模型' : '启用模型'}
              </Button>
            </article>
          ))
        )}
      </div>
      <form className="form-panel" onSubmit={(event) => void create(event)}>
        <h3>新增模型</h3>
        <div className="form-grid">
          <label className="field field--wide">
            <span>所属 Provider</span>
            <select
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              required
            >
              {providers.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.displayName} · {provider.protocol}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>目录展示名</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              maxLength={120}
            />
          </label>
          <label className="field">
            <span>上游模型标识</span>
            <input
              value={upstreamName}
              onChange={(event) => setUpstreamName(event.target.value)}
              required
              maxLength={200}
            />
          </label>
          <label className="field">
            <span>官方厂商身份（可空）</span>
            <input
              value={canonicalVendor}
              onChange={(event) => setCanonicalVendor(event.target.value)}
              maxLength={120}
            />
          </label>
          <label className="field">
            <span>官方模型身份（可空）</span>
            <input
              value={canonicalModel}
              onChange={(event) => setCanonicalModel(event.target.value)}
              maxLength={200}
            />
          </label>
        </div>
        <p className="field-help">
          只有完全匹配的 canonical 身份才允许关联官方价格证据；不要按名称相似度猜测。
        </p>
        <Button type="submit" disabled={busy || providers.length === 0}>
          {busy ? '正在创建…' : '创建模型'}
        </Button>
      </form>
    </div>
  );
}

function PricingManager({
  token,
  providers,
  models,
  publicModels,
  reload,
  onNotice,
}: {
  token: string;
  providers: AdminProvider[];
  models: AdminModel[];
  publicModels: CatalogModel[];
  reload: () => Promise<void>;
  onNotice: (value: string | null) => void;
}) {
  const [routeKey, setRouteKey] = useState(
    models[0] ? `${models[0].providerId}/${models[0].modelId}` : '',
  );
  const [currency, setCurrency] = useState('');
  const [uncachedInput, setUncachedInput] = useState('');
  const [cacheRead, setCacheRead] = useState('');
  const [cacheWrite, setCacheWrite] = useState('');
  const [output, setOutput] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() =>
    new Date(Date.now() + 60 * 60_000).toISOString().slice(0, 16),
  );
  const [sourceUrl, setSourceUrl] = useState('');
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [prices, setPrices] = useState<PriceVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [officialVendor, setOfficialVendor] = useState('');
  const [officialModel, setOfficialModel] = useState('');
  const [officialEvidence, setOfficialEvidence] = useState('');
  const [officialVersion, setOfficialVersion] = useState('');
  const [officialConditions, setOfficialConditions] = useState('');
  const selected = models.find((model) => `${model.providerId}/${model.modelId}` === routeKey);
  const publicIdentity = publicModels.find(
    (model) => `${model.providerId}/${model.modelId}` === routeKey,
  );
  const payload = (future = false): Record<string, unknown> => {
    const rates: PriceRates = {
      uncachedInput: parseRate(uncachedInput),
      cacheRead: parseRate(cacheRead),
      cacheWriteByTtl: cacheWrite === '' ? null : { default: parseRate(cacheWrite) },
      output: parseRate(output),
    };
    const from = new Date(effectiveFrom).getTime();
    return {
      currency: currency.toUpperCase(),
      rates,
      sourceUrl: sourceUrl || null,
      verifiedAt: sourceUrl ? Date.now() : null,
      effectiveFrom: future ? from : from,
    };
  };
  const selectedProviderId = selected?.providerId;
  const selectedModelId = selected?.modelId;
  useEffect(() => {
    if (!selectedProviderId || !selectedModelId) {
      setPrices([]);
      return;
    }
    let mounted = true;
    void api<{ prices: PriceVersion[] }>(
      `/api/admin/catalog/providers/${selectedProviderId}/models/${selectedModelId}/prices`,
      { token },
    )
      .then((result) => {
        if (mounted) setPrices(result.prices);
      })
      .catch((cause: unknown) => {
        if (mounted) setError(errorText(cause));
      });
    return () => {
      mounted = false;
    };
  }, [selectedProviderId, selectedModelId, token]);
  const previewPrice = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setPreview(null);
    onNotice(null);
    if (!selected) {
      setBusy(false);
      return;
    }
    try {
      const result = await api<Record<string, unknown>>(
        `/api/admin/catalog/providers/${selected.providerId}/models/${selected.modelId}/prices/preview`,
        { token, method: 'POST', body: payload() },
      );
      setPreview(result);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const publish = async (): Promise<void> => {
    if (!selected || !preview) return;
    if (
      !window.confirm(
        `确认发布 ${currency.toUpperCase()} ${selected.displayName} 的新价格版本？历史账单不会重算。`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api(
        `/api/admin/catalog/providers/${selected.providerId}/models/${selected.modelId}/prices`,
        { token, method: 'POST', body: payload() },
      );
      setPreview(null);
      setPrices(
        (
          await api<{ prices: PriceVersion[] }>(
            `/api/admin/catalog/providers/${selected.providerId}/models/${selected.modelId}/prices`,
            { token },
          )
        ).prices,
      );
      await reload();
      onNotice('新价格版本已追加并生效；历史 attempt 仍保留受理时的价格快照。');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const createOfficial = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    onNotice(null);
    try {
      const rates: PriceRates = {
        uncachedInput: parseRate(uncachedInput),
        cacheRead: parseRate(cacheRead),
        cacheWriteByTtl: cacheWrite === '' ? null : { default: parseRate(cacheWrite) },
        output: parseRate(output),
      };
      const from = new Date(effectiveFrom).getTime();
      await api('/api/admin/catalog/official-prices', {
        token,
        method: 'POST',
        body: {
          canonicalVendor: officialVendor,
          canonicalModel: officialModel,
          currency: currency.toUpperCase(),
          rates,
          sourceUrl,
          verifiedAt: Date.now(),
          evidenceVersion: officialVersion,
          evidenceSnapshot: officialEvidence,
          conditions: officialConditions,
          effectiveFrom: from,
        },
      });
      await reload();
      onNotice('官方价格证据已记录。请确保来源、版本、单位与适用条件已人工核验。');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="admin-pane">
      <div className="admin-pane__heading">
        <div>
          <p className="eyebrow">append-only 价格版本</p>
          <h2>Provider + Model 定价</h2>
          <p>空值表示未知，0 才表示免费；发布后不可修改，历史账单不重算。</p>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      <label className="field route-select">
        <span>精确路由</span>
        <select
          value={routeKey}
          onChange={(event) => {
            setRouteKey(event.target.value);
            setPreview(null);
          }}
        >
          {models.map((model) => (
            <option key={model.modelId} value={`${model.providerId}/${model.modelId}`}>
              {providers.find((provider) => provider.providerId === model.providerId)
                ?.displayName ?? model.providerId.slice(0, 8)}{' '}
              / {model.displayName}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <div className="price-history">
          <strong>{selected.displayName}</strong>
          {prices.length === 0 ? (
            <span className="status status--warning">尚无已发布价格</span>
          ) : (
            prices.map((item) => (
              <span key={item.priceVersionId} className="price-history__item">
                v{item.version} · {item.currency} · {dateTime(item.effectiveFrom)}
              </span>
            ))
          )}
        </div>
      )}
      <form className="form-panel" onSubmit={(event) => void previewPrice(event)}>
        <h3>预览平台售价变更</h3>
        <div className="form-grid">
          <label className="field">
            <span>币种（ISO 4217）</span>
            <input
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              required
              minLength={3}
              maxLength={3}
              placeholder="例如 USD"
            />
          </label>
          <label className="field">
            <span>生效时间</span>
            <input
              type="datetime-local"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              required
            />
          </label>
          <RateField
            label="普通输入费率 · 微单位/百万 Token"
            value={uncachedInput}
            onChange={setUncachedInput}
          />
          <RateField
            label="缓存读取费率 · 微单位/百万 Token"
            value={cacheRead}
            onChange={setCacheRead}
          />
          <RateField
            label="缓存写入费率（default TTL）"
            value={cacheWrite}
            onChange={setCacheWrite}
          />
          <RateField label="输出费率 · 微单位/百万 Token" value={output} onChange={setOutput} />
          <label className="field field--wide">
            <span>价格依据 URL（可空）</span>
            <input
              type="url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="https://…"
            />
          </label>
        </div>
        <p className="field-help">
          平台费率不能自动从官网复制；仅填写你已核对并有权发布的售卖价格。缓存写费率按完整费率计算。
        </p>
        <Button type="submit" disabled={busy || !selected}>
          {busy ? '正在预览…' : '预览价格变化'}
        </Button>
      </form>
      {preview && (
        <div className="preview-panel">
          <div>
            <span className="eyebrow">价格影响预览</span>
            <h3>发布前请检查变化</h3>
          </div>
          <pre>{JSON.stringify(preview['impact'], null, 2)}</pre>
          <p>
            {String(preview['note'] ?? '')} · 生效时间 {dateTime(Number(preview['effectiveFrom']))}
          </p>
          <Button disabled={busy} onClick={() => void publish()}>
            发布不可变版本
          </Button>
        </div>
      )}
      <details className="form-panel official-form">
        <summary>登记官方价格证据（需要精确身份匹配）</summary>
        <p className="field-help">
          保存的是官方价格参考，不直接改变平台售价。来源和价格数据由管理员人工核验。
        </p>
        <form onSubmit={(event) => void createOfficial(event)}>
          <div className="form-grid">
            <label className="field">
              <span>Canonical vendor</span>
              <input
                value={officialVendor || publicIdentity?.canonicalVendor || ''}
                onChange={(event) => setOfficialVendor(event.target.value)}
                required
                maxLength={120}
              />
            </label>
            <label className="field">
              <span>Canonical model</span>
              <input
                value={officialModel || publicIdentity?.canonicalModel || ''}
                onChange={(event) => setOfficialModel(event.target.value)}
                required
                maxLength={200}
              />
            </label>
            <label className="field">
              <span>证据版本</span>
              <input
                value={officialVersion}
                onChange={(event) => setOfficialVersion(event.target.value)}
                required
                maxLength={200}
              />
            </label>
            <label className="field">
              <span>官方来源 URL</span>
              <input
                type="url"
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                required
              />
            </label>
            <label className="field field--wide">
              <span>适用条件</span>
              <input
                value={officialConditions}
                onChange={(event) => setOfficialConditions(event.target.value)}
                required
                maxLength={2000}
              />
            </label>
            <label className="field field--wide">
              <span>已核验的价格证据摘要</span>
              <textarea
                value={officialEvidence}
                onChange={(event) => setOfficialEvidence(event.target.value)}
                required
                maxLength={16000}
                rows={4}
              />
            </label>
          </div>
          <Button type="submit" disabled={busy}>
            保存官方价格证据
          </Button>
        </form>
      </details>
    </div>
  );
}

function parseRate(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('费率须为非负整数微单位。');
  return parsed;
}

function RateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min="0"
        step="1"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="留空 = 未定价"
      />
    </label>
  );
}

function ManualLedger({
  token,
  onNotice,
}: {
  token: string;
  onNotice: (value: string | null) => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [currency, setCurrency] = useState('');
  const [amountMicros, setAmountMicros] = useState('');
  const [reason, setReason] = useState('');
  const [accountName, setAccountName] = useState<string | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lookUp = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    onNotice(null);
    setWallet(null);
    setAccountName(null);
    try {
      const [account, result] = await Promise.all([
        api<{ account: { displayName: string } }>(
          `/api/admin/accounts/${encodeURIComponent(accountId)}`,
          { token },
        ),
        api<{ wallet: Wallet }>(
          `/api/admin/wallets/${encodeURIComponent(accountId)}/${currency.toUpperCase()}`,
          { token },
        ),
      ]);
      setAccountName(account.account.displayName);
      setWallet(result.wallet);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const adjust = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const amount = Number(amountMicros);
    if (!Number.isSafeInteger(amount) || amount === 0) {
      setError('金额必须是非零的安全整数微单位。');
      return;
    }
    if (!window.confirm('这会追加一条不可变的人工账务调整流水，不会模拟支付或充值。确认继续？'))
      return;
    setBusy(true);
    setError(null);
    onNotice(null);
    try {
      await api(`/api/admin/wallets/${encodeURIComponent(accountId)}/adjustments`, {
        token,
        method: 'POST',
        idempotencyKey: crypto.randomUUID(),
        body: { currency: currency.toUpperCase(), amountMicros: amount, reason },
      });
      const result = await api<{ wallet: Wallet }>(
        `/api/admin/wallets/${encodeURIComponent(accountId)}/${currency.toUpperCase()}`,
        { token },
      );
      setWallet(result.wallet);
      setAmountMicros('');
      setReason('');
      onNotice('人工账务调整已写入账本并留下管理员审计记录。');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="admin-pane">
      <div className="admin-pane__heading">
        <div>
          <p className="eyebrow">仅人工账务操作</p>
          <h2>额度调整</h2>
          <p>不接入在线充值；每次调整都需要原因、幂等键和二次确认。</p>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      <form className="form-panel" onSubmit={(event) => void lookUp(event)}>
        <h3>查找目标账号</h3>
        <div className="form-grid">
          <label className="field field--wide">
            <span>账号 ID</span>
            <input
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              required
              maxLength={128}
              placeholder="由用户中心复制账号标识"
            />
          </label>
          <label className="field">
            <span>钱包币种</span>
            <input
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              required
              minLength={3}
              maxLength={3}
              placeholder="ISO 4217"
            />
          </label>
          <div className="field field--action">
            <span>账号核验</span>
            <Button type="submit" variant="secondary" disabled={busy}>
              读取钱包
            </Button>
          </div>
        </div>
      </form>
      {wallet && (
        <>
          <div className="target-account">
            <strong>{accountName}</strong>
            <code>{accountId}</code>
            <span>{currency.toUpperCase()}</span>
          </div>
          <div className="wallet-breakdown wallet-breakdown--admin">
            <span>
              账面<strong>{money(wallet.postedMicros, wallet.currency)}</strong>
            </span>
            <span>
              冻结<strong>{money(wallet.heldMicros, wallet.currency)}</strong>
            </span>
            <span>
              可用<strong>{money(wallet.availableMicros, wallet.currency)}</strong>
            </span>
          </div>
          <form className="form-panel adjustment-form" onSubmit={(event) => void adjust(event)}>
            <h3>追加人工账务调整</h3>
            <div className="form-grid">
              <label className="field">
                <span>金额 · 微单位</span>
                <input
                  type="number"
                  step="1"
                  value={amountMicros}
                  onChange={(event) => setAmountMicros(event.target.value)}
                  placeholder="正数入账，负数扣减"
                  required
                />
              </label>
              <label className="field field--wide">
                <span>调整原因（必填）</span>
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  minLength={3}
                  maxLength={500}
                  rows={3}
                  required
                />
              </label>
            </div>
            <p className="field-help">
              该操作在服务端账本内原子执行；账面不足时扣减会被拒绝。流水不可编辑、不可删除。
            </p>
            <Button type="submit" variant="danger" disabled={busy}>
              记录人工调整
            </Button>
          </form>
        </>
      )}
    </div>
  );
}

function Reconciliation({
  token,
  onNotice,
}: {
  token: string;
  onNotice: (value: string | null) => void;
}) {
  const [cases, setCases] = useState<ReconciliationCase[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ cases: ReconciliationCase[] }>(
        '/api/admin/billing/reconciliation?limit=100',
        { token },
      );
      setCases(result.cases);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);
  const resolve = async (item: ReconciliationCase): Promise<void> => {
    const reason = window.prompt('仅当已确认上游未执行时，输入对账说明。服务端会释放冻结余额。');
    if (reason === null) return;
    if (reason.trim().length < 3) {
      setError('对账说明至少 3 个字符。');
      return;
    }
    if (!window.confirm('确认已核实上游没有执行此请求？')) return;
    try {
      await api(`/api/admin/billing/reconciliation/${item.attemptId}/resolve`, {
        token,
        method: 'POST',
        body: { outcome: 'no_upstream_execution', reason },
      });
      await load();
      onNotice('待对账项已按管理员核验结果处理并审计。');
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  return (
    <div className="admin-pane">
      <div className="admin-pane__heading">
        <div>
          <p className="eyebrow">不确定的上游执行状态</p>
          <h2>待人工对账</h2>
          <p>未知状态会保留冻结，不会自动释放或重发收费请求。</p>
        </div>
        <Button variant="quiet" onClick={() => void load()}>
          刷新
        </Button>
      </div>
      {error && <ErrorPanel message={error} retry={() => void load()} />}
      {busy ? (
        <Spinner label="正在读取对账队列" />
      ) : cases.length === 0 ? (
        <Empty title="没有待处理对账项" detail="未知 usage、断流和服务异常将在这里等待人工处理。" />
      ) : (
        <div className="recon-list">
          {cases.map((item) => (
            <article className="recon-card" key={item.attemptId}>
              <div className="recon-card__top">
                <span className="status status--warning">{statusLabel(item.status)}</span>
                <span>截止 {dateTime(item.dueAt)}</span>
              </div>
              <h3>{item.reason}</h3>
              <p>
                <code>{item.attemptId}</code>
              </p>
              <div className="recon-meta">
                <span>账号 {idShort(item.accountId)}</span>
                <span>路由 {idShort(item.providerModelKey)}</span>
                <span>冻结上限 {money(item.reserveMicros, item.currency)}</span>
                <span>创建 {dateTime(item.createdAt)}</span>
              </div>
              <Button variant="secondary" onClick={() => void resolve(item)}>
                确认未执行并释放冻结
              </Button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function AuditLog({ token }: { token: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (next?: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const result = await api<{ events: AuditEvent[]; nextCursor: string | null }>(
          `/api/admin/audit${queryString({ limit: 50, cursor: next })}`,
          { token },
        );
        setEvents((current) => (next ? [...current, ...result.events] : result.events));
        setCursor(result.nextCursor);
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setBusy(false);
      }
    },
    [token],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="admin-pane">
      <div className="admin-pane__heading">
        <div>
          <p className="eyebrow">服务端审计</p>
          <h2>管理与账务事件</h2>
          <p>渠道发布、人工额度调整与对账操作按时间倒序展示。</p>
        </div>
        <Button variant="quiet" onClick={() => void load()}>
          刷新
        </Button>
      </div>
      {error && <ErrorPanel message={error} retry={() => void load()} />}
      {busy && events.length === 0 ? (
        <Spinner label="正在读取审计记录" />
      ) : events.length === 0 ? (
        <Empty title="暂无审计记录" detail="平台目录管理和人工账务操作会写入服务端审计。" />
      ) : (
        <div className="audit-list">
          {events.map((event) => (
            <article className="audit-item" key={event.id}>
              <div>
                <strong>{event.action}</strong>
                <span>{dateTime(event.createdAt)}</span>
              </div>
              <p>{event.detail ?? event.reason ?? '审计事件'}</p>
              {event.targetAccountId && <small>目标账号 {idShort(event.targetAccountId)}</small>}
              {event.attemptId && <small>Attempt {event.attemptId}</small>}
              {event.details !== null && (
                <details>
                  <summary>事件详情</summary>
                  <pre>{JSON.stringify(event.details, null, 2)}</pre>
                </details>
              )}
            </article>
          ))}
        </div>
      )}
      {cursor && (
        <div className="pagination">
          <span>已载入 {events.length} 条</span>
          <Button variant="secondary" disabled={busy} onClick={() => void load(cursor)}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}

function ErrorPanel({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="error-panel">
      <div>
        <strong>请求没有完成</strong>
        <p>{message}</p>
      </div>
      <Button variant="secondary" onClick={retry}>
        重试
      </Button>
    </div>
  );
}

function PageTitle({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="page-title">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
  );
}

function NotFound() {
  return (
    <section className="wrap page-wrap">
      <PageTitle
        eyebrow="404"
        title="这页暂时不存在。"
        subtitle="确认链接后回到 EveryoneCoding 首页。"
      />
      <Link className="button button--primary" to="/">
        返回首页
      </Link>
    </section>
  );
}
