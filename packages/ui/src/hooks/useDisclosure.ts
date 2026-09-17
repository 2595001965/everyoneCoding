import { useCallback, useState } from 'react';

/**
 * 开关态（Modal / Drawer / Popover / CommandPalette 通用）。
 * 受控 / 非受控统一：传 `open` 即受控，否则走内部 state。
 */

export interface DisclosureOptions {
  /** 受控值；传入即接管开关状态 */
  open?: boolean | undefined;
  /** 非受控初值 */
  defaultOpen?: boolean | undefined;
  /** 状态变化回调（受控/非受控都触发） */
  onOpenChange?: ((open: boolean) => void) | undefined;
}

export interface DisclosureResult {
  open: boolean;
  setOpen(open: boolean): void;
  close(): void;
  toggle(): void;
}

export function useDisclosure(options: DisclosureOptions = {}): DisclosureResult {
  const { open, defaultOpen = false, onOpenChange } = options;
  const isControlled = open !== undefined;
  const [internal, setInternal] = useState(defaultOpen);
  const current = isControlled ? (open as boolean) : internal;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternal(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  return {
    open: current,
    setOpen,
    close: () => setOpen(false),
    toggle: () => setOpen(!current),
  };
}
