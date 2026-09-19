/**
 * 只读约束（T4-05 要点 2 / FR-AI-11 / NFR-S-05 / D-04）。
 *
 * 两层保护，缺一不可：
 * 1. **运行时拦截**：代码视图的所有编辑入口（键入 / 粘贴 / 拖拽 / 剪切 / beforeinput）
 *    一律拦截，并把事件交给 `onBlockedEdit` 回调 —— UI 据此弹出「交给 AI 修改」入口；
 * 2. **静态扫描**：`scanReadOnlyCompliance` 在 CI/测试里扫描代码视图源文件，
 *    一旦出现 `contentEditable`、`<textarea>`、`onChange` 写回等标记即失败。
 *    这是"readOnly 100% 覆盖"唯一可被机器验证的口径（人工 review 会漏）。
 */

export type BlockedEditReason = 'keydown' | 'paste' | 'drop' | 'beforeinput' | 'cut' | 'input';

export const BLOCKED_EDIT_LABELS: Record<BlockedEditReason, string> = {
  keydown: '键盘输入',
  paste: '粘贴',
  drop: '拖拽内容',
  beforeinput: '输入',
  cut: '剪切',
  input: '修改',
};

export interface BlockedEditEvent {
  reason: BlockedEditReason;
  /** 被拦截的按键 / 数据类型（便于日志与提示措辞） */
  detail: string;
  /** 已阻止默认行为 */
  prevented: boolean;
}

/** 代码视图表面的只读属性（`<pre>` / `<code>` 容器直接展开使用） */
export const CODE_SURFACE_READONLY_PROPS = {
  readOnly: true,
  'aria-readonly': true,
  'data-readonly': 'true',
} as const;

/** 允许放行的组合键（Ctrl/Cmd + C 复制、Ctrl/Cmd + A 全选、方向键、翻页） */
const ALLOWED_KEY_COMBOS = new Set(['c', 'a']);
const NAVIGATION_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Tab',
  'Escape',
]);

export function isAllowedKey(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): boolean {
  if (NAVIGATION_KEYS.has(event.key)) return true;
  if (
    (event.ctrlKey === true || event.metaKey === true) &&
    ALLOWED_KEY_COMBOS.has(event.key.toLowerCase())
  )
    return true;
  return false;
}

export interface ReadOnlyGuardOptions {
  /** 拦截到编辑尝试时回调（UI 弹出「交给 AI 修改」） */
  onBlockedEdit?: ((event: BlockedEditEvent) => void) | undefined;
}

export interface ReadOnlyGuard {
  /** 直接展开到被保护的容器上 */
  props: {
    readOnly: true;
    'aria-readonly': true;
    'data-readonly': 'true';
    onKeyDown: (event: GuardKeyboardEvent) => void;
    onPaste: (event: GuardGenericEvent) => void;
    onDrop: (event: GuardGenericEvent) => void;
    onCut: (event: GuardGenericEvent) => void;
    onBeforeInput: (event: GuardGenericEvent) => void;
    onInput: (event: GuardGenericEvent) => void;
    onDragOver: (event: GuardGenericEvent) => void;
  };
  /** 被拦截次数（测试与埋点用） */
  blockedCount(): number;
  /** 最近一次拦截原因 */
  lastBlock(): BlockedEditEvent | null;
}

/** 结构化事件形状：只依赖我们会用到的字段，避免引入 React 类型 */
export interface GuardKeyboardEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface GuardGenericEvent {
  preventDefault(): void;
  stopPropagation(): void;
  clipboardData?: { getData?(format: string): string } | undefined;
  dataTransfer?: { types?: readonly string[]; getData?(format: string): string } | undefined;
  data?: string | null | undefined;
}

export function createReadOnlyGuard(options: ReadOnlyGuardOptions = {}): ReadOnlyGuard {
  let blocked = 0;
  let last: BlockedEditEvent | null = null;

  const notify = (
    reason: BlockedEditReason,
    detail: string,
    event: { preventDefault(): void; stopPropagation(): void },
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    blocked += 1;
    const payload: BlockedEditEvent = { reason, detail, prevented: true };
    last = payload;
    options.onBlockedEdit?.(payload);
  };

  return {
    props: {
      readOnly: true,
      'aria-readonly': true,
      'data-readonly': 'true',
      onKeyDown: (event) => {
        if (isAllowedKey(event)) return;
        if (event.key.length > 1 && !NAVIGATION_KEYS.has(event.key)) {
          // 退格 / 删除 / 回车 等编辑类按键
          notify('keydown', event.key, event);
          return;
        }
        if (event.key.length === 1) notify('keydown', event.key, event);
      },
      onPaste: (event) =>
        notify('paste', event.clipboardData?.getData?.('text')?.slice(0, 60) ?? '', event),
      onDrop: (event) =>
        notify('drop', (event.dataTransfer?.types ?? []).join(',') || '文件', event),
      onCut: (event) => notify('cut', '', event),
      onBeforeInput: (event) => notify('beforeinput', event.data ?? '', event),
      onInput: (event) => notify('input', event.data ?? '', event),
      onDragOver: (event) => notify('drop', 'drag-over', event),
    },
    blockedCount: () => blocked,
    lastBlock: () => last,
  };
}

