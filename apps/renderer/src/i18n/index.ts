/**
 * 轻量 i18n：zh-CN 为默认，键缺失时回退到键名本身。
 * 结构保持极简，待 Wave 9 设置页接入后按需扩展。
 */

import { useUiStore } from '../store/useUiStore';
import { zhCN } from './zh-CN';
import { enUS } from './en-US';

export type Locale = 'zh-CN' | 'en-US';
export type MessageKey = keyof typeof zhCN;

const DICTS: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export function translate(locale: Locale, key: MessageKey): string {
  return DICTS[locale][key] ?? zhCN[key] ?? key;
}

/** React 侧取词 hook */
export function useT(): (key: MessageKey) => string {
  const locale = useUiStore((state) => state.locale);
  return (key: MessageKey) => translate(locale, key);
}
