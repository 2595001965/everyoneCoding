/**
 * 归档脱敏覆盖「已登记密钥」（T12-08）。
 *
 * 中转 Key 常是任意随机串，内置规则认不出；密钥环读写过的明文会登记到 @ec/core，
 * 归档导出必须按精确值把它打掉，并在命中清单里如实列出。
 */

import { describe, expect, it } from 'vitest';

import { registerSecretValue } from '@ec/core';

import { redactTextIfNeeded, scanForSecrets } from '../export/redactor';

describe('归档导出：已登记密钥', () => {
  it('随机串形态的中转 Key 被打码并记入命中清单', () => {
    const key = 'relay9f8e7d6c5b4a3210zyxw';
    const text = `# 调试记录\nbaseUrl=https://relay.example.com\n复制来的 Key：${key}\n`;
    expect(scanForSecrets(text)).toEqual([]);

    registerSecretValue(key);
    const result = redactTextIfNeeded('notes/debug.md', text);
    expect(result.text).not.toContain(key);
    expect(result.findings).toEqual([
      expect.objectContaining({ path: 'notes/debug.md', ruleId: 'known-secret', line: 3 }),
    ]);
    expect(result.findings[0]?.preview).not.toContain(key);
  });
});
