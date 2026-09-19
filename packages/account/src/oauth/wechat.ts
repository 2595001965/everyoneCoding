/**
 * 微信扫码登录（T9-05 / FR-ACC-02）。
 *
 * PC 端流程：打开微信开放平台二维码页（`open.weixin.qq.com/connect/qrconnect`）→ 用户扫码
 * → 微信回跳带 code → 客户端轮询服务端授权态直到 confirmed / expired。
 *
 * 二维码有效期 5 分钟，过期后**自动刷新**（重新取二维码）。
 */

import type { OAuthProvider } from '../auth-types';

export const WECHAT_PROVIDER: OAuthProvider = 'wechat';

export const WECHAT_QR_ENDPOINT = 'https://open.weixin.qq.com/connect/qrconnect';

/** 扫码登录 scope（snsapi_login 用于网站应用扫码） */
export const WECHAT_SCOPE = 'snsapi_login';

/** 二维码有效期（5 分钟，超时自动刷新） */
export const WECHAT_QR_TTL_MS = 5 * 60 * 1000;

export interface WechatQrInput {
  appId: string;
  redirectUri: string;
  state: string;
}

/** 构造微信扫码 URL（微信要求 `#wechat_redirect` 结尾） */
export function buildWechatQrUrl(input: WechatQrInput): string {
  const url = new URL(WECHAT_QR_ENDPOINT);
  url.searchParams.set('appid', input.appId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', WECHAT_SCOPE);
  url.searchParams.set('state', input.state);
  return `${url.toString()}#wechat_redirect`;
}

/** 扫码轮询状态 */
export type WechatPollState = 'pending' | 'scanned' | 'confirmed' | 'expired' | 'cancelled';

/** 一次轮询结果（由服务端返回） */
export interface WechatPollResult {
  state: WechatPollState;
  /** confirmed 时存在 */
  code?: string | undefined;
}

/**
 * 轮询直到出结果或超时。
 * @param poll 单次轮询（外壳实现为请求服务端授权态接口）
 * @param options.intervalMs 轮询间隔（默认 1.5s）
 * @param options.timeoutMs 总超时（默认二维码有效期 5 分钟）
 * @param options.clock 时间源（测试注入）
 * @param options.sleep 等待实现（测试注入，默认真实延时）
 */
export async function pollWechatQr(
  poll: () => Promise<WechatPollResult>,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    clock?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<WechatPollResult> {
  const interval = options.intervalMs ?? 1500;
  const timeout = options.timeoutMs ?? WECHAT_QR_TTL_MS;
  const clock = options.clock ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = clock() + timeout;

  for (;;) {
    const result = await poll();
    if (result.state === 'confirmed' || result.state === 'cancelled' || result.state === 'expired')
      return result;
    if (clock() >= deadline) return { state: 'expired' };
    await sleep(interval);
  }
}

export function parseWechatCallback(callbackUrl: string, expectedState: string): { code: string } {
  const url = new URL(callbackUrl);
  const state = url.searchParams.get('state');
  if (!state || state !== expectedState) throw new Error('微信回调 state 校验失败（可能是 CSRF）');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('微信回调缺少授权码');
  return { code };
}
