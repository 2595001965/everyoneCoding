import * as React from 'react';
import { Button, Modal, Switch } from '@ec/ui';

import { usePreviewApi, type DeviceChannel } from './preview-api';

/**
 * T6-06 多端预览：多端预览通道 + 局域网开关 + 工具链引导。
 *
 * 设计要点（硬约束 D-09 / 数据本地优先）：
 * - 未选择的目标端不展示预览入口；
 * - 工具链缺失（如鸿蒙 hdc）输出中文安装引导，不弹报错；
 * - 局域网分享默认关闭，开启前必须展示安全风险提示（仅内网 / 不生成云端链接）；
 * 取消则保持关闭，绝不调用 setLanSharing。
 */
const KIND_ORDER: readonly DeviceChannel['kind'][] = ['mobile', 'harmony', 'desktop'];
const KIND_LABEL: Record<DeviceChannel['kind'], string> = {
  mobile: '手机',
  harmony: '鸿蒙',
  desktop: '桌面端',
};

export function DevicePreview(): JSX.Element {
  const api = usePreviewApi();
  const [devices, setDevices] = React.useState<readonly DeviceChannel[]>([]);
  const [lanEnabled, setLanEnabled] = React.useState(false);
  const [riskOpen, setRiskOpen] = React.useState(false);
  const [qr, setQr] = React.useState<{ channelId: string; url: string; qrText: string } | null>(
    null,
  );

  const reload = React.useCallback(() => {
    void api.devices().then(setDevices);
    void api.lanSharingEnabled().then(setLanEnabled);
  }, [api]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const handleLanChange = (checked: boolean): void => {
    // 关闭直接生效；开启前必须弹风险提示
    if (checked) {
      setRiskOpen(true);
    } else {
      void api.setLanSharing(false);
      setLanEnabled(false);
    }
  };

  const confirmRisk = (): void => {
    void api.setLanSharing(true);
    setLanEnabled(true);
    setRiskOpen(false);
  };

  const handleQr = (channelId: string): void => {
    void api.deviceQr(channelId).then((r) => {
      if (r.ok && r.data !== null) setQr({ channelId, url: r.data.url, qrText: r.data.qrText });
    });
  };

  return (
    <section className="ec-device-preview" aria-label="多端预览">
      <header className="ec-device-preview__header">
        <h3>多端预览</h3>
        <label className="ec-device-preview__lan">
          <Switch aria-label="局域网分享" checked={lanEnabled} onChange={handleLanChange} />
          <span>局域网分享</span>
        </label>
      </header>

      {KIND_ORDER.map((kind) => {
        const group = devices.filter((d) => d.kind === kind);
        if (group.length === 0) return null;
        return (
          <div key={kind} className="ec-device-preview__group">
            <h4>{KIND_LABEL[kind]}</h4>
            {group.map((channel) => (
              <div
                key={channel.id}
                className={
                  channel.available
                    ? 'ec-device-preview__channel'
                    : 'ec-device-preview__channel ec-device-preview__channel--missing'
                }
                data-channel={channel.id}
              >
                <div className="ec-device-preview__channel-head">
                  <span className="ec-device-preview__channel-label">{channel.label}</span>
                  {channel.available ? (
                    <span className="ec-device-preview__ok">
                      可用{channel.toolchain !== null ? `（${channel.toolchain}）` : ''}
                    </span>
                  ) : (
                    <span className="ec-device-preview__missing-tag">工具链缺失</span>
                  )}
                </div>

                {/* 工具链缺失：仅展示安装引导，不弹报错弹窗 */}
                {!channel.available && channel.guide !== null && (
                  <p className="ec-device-preview__guide" role="status">
                    {channel.guide}
                  </p>
                )}

                {/* 未选择的端：隐藏预览入口，只展示选择态 */}
                {channel.available && channel.selected && (
                  <div className="ec-device-preview__entry">
                    <span className="ec-device-preview__entry-label">预览入口</span>
                    <Button size="sm" onClick={() => handleQr(channel.id)}>
                      生成二维码
                    </Button>
                    {qr !== null && qr.channelId === channel.id && (
                      <div className="ec-device-preview__qr" data-testid="device-qr">
                        <code className="ec-device-preview__qr-url">{qr.url}</code>
                        <pre className="ec-device-preview__qr-text">{qr.qrText}</pre>
                      </div>
                    )}
                  </div>
                )}

                {channel.available && !channel.selected && (
                  <p className="ec-device-preview__unselected" role="status">
                    未选择该目标端，预览入口已隐藏
                  </p>
                )}
              </div>
            ))}
          </div>
        );
      })}

      <Modal
        open={riskOpen}
        onOpenChange={setRiskOpen}
        title="局域网分享安全提醒"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRiskOpen(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={confirmRisk}>
              我已了解，开启
            </Button>
          </>
        }
      >
        <p className="ec-device-preview__risk">
          局域网分享仅限可信内网使用。开启后预览地址仅在内网可达，
          <strong>不生成任何云端链接</strong>，请勿在公网暴露。
        </p>
      </Modal>
    </section>
  );
}
