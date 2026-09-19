import { useEffect, useRef, useState } from 'react';

import { Button, Tag } from '@ec/ui';

/**
 * 自动写入通知（FR-MEM-10 策略②）。
 *
 * 与通用 Toast 的区别：**必须带「撤销」按钮且点击后条目消失**，
 * 因此不复用 `@ec/ui` 的 ToastProvider（它只有关闭，没有动作），
 * 而是自绘一个同风格的轻提示条，`role="status"` 不抢焦点。
 *
 * 默认 5 秒后自动消失；鼠标悬停时暂停计时（用户正在看就不该消失）。
 */

export interface AutoWriteToastProps {
  record: {
    memoryId: string;
    title: string;
    /** 策略档位，用于文案区分（静默写入不会出现本组件） */
    policy: 'auto' | 'confirm' | 'manual';
    /** 类别标签（技术栈 / 命名规范 …） */
    category?: string;
    /** 来源对话片段 */
    snippet?: string;
  };
  onUndo: (memoryId: string) => void;
  onOpen?: (memoryId: string) => void;
  onDismiss?: () => void;
  /** 自动消失时长（毫秒），默认 5000 */
  durationMs?: number;
}

export function AutoWriteToast({
  record,
  onUndo,
  onOpen,
  onDismiss,
  durationMs = 5000,
}: AutoWriteToastProps): JSX.Element {
  const [paused, setPaused] = useState(false);
  const [remaining, setRemaining] = useState(durationMs);
  const [undone, setUndone] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (paused || undone || durationMs <= 0) return undefined;
    const timer = window.setInterval(() => {
      setRemaining((value) => {
        if (value <= 100) {
          window.clearInterval(timer);
          onDismissRef.current?.();
          return 0;
        }
        return value - 100;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [paused, undone, durationMs]);

  return (
    <div
      className="ec-auto-write-toast"
      role="status"
      aria-live="polite"
      data-testid="auto-write-toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="ec-auto-write-toast__content">
        <div className="ec-auto-write-toast__title">
          已记入长期记忆：{record.title}
          {record.category && <Tag color="info">{record.category}</Tag>}
        </div>
        {record.snippet && (
          <div className="ec-auto-write-toast__desc">来源：“{record.snippet}”</div>
        )}
      </div>
      <div className="ec-auto-write-toast__actions">
        {onOpen && (
          <Button size="sm" variant="ghost" onClick={() => onOpen(record.memoryId)}>
            查看
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={undone}
          onClick={() => {
            setUndone(true);
            onUndo(record.memoryId);
            onDismiss?.();
          }}
        >
          {undone ? '已撤销' : '撤销'}
        </Button>
      </div>
      <span className="ec-auto-write-toast__progress" aria-hidden="true">
        {Math.max(0, Math.round((remaining / Math.max(1, durationMs)) * 100))}%
      </span>
    </div>
  );
}