/* ------------------------------ 静态扫描 ------------------------------ */

export interface ReadOnlyScanFile {
  path: string;
  content: string;
}

export interface ReadOnlyViolation {
  path: string;
  rule: string;
  detail: string;
  /** 命中片段（便于定位） */
  snippet: string;
}

export interface ReadOnlyScanResult {
  ok: boolean;
  checked: string[];
  violations: ReadOnlyViolation[];
  /** 声明了只读标记的文件 */
  marked: string[];
}

/** 出现这些标记即为"引入了可编辑代码入口" */
export const FORBIDDEN_EDIT_MARKERS: { rule: string; pattern: RegExp; detail: string }[] = [
  {
    rule: 'contentEditable',
    pattern: /contentEditable(?!\s*=\s*\{?false)/,
    detail: '代码视图不得启用 contentEditable（D-04：无手动编辑入口）',
  },
  { rule: 'textarea', pattern: /<textarea\b/, detail: '代码视图不得包含可编辑文本域' },
  { rule: 'input', pattern: /<input\b/, detail: '代码视图不得包含输入框' },
  {
    rule: 'writeback-handler',
    pattern: /onChange\s*=\s*\{|onInput\s*=\s*\{|onBeforeInput\s*=\s*\{/,
    detail: '不得提供写回回调：代码只能由 AI 写入',
  },
  {
    rule: 'readOnly-false',
    pattern: /readOnly\s*=\s*\{false\}|readOnly\s*:\s*false/,
    detail: '不得把只读显式关闭',
  },
  {
    rule: 'designMode',
    pattern: /designMode|execCommand/,
    detail: '不得使用 document.designMode / execCommand',
  },
];

export const READ_ONLY_MARKER_PATTERN = /readOnly|readonly|READONLY/;

/**
 * 去掉注释后再匹配。
 *
 * 为什么必须剥注释：说明性文字里出现 `contentEditable` / `<textarea>` 是常态
 * （本文件自己的文档注释就写了"不使用 input / textarea / contentEditable"），
 * 不剥注释就会把"声明禁止"当成"实际使用"，扫描结果没人信。
 *
 * 已知局限：不做完整词法分析，字符串里含 `/*` 的极端写法可能被误剥 —— 对本用途可接受，
 * 因为扫描只用于"是否存在可编辑入口"的二值判断，且配合人工复核。
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/**
 * 扫描代码视图源文件。
 *
 * `requireMarker = true`（默认）时，文件必须声明只读标记，
 * 且不得命中任何禁用标记 —— 两者都满足才算"readOnly 100% 覆盖"。
 */
export function scanReadOnlyCompliance(
  files: readonly ReadOnlyScanFile[],
  options: { requireMarker?: boolean } = {},
): ReadOnlyScanResult {
  const requireMarker = options.requireMarker ?? true;
  const violations: ReadOnlyViolation[] = [];
  const checked: string[] = [];
  const marked: string[] = [];

  for (const file of files) {
    checked.push(file.path);
    if (READ_ONLY_MARKER_PATTERN.test(file.content)) marked.push(file.path);
    else if (requireMarker) {
      violations.push({
        path: file.path,
        rule: 'missing-readonly-marker',
        detail: '文件未声明只读标记（readOnly / CODE_SURFACE_READONLY_PROPS）',
        snippet: '',
      });
    }

    const code = stripComments(file.content);
    for (const marker of FORBIDDEN_EDIT_MARKERS) {
      const match = marker.pattern.exec(code);
      if (match === null) continue;
      violations.push({
        path: file.path,
        rule: marker.rule,
        detail: marker.detail,
        snippet: code.slice(Math.max(0, match.index - 40), match.index + 40).replace(/\s+/g, ' '),
      });
    }
  }

  return { ok: violations.length === 0, checked, violations, marked };
}
