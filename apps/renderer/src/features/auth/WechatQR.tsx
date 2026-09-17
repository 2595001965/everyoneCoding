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
  /** 扫码确认后回调（由外层完成换令牌） */
  onConfirmed: (state: string) => void;
}

/** 二维码视觉块（真实实现由外壳注入二维码图片/Canvas；此处给出可识别的占位与链接） */
export function WechatQR({ onConfirmed }: WechatQRProps): JSX.Element {
  const api = useAuth();
  const [authorizeUrl, setAuthorizeUrl] = useState('');
  const [state, setState] = useState('');
  const [phase, setPhase] = useState<'loading' | 'pending' | 'scanned' | 'expired' | 'error'>('loading');
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
        setPhase('pending');
        confirmedRef.current(state);
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
