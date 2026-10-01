import { describe, expect, it } from 'vitest';

import { classifyUpdateError, tagUpdateError } from '../update-errors';

describe('更新失败归类（签名 / 网络 / 半包 / 离线）', () => {
  it('外壳打的 UPDATE_* 标记优先，且能穿过 Electron IPC 的包装前缀', () => {
    const wrapped = new Error(
      "Error invoking remote method 'ec:updater:download': Error: UPDATE_SIGNATURE: bad sig",
    );
    const result = classifyUpdateError(wrapped);
    expect(result.kind).toBe('signature');
    expect(result.detail).toBe('UPDATE_SIGNATURE: bad sig');
  });

  it('tagUpdateError 与 classify 往返一致（含带连字符的类别）', () => {
    expect(classifyUpdateError(tagUpdateError('not-configured', 'x')).kind).toBe('not-configured');
    expect(classifyUpdateError(tagUpdateError('integrity', 'x')).kind).toBe('integrity');
  });

  it.each([
    ['Error: minisign_verify: signature verification failed', 'signature'],
    ['New version 0.2.0 is not signed by the application owner: publisherNames: x', 'signature'],
    ['sha512 checksum mismatch, expected A, got B', 'integrity'],
    ['net::ERR_INTERNET_DISCONNECTED', 'offline'],
    ['getaddrinfo ENOTFOUND updates.example.com', 'offline'],
    ['connect ECONNREFUSED 127.0.0.1:18080', 'network'],
    ['error sending request for url (http://127.0.0.1:9/latest.json)', 'network'],
    ['something odd', 'unknown'],
  ] as const)('无标记兜底：%s → %s', (message, kind) => {
    expect(classifyUpdateError(new Error(message)).kind).toBe(kind);
  });
});
