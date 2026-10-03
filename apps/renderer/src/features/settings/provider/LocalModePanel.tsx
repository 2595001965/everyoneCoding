import { useState } from 'react';
import { Tag } from '@ec/ui';

/**
 * 本地模式说明（V2-T03 / V2-MDL-04）。
 *
 * 描述两种独立路由：本地直连（BYOK）与平台目录托管。
 * - 不注册/登录平台即可创建 Provider、配置 Key、测试与生成；
 * - Key 只存本机系统加密存储（主进程 DPAPI），不进渲染层、日志或平台；
 * - 请求由本机 AI 运行时直连用户配置的上游，不经过 EveryoneCoding 平台；
 * - 平台离线、登出、停服或平台余额为零，均不影响本地模型服务的配置与使用。
 *
 */
export function LocalModePanel(props: {
  busy?: boolean;
  onSync?: () => Promise<{ generatedAt: number; providers: number; models: number }>;
}): JSX.Element {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sync = async (): Promise<void> => {
    if (!props.onSync) return;
    setError(null);
    try {
      const result = await props.onSync();
      setStatus(`目录已同步：${result.providers} 个渠道、${result.models} 个模型。到下方用途绑定中选择托管路由即可使用。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <section className="ec-ai__section" aria-label="运行模式">
      <h2 className="ec-ai__section-title">
        运行模式：<Tag color="success">本地直连（BYOK）</Tag>
      </h2>
      <p className="ec-ai__hint">
        本地直连（BYOK）无需平台账号。自建 Provider 的 Key 仅保存在本机系统加密存储，请求由本机直连上游，不经过平台；本地 Key 不会上传。
      </p>
      <p className="ec-ai__hint">
        托管路由由平台账号鉴权，经过 EveryoneCoding 网关并按目录价格预占、结算。平台不可达或余额不足时托管请求会失败；已配置的 BYOK 路由仍可直连使用。登出不会删除或禁用本地 Provider。
      </p>
      <div className="ec-ai__row-actions">
        <button type="button" className="ec-ai__btn" disabled={props.busy || !props.onSync} onClick={() => void sync()}>
          {props.busy ? '同步中…' : '同步平台托管目录'}
        </button>
        <span className="ec-ai__hint">选择目录模型后，在下方“用途绑定”里切换到平台渠道。</span>
      </div>
      {status ? <p className="ec-ai__hint" role="status">{status}</p> : null}
      {error ? <p className="ec-ai__error" role="alert">{error}</p> : null}
    </section>
  );
}
