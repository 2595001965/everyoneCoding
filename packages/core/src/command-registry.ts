/**
 * 命令系统。
 *
 * 每个可视化操作都抽象为命令，统一承载：标题、分组、快捷键、启用条件、执行体、是否可撤销。
 * 命令面板按标题与分组模糊检索；快捷键冲突可被检测（注册期与运行期均可）。
 */

export interface CommandContext {
  [key: string]: unknown;
}

export interface Command<C extends CommandContext = CommandContext> {
  id: string;
  title: string;
  group: string;
  /** 如 'Ctrl+Shift+P'；缺省表示未绑定 */
  shortcut?: string;
  /** 是否进入撤销栈 */
  isUndoable?: boolean;
  /** 启用条件；缺省恒为可用 */
  isEnabled?: (context: C) => boolean;
  execute: (context: C) => void | Promise<void>;
}

export interface ParsedAccelerator {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** 主键，统一大写 */
  key: string;
}

const MODIFIER_ALIASES: Record<string, keyof Omit<ParsedAccelerator, 'key'>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
};

/** 解析快捷键字符串；非法格式返回 null */
export function parseAccelerator(accelerator: string | undefined): ParsedAccelerator | null {
  if (!accelerator) return null;
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;

  const parsed: ParsedAccelerator = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      parsed[modifier] = true;
      continue;
    }
    if (parsed.key.length > 0) return null; // 多个主键视为非法
    parsed.key = part.toUpperCase();
  }
  return parsed.key.length > 0 ? parsed : null;
}

/** 规范化快捷键为统一展示形式，如 Ctrl+Shift+P */
export function formatAccelerator(accelerator: string): string {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return accelerator;
  const pieces: string[] = [];
  if (parsed.ctrl) pieces.push('Ctrl');
  if (parsed.alt) pieces.push('Alt');
  if (parsed.shift) pieces.push('Shift');
  if (parsed.meta) pieces.push('Meta');
  pieces.push(parsed.key);
  return pieces.join('+');
}

export interface CommandRegistryOptions {
  /** 注册时即检测冲突，默认 true */
  detectConflictsOnRegister?: boolean;
}

export class CommandRegistry<C extends CommandContext = CommandContext> {
  private readonly commands = new Map<string, Command<C>>();
  private readonly options: CommandRegistryOptions;

  constructor(options: CommandRegistryOptions = {}) {
    this.options = options;
  }

  register(command: Command<C>): void {
    if (this.commands.has(command.id)) {
      throw new Error(`命令 id 重复: ${command.id}`);
    }
    if ((this.options.detectConflictsOnRegister ?? true) && command.shortcut) {
      const conflict = this.findByShortcut(command.shortcut);
      if (conflict) {
        throw new Error(
          `快捷键冲突: ${formatAccelerator(command.shortcut)} 已被命令 ${conflict.id} 占用，无法分配给 ${command.id}`,
        );
      }
    }
    this.commands.set(command.id, command);
  }

  registerAll(commands: Command<C>[]): void {
    for (const command of commands) this.register(command);
  }

  unregister(id: string): boolean {
    return this.commands.delete(id);
  }

  get(id: string): Command<C> | undefined {
    return this.commands.get(id);
  }

  list(): Command<C>[] {
    return [...this.commands.values()];
  }

  /** 按上下文判断命令是否可用 */
  isEnabled(id: string, context: C): boolean {
    const command = this.commands.get(id);
    if (!command) return false;
    return command.isEnabled ? command.isEnabled(context) : true;
  }

  async execute(id: string, context: C): Promise<void> {
    const command = this.commands.get(id);
    if (!command) throw new Error(`未注册的命令: ${id}`);
    if (!this.isEnabled(id, context)) {
      throw new Error(`命令当前不可用: ${id}`);
    }
    await command.execute(context);
  }

  findByShortcut(accelerator: string): Command<C> | undefined {
    const target = parseAccelerator(accelerator);
    if (!target) return undefined;
    return this.list().find((command) => {
      const parsed = parseAccelerator(command.shortcut);
      return (
        parsed !== null &&
        parsed.key === target.key &&
        parsed.ctrl === target.ctrl &&
        parsed.shift === target.shift &&
        parsed.alt === target.alt &&
        parsed.meta === target.meta
      );
    });
  }

  /** 检测全部快捷键冲突，返回冲突组（每组 ≥2 个命令） */
  detectShortcutConflicts(): string[][] {
    const buckets = new Map<string, string[]>();
    for (const command of this.commands.values()) {
      const parsed = parseAccelerator(command.shortcut);
      if (!parsed) continue;
      const signature = `${parsed.ctrl ? 'C' : ''}${parsed.alt ? 'A' : ''}${parsed.shift ? 'S' : ''}${
        parsed.meta ? 'M' : ''
      }+${parsed.key}`;
      const bucket = buckets.get(signature) ?? [];
      bucket.push(command.id);
      buckets.set(signature, bucket);
    }
    return [...buckets.values()].filter((group) => group.length > 1);
  }

  /**
   * 命令面板检索：按标题与分组模糊匹配（子序列匹配 + 连续命中加权）。
   */
  search(query: string, context?: C): Command<C>[] {
    const normalized = query.trim().toLowerCase();
    const all = this.list();
    if (normalized.length === 0) return all;

    const scored = all
      .map((command) => ({ command, score: fuzzyScore(normalized, command) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const result = scored.map((item) => item.command);
    return context ? result.filter((command) => this.isEnabled(command.id, context)) : result;
  }
}

/** 子序列模糊打分：标题命中权重高于分组，连续命中额外加权 */
export function fuzzyScore(query: string, command: { title: string; group: string; id: string }): number {
  const title = command.title.toLowerCase();
  const group = command.group.toLowerCase();
  const id = command.id.toLowerCase();

  let score = 0;
  if (title.includes(query)) score += 100 - title.indexOf(query);
  else if (isSubsequence(query, title)) score += 50;

  if (group.includes(query)) score += 30;
  if (id.includes(query)) score += 40;
  return score;
}

function isSubsequence(query: string, target: string): boolean {
  let index = 0;
  for (const char of target) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return index === query.length;
}
