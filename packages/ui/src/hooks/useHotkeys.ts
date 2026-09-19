import { useEffect, useRef } from 'react';

/** 组合键描述，如 'Ctrl+Shift+P' / 'Ctrl+K' / 'Escape' */
export interface Hotkey {
  /** 组合键，Ctrl/Shift/Alt/Meta+Key */
  combo: string;
  handler: (event: KeyboardEvent) => void;
  /** 允许在输入框聚焦时触发（默认否） */
  allowInInput?: boolean;
  /** preventDefault，默认 true */
  preventDefault?: boolean;
}

function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const parts = combo
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  const key = parts[parts.length - 1] ?? '';
  const needCtrl = parts.includes('ctrl') || parts.includes('control');
  const needShift = parts.includes('shift');
  const needAlt = parts.includes('alt') || parts.includes('option');
  const needMeta = parts.includes('meta') || parts.includes('cmd') || parts.includes('command');

  const eventKey = event.key.toLowerCase();
  const keyMatches =
    eventKey === key ||
    (key.length === 1 && eventKey.length === 1 && eventKey === key) ||
    event.code === `Key${key.toUpperCase()}`;
  return (
    keyMatches &&
    event.ctrlKey === needCtrl &&
    event.shiftKey === needShift &&
    event.altKey === needAlt &&
    event.metaKey === needMeta
  );
}

/** 全局快捷键；输入框聚焦时默认不触发普通字母键组合 */
export function useHotkeys(hotkeys: Hotkey[], deps: unknown[] = []): void {
  const hotkeysRef = useRef(hotkeys);
  hotkeysRef.current = hotkeys;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditable =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      for (const hotkey of hotkeysRef.current) {
        if (!matchesCombo(event, hotkey.combo)) continue;
        if (inEditable && !hotkey.allowInInput && hotkey.combo.toLowerCase() !== 'escape') continue;
        if (hotkey.preventDefault ?? true) event.preventDefault();
        hotkey.handler(event);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
