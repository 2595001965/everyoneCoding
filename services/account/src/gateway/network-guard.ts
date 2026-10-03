import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { HttpLookup, HttpLookupAddress } from '@ec/ai';
import { AppError, ErrCode } from '../errors.ts';

export interface GuardedUpstream {
  url: URL;
  lookup: HttpLookup;
}

function ipv4Parts(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function isLoopback(address: string): boolean {
  if (address === '::1') return true;
  const parts = ipv4Parts(address);
  return parts !== null && parts[0] === 127;
}

function isForbiddenAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b, c] = v4 as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(address) !== 6) return true;
  const ip = address.toLowerCase();
  if (ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(ip) || ip.startsWith('ff')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  return mapped ? isForbiddenAddress(mapped[1]!) : false;
}

/** Resolve once, reject unsafe answers, then pin the same addresses at socket creation. */
export async function guardUpstream(
  baseUrl: string,
  allowLoopback: boolean,
): Promise<GuardedUpstream> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AppError(ErrCode.FORBIDDEN, '平台上游地址无效', 403);
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && url.protocol !== 'http:')
  ) {
    throw new AppError(ErrCode.FORBIDDEN, '平台上游地址协议或权限格式不允许', 403);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' && !(allowLoopback && isLoopback(hostname))) {
    throw new AppError(ErrCode.FORBIDDEN, '平台上游必须使用 HTTPS', 403);
  }
  if (
    hostname === 'metadata.google.internal' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new AppError(ErrCode.FORBIDDEN, '平台上游目标不允许访问本机或云元数据服务', 403);
  }

  let addresses: HttpLookupAddress[];
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new AppError(ErrCode.FORBIDDEN, '平台上游域名无法解析', 403);
    }
  }
  if (addresses.length === 0) throw new AppError(ErrCode.FORBIDDEN, '平台上游没有可用地址', 403);
  const unsafe = addresses.some((entry) =>
    allowLoopback && isLoopback(entry.address) ? false : isForbiddenAddress(entry.address),
  );
  if (unsafe)
    throw new AppError(ErrCode.FORBIDDEN, '平台上游解析到未授权的本机、内网或保留地址', 403);

  let next = 0;
  const pinnedLookup: HttpLookup = (requestedHost, options, callback) => {
    if (requestedHost.replace(/^\[|\]$/g, '').toLowerCase() !== hostname) {
      callback(new Error('上游 DNS 查询目标发生变化'), '');
      return;
    }
    const config =
      options !== null && typeof options === 'object'
        ? (options as { all?: boolean; family?: number })
        : {};
    const allowed = config.family
      ? addresses.filter((address) => address.family === config.family)
      : addresses;
    if (allowed.length === 0) {
      callback(new Error('上游 DNS 地址族不匹配'), '');
      return;
    }
    if (config.all) {
      callback(null, allowed);
      return;
    }
    const selected = allowed[next % allowed.length]!;
    next += 1;
    callback(null, selected.address, selected.family);
  };
  return { url, lookup: pinnedLookup };
}
