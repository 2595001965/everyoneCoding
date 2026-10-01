/**
 * 更新失败归类（FR-SET-05 / NFR-U-02）：把外壳抛上来的错误翻成用户能看懂、界面能分支的类别。
 *
 * 外壳约定在错误消息里带 `UPDATE_<KIND>:` 标记（Electron 主进程 / Tauri Rust 命令都这么做），
 * 但错误要穿过 IPC 包装（Electron 会加 "Error invoking remote method ..." 前缀），
 * 所以这里**在整条消息里找标记**；找不到标记时再按常见底层报文兜底识别。
 */

import type { UpdateErrorKind } from '@ec/shell-api';

const TAG_RE = /\bUPDATE_(OFFLINE|NETWORK|SIGNATURE|INTEGRITY|NOT_CONFIGURED|INSTALL)\b/;

/** 无标记时的兜底识别：顺序即优先级（验签 > 校验和 > 离线 > 网络）。 */
const FALLBACK_PATTERNS: ReadonlyArray<readonly [UpdateErrorKind, RegExp]> = [
  [
    'signature',
    /signature|minisign|not signed by the application owner|ERR_UPDATER_INVALID_SIGNATURE/i,
  ],
  [
    'integrity',
    /sha512 checksum mismatch|checksum mismatch|ERR_CHECKSUM_MISMATCH|content-length|unexpected end/i,
  ],
  ['offline', /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|getaddrinfo ENOTFOUND|EAI_AGAIN/i],
  [
    'network',
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|socket hang up|ERR_CONNECTION|net::ERR_|HttpError|status code|timed out|error sending request|aborted/i,
  ],
];

const KIND_TEXT: Record<UpdateErrorKind, string> = {
  offline: '当前离线，无法连接更新服务（联网后会自动重试，不影响使用）',
  network: '无法连接更新服务或下载中断，请检查网络后重试',
  signature: '更新包签名校验失败，已拒绝安装（可能被篡改或发布配置有误）',
  integrity: '更新包校验不一致（下载不完整或被篡改），已丢弃，请重试',
  'not-configured': '未配置更新源或更新公钥',
  install: '安装器启动失败',
  unknown: '更新失败',
};

export interface ClassifiedUpdateError {
  kind: UpdateErrorKind;
  /** 面向用户的一句话（中文） */
  summary: string;
  /** 原始错误（去掉 IPC 包装前缀，便于排查） */
  detail: string;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function classifyUpdateError(error: unknown): ClassifiedUpdateError {
  const raw = messageOf(error);
  const detail = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  const tagged = TAG_RE.exec(raw)?.[1];
  let kind: UpdateErrorKind = 'unknown';
  if (tagged !== undefined) {
    kind = tagged.toLowerCase().replace('_', '-') as UpdateErrorKind;
  } else {
    for (const [candidate, pattern] of FALLBACK_PATTERNS) {
      if (pattern.test(raw)) {
        kind = candidate;
        break;
      }
    }
  }
  return { kind, summary: KIND_TEXT[kind], detail };
}

/** 外壳侧给错误打标记（Electron 主进程用；Rust 侧同口径手写前缀）。 */
export function tagUpdateError(kind: UpdateErrorKind, message: string): string {
  return `UPDATE_${kind.toUpperCase().replace('-', '_')}: ${message}`;
}
