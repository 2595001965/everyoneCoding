import { describe, expect, it } from 'vitest';

import {
  decodeFrame,
  encodeFrame,
  isProtocolCompatible,
  PROTOCOL_VERSION,
  SIDECAR_RUNTIME_ID,
} from '../protocol';

/**
 * 协议纯函数测试：编解码、容错、升级兼容判定。
 *
 * 这一层刻意无 IO —— 管道解析的容错行为（半截 JSON、空行、非帧对象）
 * 是"宿主被杀时侧车不能跟着崩"的全部依据，值得逐条钉住。
 */

describe('侧车协议：帧编解码与升级兼容', () => {
  it('协议版本是一个正整数（升级兼容判定的基准）', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(SIDECAR_RUNTIME_ID).toBe('everyone-coding-sidecar');
  });

  it('编码为单行 JSON（不得含换行，否则会把一帧劈成两帧）', () => {
    const line = encodeFrame({
      t: 'req',
      id: '1',
      op: 'domain.invoke',
      payload: { text: '含\n换行的载荷' },
    });
    expect(line.includes('\n')).toBe(false);
    expect(JSON.parse(line)).toMatchObject({ t: 'req', id: '1' });
  });

  it('解码：非法输入一律返回 null 而不是抛错', () => {
    // 这些形状都真实出现过：宿主写到一半被杀、日志误入管道、空行
    expect(decodeFrame('')).toBeNull();
    expect(decodeFrame('   ')).toBeNull();
    expect(decodeFrame('{"t":"req","id"')).toBeNull();
    expect(decodeFrame('not json at all')).toBeNull();
    expect(decodeFrame('[]')).toBeNull();
    expect(decodeFrame('"just-a-string"')).toBeNull();
    expect(decodeFrame('null')).toBeNull();
    // 合法 JSON 但缺判别字段 `t`：不是帧，丢弃
    expect(decodeFrame('{"id":"1","op":"ping"}')).toBeNull();
  });

  it('解码：合法帧原样还原（含 CRLF 结尾，Windows 管道常态）', () => {
    const frame = { t: 'welcome', protocol: 1, secureStore: true } as const;
    const parsed = decodeFrame(`${JSON.stringify(frame)}\r`);
    expect(parsed).toMatchObject({ t: 'welcome', protocol: 1, secureStore: true });
  });

  it('升级兼容：主版本必须相等，不兼容时拒绝而不是尽力而为', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION, PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolCompatible(PROTOCOL_VERSION + 1, PROTOCOL_VERSION)).toBe(false);
    expect(isProtocolCompatible(PROTOCOL_VERSION - 1, PROTOCOL_VERSION)).toBe(false);
    // 非整数版本号（宿主解析出错）也必须判为不兼容
    expect(isProtocolCompatible(Number.NaN, PROTOCOL_VERSION)).toBe(false);
    expect(isProtocolCompatible(1.5, PROTOCOL_VERSION)).toBe(false);
  });
});
