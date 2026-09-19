import * as React from 'react';
import { Button, SearchInput } from '@ec/ui';

import { usePreviewApi, type ManagedProcess } from './preview-api';
import type { ProjectProfile, StreamedLogLine } from '@ec/preview';

/**
 * T6-06 后端托管面板：项目识别 / 依赖安装 / 启动托管 / 日志流。
 *
 * 不触碰真实进程：全部经 PreviewApi（外壳注入的端口）。未识别到项目类型时提示
 * 可编辑命令映射，而不是抛错。
 */
function logLevelClass(line: StreamedLogLine): string {
  // 兜底：stderr 一律按 error 级着色（与 LogStream.classify 一致）
  if (line.level === 'error' || line.stream === 'stderr') return 'ec-backend-panel__log--error';
  if (line.level === 'warn') return 'ec-backend-panel__log--warn';
  return 'ec-backend-panel__log--info';
}

export function BackendPanel(): JSX.Element {
  const api = usePreviewApi();
  const [profile, setProfile] = React.useState<ProjectProfile | null>(null);
  const [lines, setLines] = React.useState<readonly StreamedLogLine[]>([]);
  const [keyword, setKeyword] = React.useState('');
  const [status, setStatus] = React.useState<{ running: boolean; process: ManagedProcess | null }>({
    running: false,
    process: null,
  });
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(() => {
    void api.projectProfile().then((r) => setProfile(r.ok && r.data !== null ? r.data : null));
    void api.backendStatus().then(setStatus);
  }, [api]);

  const reloadLogs = React.useCallback(() => {
    void api.logs(keyword.trim() === '' ? undefined : { keyword: keyword.trim() }).then(setLines);
  }, [api, keyword]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  React.useEffect(() => {
    reloadLogs();
  }, [reloadLogs]);

  const run = <T,>(fn: () => Promise<T>): void => {
    if (busy) return;
    setBusy(true);
    void fn()
      .then(() => {
        reload();
        reloadLogs();
      })
      .finally(() => setBusy(false));
  };

  const unknown = profile === null || profile.kind === 'unknown' || profile.requiresManualCommand;

  return (
    <section className="ec-backend-panel" aria-label="后端托管">
      <header className="ec-backend-panel__header">
        <h3>后端托管</h3>
        {profile !== null && (
          <span className="ec-backend-panel__kind" data-kind={profile.kind}>
            {profile.label}
          </span>
        )}
      </header>

      {profile !== null && (
        <dl className="ec-backend-panel__meta">
          <div>
            <dt>安装命令</dt>
            <dd>{profile.installCmd ?? '—'}</dd>
          </div>
          <div>
            <dt>启动命令</dt>
            <dd>{profile.startCmd ?? '—'}</dd>
          </div>
          <div>
            <dt>端口提示</dt>
            <dd>{profile.portHint !== null ? String(profile.portHint) : '—'}</dd>
          </div>
          <div>
            <dt>环境变量</dt>
            <dd>{profile.envHints.length > 0 ? profile.envHints.join('、') : '—'}</dd>
          </div>
        </dl>
      )}

      {unknown && (
        <div className="ec-backend-panel__manual" role="status">
          未识别到项目类型，请在设置中编辑命令映射（installCmd / startCmd）。
        </div>
      )}

      <div className="ec-backend-panel__actions">
        <Button
          size="sm"
          disabled={busy || profile?.installCmd === null}
          onClick={() => run(() => api.installDependencies())}
        >
          安装依赖
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || profile?.startCmd === null}
          onClick={() => run(() => api.startBackend())}
        >
          启动
        </Button>
        <Button
          size="sm"
          disabled={busy || !status.running}
          onClick={() => run(() => api.stopBackend())}
        >
          停止
        </Button>
        <Button
          size="sm"
          disabled={busy || profile?.startCmd === null}
          onClick={() => run(() => api.restartBackend())}
        >
          重启
        </Button>
        <span className="ec-backend-panel__status" role="status">
          {status.running && status.process !== null ? `运行中 · ${status.process.url}` : '未运行'}
        </span>
      </div>

      <div className="ec-backend-panel__logs-head">
        <SearchInput
          aria-label="过滤日志关键字"
          placeholder="过滤日志关键字"
          value={keyword}
          onChange={setKeyword}
        />
      </div>
      <div
        className="ec-backend-panel__logs"
        role="log"
        aria-label="后端日志"
        data-testid="backend-logs"
      >
        {lines.length === 0 ? (
          <p className="ec-backend-panel__empty">暂无日志</p>
        ) : (
          lines.map((line) => (
            <div key={line.id} className={`ec-backend-panel__log ${logLevelClass(line)}`}>
              <span className="ec-backend-panel__log-source">{line.source}</span>
              <span className="ec-backend-panel__log-text">{line.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
