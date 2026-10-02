import type { ApiIndexPort } from '@ec/registry';

export const API_INDEX_GLOBAL_KEY = '__EC_API_INDEX__';
export function readInjectedApiIndex(): ApiIndexPort | null {
  const candidate = (globalThis as unknown as Record<string, unknown>)[API_INDEX_GLOBAL_KEY];
  if (!candidate || typeof candidate !== 'object') return null;
  return [
    'list',
    'rescan',
    'detail',
    'classify',
    'confirmCall',
    'reverse',
    'navigate',
    'navigateElement',
  ].every((key) => typeof (candidate as Record<string, unknown>)[key] === 'function')
    ? (candidate as ApiIndexPort)
    : null;
}
