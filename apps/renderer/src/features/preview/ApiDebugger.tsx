import * as React from 'react';
import { Button } from '@ec/ui';
import { DATA_SOURCE_LABELS } from '@ec/preview';

import { usePreviewApi, type ApiRequestLog } from './preview-api';

/**
 * T6-06 API 调试器：请求日志 / 重放 / 复制 cURL。
 *
 * 数据来自端口 `requests()`（预览 iframe 经 postMessage 上报的请求）。失败请求
 * （errorMessage 非空或 status ≥ 400）高亮；「复制为 cURL」写入 navigator.clipboard。
 */
function isFailed(log: ApiRequestLog): boolean {
  return log.errorMessage !== null || log.status >= 400;
}

export function ApiDebugger(): JSX.Element {
  const api = usePreviewApi();
  const [requests, setRequests] = React.useState<readonly ApiRequestLog[]>([]);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [replaying, setReplaying] = React.useState<string | null>(null);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    void api.requests().then(setRequests);
  }, [api]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const handleReplay = (log: ApiRequestLog): void => {
    if (replaying !== null) return;
    setReplaying(log.id);
    void api
      .replayRequest({ id: log.id })
      .then(() => reload())
      .finally(() => setReplaying(null));
  };

  const handleCopy = async (log: ApiRequestLog): Promise<void> => {
    const curl = await api.toCurl({ id: log.id });
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(curl);
    }
    setCopiedId(log.id);
  };

  return (
    <section className="ec-api-debugger" aria-label="API 调试器">
      <header className="ec-api-debugger__header">
        <h3>API 调试器</h3>
        <Button size="sm" variant="ghost" onClick={() => void api.clearRequests().then(reload)}>
          清空
        </Button>
      </header>

      {requests.length === 0 ? (
        <p className="ec-api-debugger__empty">暂无请求记录</p>
      ) : (
        <ul className="ec-api-debugger__list" role="list">
          {requests.map((log) => {
            const failed = isFailed(log);
            const expanded = expandedId === log.id;
            return (
              <li
                key={log.id}
                className={failed ? 'ec-api-debugger__row ec-api-debugger__row--failed' : 'ec-api-debugger__row'}
                data-testid="api-row"
              >
                <button
                  type="button"
                  className="ec-api-debugger__summary"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : log.id)}
                >
                  <span className="ec-api-debugger__method">{log.method}</span>
                  <span className="ec-api-debugger__url">{log.url}</span>
                  <span className={failed ? 'ec-api-debugger__status ec-api-debugger__status--fail' : 'ec-api-debugger__status'}>
                    {log.status}
                  </span>
                  <span className="ec-api-debugger__duration">{log.durationMs}ms</span>
                  <span className="ec-api-debugger__source">{DATA_SOURCE_LABELS[log.source]}</span>
                </button>

                {expanded && (
                  <div className="ec-api-debugger__detail">
                    {log.requestBody !== null && (
                      <pre className="ec-api-debugger__body" data-testid="request-body">
                        {log.requestBody}
                      </pre>
                    )}
                    <pre className="ec-api-debugger__body" data-testid="response-body">
                      {log.responseBody}
                    </pre>
                    {log.errorMessage !== null && (
                      <p className="ec-api-debugger__error" role="alert">
                        {log.errorMessage}
                      </p>
                    )}
                    <div className="ec-api-debugger__row-actions">
                      <Button size="sm" loading={replaying === log.id} onClick={() => handleReplay(log)}>
                        重放
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void handleCopy(log)}>
                        {copiedId === log.id ? '已复制' : '复制为 cURL'}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
