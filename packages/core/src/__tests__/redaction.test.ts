import { describe, expect, it } from 'vitest';
import { mask, maskObject, registerRedactionRule } from '../redaction';

/** 20 条脱敏样例：覆盖 Key / Bearer / 密码 / 连接串 / 手机号 / 邮箱 / JWT / 私钥 */
const SAMPLES: Array<{ input: string; mustNotContain: string[] }> = [
  { input: '调用 OpenAI，key=sk-liveAbc123456789XyZ', mustNotContain: ['sk-liveAbc123456789XyZ'] },
  {
    input: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9xxxxx',
    mustNotContain: ['eyJhbGciOiJIUzI1NiJ9xxxxx'],
  },
  { input: 'password: SuperSecret123!', mustNotContain: ['SuperSecret123!'] },
  { input: '{"password":"P@ssw0rd!"}', mustNotContain: ['P@ssw0rd!'] },
  { input: 'postgres://admin:pa55word@db.internal:5432/ec', mustNotContain: ['pa55word'] },
  { input: 'mongodb://root:mongodbPass@127.0.0.1:27017', mustNotContain: ['mongodbPass'] },
  { input: '联系手机号 13812345678', mustNotContain: ['13812345678'] },
  { input: '备用号码 15900001111 请核实', mustNotContain: ['15900001111'] },
  { input: '邮箱 zhangsan@example.com 已注册', mustNotContain: ['zhangsan@example.com'] },
  { input: 'mailto:li.si@corp.com.cn', mustNotContain: ['li.si@corp.com.cn'] },
  { input: 'token=ghp_abcdefghijklmnop123456', mustNotContain: ['ghp_abcdefghijklmnop123456'] },
  { input: 'api_key: AKIA1234567890ABCDEF', mustNotContain: ['AKIA1234567890ABCDEF'] },
  { input: 'xoxb-1234567890-abcdefghijkl', mustNotContain: ['xoxb-1234567890-abcdefghijkl'] },
  {
    input:
      'jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w',
    mustNotContain: ['eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
  },
  {
    input: '-----BEGIN RSA PRIVATE KEY-----MIIEow-----END RSA PRIVATE KEY-----',
    mustNotContain: ['MIIEow'],
  },
  { input: 'refresh_token: rtk_9f8e7d6c5b4a3210', mustNotContain: ['rtk_9f8e7d6c5b4a3210'] },
  {
    input: 'sk-ant-api03-abcdefghijklmnopqrstuv',
    mustNotContain: ['sk-ant-api03-abcdefghijklmnopqrstuv'],
  },
  { input: 'secret = "abc123XYZ"', mustNotContain: ['abc123XYZ'] },
  { input: 'accessToken=ya29.a0AfH6SMBx1234567890', mustNotContain: ['ya29.a0AfH6SMBx1234567890'] },
  {
    input: 'privateKey: "0x1234567890abcdef1234567890abcdef"',
    mustNotContain: ['0x1234567890abcdef1234567890abcdef'],
  },
];

describe('日志脱敏', () => {
  it('20 条样例全部被脱敏，日志/导出中检索不到明文', () => {
    for (const sample of SAMPLES) {
      const output = mask(sample.input);
      for (const secret of sample.mustNotContain) {
        expect(output, `未脱敏: ${sample.input}`).not.toContain(secret);
      }
    }
  });

  it('邮箱保留首位与域名，手机号保留前 3 后 4', () => {
    expect(mask('邮箱 zhangsan@example.com')).toContain('@example.com');
    expect(mask('手机 13812345678')).toContain('138****5678');
  });

  it('连接串只打码口令，保留 scheme / 用户 / 主机便于排障', () => {
    const output = mask('postgres://admin:pa55word@db.internal:5432/ec');
    expect(output).toContain('postgres://admin:***@db.internal:5432/ec');
  });

  it('普通中文文案不被误伤', () => {
    const text = '用户点击了登录按钮，触发表单校验与接口调用';
    expect(mask(text)).toBe(text);
  });

  it('maskObject 按键名兜底脱敏（键名敏感即整体打码）', () => {
    const output = maskObject({
      apiKey: '任意值',
      nested: { password: 'hunter2', name: '登录按钮' },
      list: [{ token: 'abc' }],
    });
    expect(output).toEqual({
      apiKey: '***',
      nested: { password: '***', name: '登录按钮' },
      list: [{ token: '***' }],
    });
  });

  it('maskObject 处理循环引用不栈溢出', () => {
    interface Node {
      name: string;
      self?: Node;
    }
    const node: Node = { name: 'x' };
    node.self = node;
    expect(() => maskObject(node)).not.toThrow();
  });

  it('支持注册自定义脱敏规则', () => {
    registerRedactionRule({
      id: 'internal-id',
      pattern: /EC-SECRET-\d{6}/g,
      replace: () => '[已脱敏]',
    });
    expect(mask('编号 EC-SECRET-123456')).toContain('[已脱敏]');
  });
});
