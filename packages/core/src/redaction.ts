/**
 * 日志脱敏。
 *
 * 覆盖：API Key（sk- 等常见前缀）、Bearer token、password 字段、数据库连接串、
 * 手机号、邮箱、JWT、私钥块。
 * 所有日志输出与导出文件共用同一套规则（NFR-S-04）。
 */

export interface RedactionRule {
  id: string;
  /** 命中即替换 */
  pattern: RegExp;
  /** 替换函数，默认统一替换为 *** */
  replace?: (match: string, ...groups: string[]) => string;
}

const MASK = '***';
const KEY_PREFIX = 'sk-';

function keepEdges(value: string, head = 2, tail = 2): string {
  if (value.length <= head + tail) return MASK;
  return `${value.slice(0, head)}${MASK}${value.slice(-tail)}`;
}

export const BUILT_IN_RULES: readonly RedactionRule[] = [
  {
    id: 'bearer',
    pattern: /\bBearer\s+([A-Za-z0-9._-]{6,})/gi,
    replace: (match) => match.replace(/([A-Za-z0-9._-]{6,})$/, MASK),
  },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    replace: () => MASK,
  },
  {
    id: 'api-key-prefixed',
    pattern: /\b(sk|pk|api|token|ghp|gho|ghs|ghu|ghr|glpat|xox[baprs])[-_][A-Za-z0-9_-]{4,}/gi,
    replace: (match) => {
      const idx = match.indexOf('-');
      return `${match.slice(0, idx + 1)}${MASK}`;
    },
  },
  {
    id: 'connection-string',
    pattern: /\b([a-z0-9+.-]+):\/\/([^:/\s@]+):([^@\s/]+)@([^\s/]+)/gi,
    replace: (_match, scheme: string, user: string, _password: string, host: string) =>
      `${scheme}://${user}:${MASK}@${host}`,
  },
  {
    id: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => MASK,
  },
  {
    id: 'email',
    pattern: /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    replace: (_match, head: string, domain: string) => `${head}${MASK}@${domain}`,
  },
  {
    id: 'phone-cn',
    pattern: /\b1[3-9]\d{9}\b/g,
    replace: (match) => `${match.slice(0, 3)}****${match.slice(-4)}`,
  },
  {
    id: 'key-value-secret',
    pattern:
      /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization|credential|cookie)\b["']?(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    replace: (_match, key: string, sep: string) => `${key}${sep}${MASK}`,
  },
  {
    id: 'openai-style-sk',
    pattern: /\bsk-[A-Za-z0-9]{16,}\b/g,
    replace: (match) => `${KEY_PREFIX}${keepEdges(match.slice(KEY_PREFIX.length), 2, 2)}`,
  },
];

const customRules: RedactionRule[] = [];

/** 注册自定义脱敏规则（业务专属密钥格式） */
export function registerRedactionRule(rule: RedactionRule): void {
  customRules.push(rule);
}

export function allRules(): RedactionRule[] {
  return [...customRules, ...BUILT_IN_RULES];
}

/** 对一段文本执行全部脱敏规则 */
export function mask(input: string): string {
  let output = input;
  for (const rule of allRules()) {
    output = output.replace(rule.pattern, (match, ...groups: unknown[]) => {
      if (!rule.replace) return MASK;
      return rule.replace(match, ...(groups.slice(0, 4) as string[]));
    });
  }
  return output;
}

const SECRET_KEY_PATTERN =
  /(key|token|secret|password|passwd|pwd|authorization|cookie|credential)/i;

/**
 * 深拷贝对象并对字符串值脱敏。
 * 键名命中敏感词时整个值替换为 ***，避免"值本身不像密钥但确实是密钥"的情况漏网。
 */
export function maskObject<T>(input: T, seen = new WeakSet<object>()): T {
  if (typeof input === 'string') return mask(input) as unknown as T;
  if (input === null || typeof input !== 'object') return input;
  if (seen.has(input as object)) return '[Circular]' as unknown as T;
  seen.add(input as object);

  if (Array.isArray(input)) {
    return input.map((item) => maskObject(item, seen)) as unknown as T;
  }
  if (input instanceof Date) return input;
  if (input instanceof Uint8Array) return '[Bytes]' as unknown as T;

  const source = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && SECRET_KEY_PATTERN.test(key)) {
      output[key] = MASK;
    } else {
      output[key] = maskObject(value, seen);
    }
  }
  return output as T;
}

/** 便捷别名：与 mask 等价，供日志与导出共用 */
export const redactText = mask;
