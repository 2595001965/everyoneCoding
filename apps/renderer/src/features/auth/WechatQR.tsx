/**
 * WechatQR（T9-05 / FR-ACC-02）：PC 端微信扫码登录。
 *
 * 二维码 5 分钟有效；过期后自动刷新（重新取码并重置倒计时）；
 * 轮询授权态：pending → scanned → confirmed。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@ec/ui';
import { WECHAT_QR_TTL_MS } from '@ec/account';

import { useAuth } from './auth-api';

export interface WechatQRProps {
  /** 扫码确认后回调，入参是服务端给出的回调 URL（含 code/state），由外层换令牌 */
  onConfirmed: (callbackUrl: string) => void;
}

/** 二维码视觉块（真实实现由外壳注入二维码图片/Canvas；此处给出可识别的占位与链接） */
export function WechatQR({ onConfirmed }: WechatQRProps): JSX.Element {
  const api = useAuth();
  const [authorizeUrl, setAuthorizeUrl] = useState('');
  const [state, setState] = useState('');
  const [phase, setPhase] = useState<
    'loading' | 'pending' | 'scanned' | 'confirmed' | 'expired' | 'error'
  >('loading');
  const [error, setError] = useState<string | null>(null);
  const [remainMs, setRemainMs] = useState(WECHAT_QR_TTL_MS);
  const confirmedRef = useRef(onConfirmed);
  confirmedRef.current = onConfirmed;

  const refresh = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const handshake = await api.beginOAuth('wechat');
      setAuthorizeUrl(handshake.authorizeUrl);
      setState(handshake.state);
      setRemainMs(WECHAT_QR_TTL_MS);
      setPhase('pending');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase('error');
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 倒计时：5 分钟到期自动刷新二维码
  useEffect(() => {
    if (phase !== 'pending' && phase !== 'scanned') return;
    const timer = setInterval(() => {
      setRemainMs((prev) => {
        if (prev <= 1000) {
          setPhase('expired');
          return 0;
        }
        return prev - 1000;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // 轮询授权态
  useEffect(() => {
    if (phase !== 'pending' && phase !== 'scanned') return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const result = await api.pollWechatScan(state);
      if (cancelled) return;
      if (result.state === 'scanned') setPhase('scanned');
      if (result.state === 'confirmed') {
        // 终态：**必须离开轮询集合**。留在 pending 会让每次轮询都再换一次令牌，
        // 服务端那边的 state 是一次性的，第二次必然失败并盖掉成功结果。
        setPhase('confirmed');
        // 微信这条路径不回环也不走协议：回调 URL 由状态轮询直接带回，
        // 即扫码确认后我们已经拿到换令牌所需的一切
        if (typeof result.callbackUrl === 'string' && result.callbackUrl.length > 0) {
          confirmedRef.current(result.callbackUrl);
        } else {
          setError('微信已确认，但未返回回调地址：请重试扫码。');
        }
      }
      if (result.state === 'expired' || result.state === 'cancelled') setPhase('expired');
    };
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, phase, state]);

  const seconds = Math.ceil(remainMs / 1000);

  return (
    <div className="ec-auth__qr" aria-label="微信扫码登录">
      <div className="ec-auth__qr-code" role="img" aria-label="微信登录二维码">
        {/* 外壳注入的真实二维码图片；无注入时展示授权链接 */}
        {phase === 'loading' ? <span>正在获取二维码…</span> : null}
        {phase === 'expired' ? <span>二维码已过期</span> : null}
        {phase === 'scanned' ? <span>已扫描，请在手机上确认</span> : null}
        {phase === 'confirmed' ? <span>已确认，正在登录…</span> : null}
        {phase === 'pending' ? <span>请用微信扫描二维码</span> : null}
      </div>

      {phase === 'pending' || phase === 'scanned' ? (
        <p className="ec-auth__hint">{`二维码有效期剩余 ${seconds} 秒`}</p>
      ) : null}

      {phase === 'expired' ? (
        <Button variant="secondary" size="sm" onClick={() => void refresh()}>
          刷新二维码
        </Button>
      ) : null}

      {error ? <p className="ec-auth__error">{error}</p> : null}

      {authorizeUrl ? (
        <p className="ec-auth__hint">
          <a href={authorizeUrl} target="_blank" rel="noreferrer">
            在浏览器中打开微信授权页
          </a>
        </p>
      ) : null}
    </div>
  );
}
