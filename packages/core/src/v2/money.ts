/**
 * V2 公共契约 —— 金额定点语义（V2-T01；PRD V2-BILL-04、V2-BILL-10）。
 *
 * 规则：
 * - 金额一律定点整数**微单位**（micros = 1e-6 币种单位），禁止浮点 Number 参与账务累加
 * - 币种为 ISO 4217 三位大写；不同币种/外部估算与平台实扣分开展示，**禁止跨币种相加**
 * - 微单位用 JS number 的安全整数范围即可容纳真实账务（±9e15 micros = ±90 亿元），
 *   所有运算保持整数（乘法在 token×费率先行，除法用整除+余数四舍五入，见 billing.ts）
 */
import { z } from 'zod';

export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, '必须是 ISO 4217 三位大写币种码');
export type CurrencyCode = string;

export const microsSchema = z
  .number()
  .int()
  .gte(Number.MIN_SAFE_INTEGER)
  .lte(Number.MAX_SAFE_INTEGER);
/** 定点整数微单位（1e-6 币种单位），可为负（冲正/调整） */
export type Micros = number;

export interface MoneyAmount {
  currency: CurrencyCode;
  micros: Micros;
}

export const moneyAmountSchema = z.object({
  currency: currencyCodeSchema,
  micros: microsSchema,
});

/** 单位换算常量 */
export const MICROS_PER_UNIT = 1_000_000;

export function moneyOf(currency: CurrencyCode, micros: Micros): MoneyAmount {
  return { currency: currencyCodeSchema.parse(currency), micros: microsSchema.parse(micros) };
}

/** 同币种求和；跨币种直接抛错——调用方必须先按币种/账务域分组（V2-BILL-10） */
export function addMoney(a: MoneyAmount, b: MoneyAmount): MoneyAmount {
  if (a.currency !== b.currency) {
    throw new Error(`跨币种禁止相加：${a.currency} vs ${b.currency}`);
  }
  return { currency: a.currency, micros: a.micros + b.micros };
}

/**
 * 从十进制字符串精确构造微单位（如 "0.027" 元 → 27000 micros）。
 * 用字符串解析而非浮点乘法，避免 0.1 类精度污染；最多 6 位小数。
 */
export function microsFromDecimal(currency: CurrencyCode, decimal: string): MoneyAmount {
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(decimal);
  if (!m) throw new Error(`非法十进制金额：${decimal}`);
  const sign = m[1] === '-' ? -1 : 1;
  const intPart = m[2] ?? '0';
  const fracPart = (m[3] ?? '').padEnd(6, '0');
  return { currency, micros: sign * (Number(intPart) * MICROS_PER_UNIT + Number(fracPart)) };
}

/** 微单位 → 十进制字符串（精确，无浮点；用于展示与测试断言） */
export function microsToDecimalString(money: MoneyAmount): string {
  const negative = money.micros < 0;
  const abs = Math.abs(money.micros);
  const units = Math.floor(abs / MICROS_PER_UNIT);
  const frac = String(abs % MICROS_PER_UNIT).padStart(6, '0');
  return `${negative ? '-' : ''}${units}.${frac}`;
}
