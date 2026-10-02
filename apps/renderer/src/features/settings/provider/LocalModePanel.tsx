import { Tag } from '@ec/ui';

/**
 * 本地模式说明（V2-T03 / V2-MDL-04）。
 *
 * 明确当前模型服务运行在「本地直连（BYOK）」模式：
 * - 不注册/登录平台即可创建 Provider、配置 Key、测试与生成；
 * - Key 只存本机系统加密存储（主进程 DPAPI），不进渲染层、日志或平台；
 * - 请求由本机 AI 运行时直连用户配置的上游，不经过 EveryoneCoding 平台；
 * - 平台离线、登出、停服或平台余额为零，均不影响本地模型服务的配置与使用。
 *
 * 平台托管模式（平台 Key/平台计费）由后续版本接入，接入前不提供假开关。
 */
export function LocalModePanel(): JSX.Element {
  return (
    <section className="ec-ai__section" aria-label="运行模式">
      <h2 className="ec-ai__section-title">
        运行模式：<Tag color="success">本地直连（BYOK）</Tag>
      </h2>
      <p className="ec-ai__hint">
        无需注册或登录平台账号即可使用：新增服务、填写 API Key、连接测试与生成都只依赖你配置的
        上游地址。Key 仅保存在本机系统加密存储，请求由本机直连上游，不经过 EveryoneCoding 平台。
      </p>
      <p className="ec-ai__hint">
        平台离线、退出登录或平台余额为零，均不会删除、禁用或阻断这里的本地模型服务。平台托管模式尚未接入，可用时此处会提供模式说明与切换。
      </p>
    </section>
  );
}
