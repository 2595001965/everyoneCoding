import * as React from 'react';

import { usePreviewApi, type ApiRequestLog } from './preview-api';
import { PreviewToolbar } from './PreviewToolbar';
import { PreviewFrame } from './PreviewFrame';
import { BackendPanel } from './BackendPanel';
import { ApiDebugger } from './ApiDebugger';
import { DevicePreview } from './DevicePreview';

/**
 * 预览工作台：组装工具栏、预览帧、后端托管、API 调试器、多端预览。
 * 作为可复用面板导出（不改动路由）。
 */
export function PreviewWorkspace(): JSX.Element {
  const api = usePreviewApi();
  const [url, setUrl] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<'static' | 'linked' | 'device'>('static');
  const [pages, setPages] = React.useState<readonly { route: string; name: string }[]>([]);
  const [route, setRoute] = React.useState<string>('');

  const reload = React.useCallback(() => {
    void api.state().then((s) => {
      setUrl(s.url);
      setMode(s.mode);
    });
    void api.pages().then((p) => {
      setPages(p);
      setRoute((cur) => (cur === '' && p.length > 0 ? p[0]?.route ?? '' : cur));
    });
  }, [api]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const handleRequest = React.useCallback((_log: ApiRequestLog): void => {
    // 预览页经 postMessage 上报的请求由外壳聚合进 requests()；
    // 这里仅做占位（真实环境外壳统一写入端口，不再重复维护本地状态）
  }, []);

  const handleElementClick = React.useCallback((_payload: { elementId: string }): void => {
    // 元素点击联动导航跳转由 NavWorkspace 消费；此处占位
  }, []);

  const src = url === null ? 'about:blank' : `${url}${route}`;

  return (
    <div className="ec-preview-workspace">
      <PreviewToolbar />
      {pages.length > 0 && (
        <div className="ec-preview-workspace__routes" role="tablist" aria-label="页面路由">
          {pages.map((page) => (
            <button
              key={page.route}
              type="button"
              role="tab"
              aria-selected={route === page.route}
              data-testid={`route-${page.route}`}
              onClick={() => setRoute(page.route)}
            >
              {page.name}
            </button>
          ))}
        </div>
      )}
      <div className="ec-preview-workspace__body">
        <div className="ec-preview-workspace__stage">
          {mode === 'device' ? (
            <DevicePreview />
          ) : (
            <PreviewFrame src={src} onRequest={handleRequest} onElementClick={handleElementClick} />
          )}
        </div>
        <aside className="ec-preview-workspace__side">
          <BackendPanel />
          <ApiDebugger />
        </aside>
      </div>
    </div>
  );
}
