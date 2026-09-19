/**
 * 提交信息生成与校验（T6-02 要点 2、3、5）。
 *
 * 三件事：
 * 1. **规范**：Conventional Commits（`<type>(<scope>): <subject>` + body），
 *    规范可在设置里切换（`angular` / `custom`）；`custom` 允许用户自定义 type 白名单。
 * 2. **AI 生成**：`normalizeAiCommitMessage` 负责把模型返回的裸文本（常带 ``` 围栏、
 *    前后解释、多行 body）洗成一条合规提交信息 —— 模型输出不可直接进 git。
 * 3. **自动提交策略**（FR-GIT-09）：默认**关闭**，建议"每阶段提交"；
 *    产物提交信息里必须带生成节点来源标记，便于回溯。
 */

export type CommitConvention = 'angular' | 'custom';

export interface CommitConventionSpec {
  id: CommitConvention;
  label: string;
  /** 允许的 type 白名单 */
  types: readonly string[];
  /** 允许 `!` 表破坏性变更 */
  allowBreaking: boolean;
  /** subject 长度上限 */
  subjectMaxLength: number;
  /** scope 允许的字符（英文 / 拼音 / 数字 / 短横线 / 下划线 / 点） */
  scopePattern: RegExp;
}

export const ANGULAR_TYPES: readonly string[] = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

export const COMMIT_CONVENTIONS: Record<CommitConvention, CommitConventionSpec> = {
  angular: {
    id: 'angular',
    label: 'Conventional Commits（Angular）',
    types: ANGULAR_TYPES,
    allowBreaking: true,
    subjectMaxLength: 72,
    scopePattern: /^[a-z0-9][a-z0-9._-]*$/,
  },
  custom: {
    id: 'custom',
    label: '自定义规范',
    // 自定义规范在未配置时退化为 angular 的白名单
    types: ANGULAR_TYPES,
    allowBreaking: true,
    subjectMaxLength: 100,
    scopePattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  },
};

export interface CommitMessage {
  type: string;
  scope: string | null;
  subject: string;
  body: string;
  breaking: boolean;
  /** 尾注（`Refs:` / `Reviewed-by:` 等） */
  footer: string[];
}

export interface CommitMessageValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const HEADER_PATTERN = /^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

/** 解析一条提交信息；无法识别头部时返回 null（不抛错，便于校验路径逐条报错） */
export function parseCommitMessage(text: string): CommitMessage | null {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return null;
  const lines = normalized.split('\n');
  const header = lines[0] ?? '';
  const match = HEADER_PATTERN.exec(header);
  if (match === null) return null;

  const bodyLines: string[] = [];
  const footer: string[] = [];
  let inFooter = false;
  for (const line of lines.slice(1)) {
    if (/^[A-Za-z-]+:\s/.test(line) || /^(BREAKING CHANGE|Refs|Closes|Fixes):/.test(line))
      inFooter = true;
    if (inFooter) footer.push(line);
    else bodyLines.push(line);
  }

  return {
    type: (match[1] ?? '').toLowerCase(),
    scope: match[2] ?? null,
    breaking: match[3] === '!' || footer.some((line) => line.startsWith('BREAKING CHANGE')),
    subject: (match[4] ?? '').trim(),
    body: bodyLines.join('\n').trim(),
    footer: footer.filter((line) => line.trim().length > 0),
  };
}

export function validateCommitMessage(
  text: string,
  spec: CommitConventionSpec = COMMIT_CONVENTIONS.angular,
): CommitMessageValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const message = parseCommitMessage(text);
  if (message === null) {
    return { valid: false, errors: ['提交信息需符合 `<type>(<scope>): <subject>` 格式'], warnings };
  }
  if (!spec.types.includes(message.type)) {
    errors.push(`type「${message.type}」不在允许列表（${spec.types.join(' / ')}）中`);
  }
  if (message.scope !== null && !spec.scopePattern.test(message.scope)) {
    errors.push(`scope「${message.scope}」只允许英文 / 拼音 / 数字与 . _ -`);
  }
  if (message.breaking && !spec.allowBreaking) {
    errors.push('当前规范不允许破坏性变更标记 `!`');
  }
  if (message.subject.length === 0) errors.push('subject 不能为空');
  if (message.subject.length > spec.subjectMaxLength) {
    warnings.push(
      `subject 超过 ${spec.subjectMaxLength} 字符（当前 ${message.subject.length}），建议精简`,
    );
  }
  if (/[。！？]$/.test(message.subject)) warnings.push('subject 末尾不加句号');
  if (message.body.length === 0) warnings.push('建议补充 body 说明本次变更的内容');
  return { valid: errors.length === 0, errors, warnings };
}

export function formatCommitMessage(message: CommitMessage): string {
  const scope = message.scope !== null && message.scope.length > 0 ? `(${message.scope})` : '';
  const bang = message.breaking ? '!' : '';
  const lines = [`${message.type}${scope}${bang}: ${message.subject}`];
  if (message.body.length > 0) lines.push('', message.body);
  if (message.footer.length > 0) lines.push('', ...message.footer);
  return lines.join('\n');
}

export interface CreateCommitMessageInput {
  type: string;
  scope?: string | null;
  subject: string;
  body?: string;
  breaking?: boolean;
  footer?: string[];
  /** 变更来源标记（生成节点 / 重命名事务 / 迁移），写进 body 便于追溯 */
  sources?: readonly string[];
  spec?: CommitConventionSpec;
}

export function createCommitMessage(input: CreateCommitMessageInput): string {
  const spec = input.spec ?? COMMIT_CONVENTIONS.angular;
  const bodyParts: string[] = [];
  if (input.body !== undefined && input.body.trim().length > 0) bodyParts.push(input.body.trim());
  if (input.sources !== undefined && input.sources.length > 0) {
    bodyParts.push(`来源：${input.sources.join('、')}`);
  }
  return formatCommitMessage({
    type: input.type.toLowerCase(),
    scope: input.scope ?? null,
    subject: truncate(input.subject.trim(), spec.subjectMaxLength),
    body: bodyParts.join('\n\n'),
    breaking: input.breaking ?? false,
    footer: [...(input.footer ?? [])],
  });
}

/* -------------------------------------------------------------------------- */
/* AI 生成提交信息                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 规范化 AI 返回的提交信息。
 *
 * 模型输出常见的三种脏数据：
 * 1. 包在 ``` 代码围栏里；
 * 2. 前后带"好的，这是提交信息："这类解释；
 * 3. 头部 type 不在白名单（例如 `add:` / `update:`）。
 *
 * 处理：抽围栏 → 找第一个像头部的行 → type 不在白名单时按关键词映射到合法 type →
 * 仍拿不到就用 `fallbackSubject` 兜底。**永远返回合法可用的提交信息**。
 */
export function normalizeAiCommitMessage(
  raw: string,
  options: {
    convention?: CommitConvention;
    fallbackSubject?: string;
    fallbackType?: string;
    sources?: readonly string[];
  } = {},
): { message: CommitMessage; text: string; adjustments: string[] } {
  const convention = options.convention ?? 'angular';
  const spec = COMMIT_CONVENTIONS[convention];
  const adjustments: string[] = [];

  let candidate = stripCodeFence(raw);
  const headerLine = candidate
    .split('\n')
    .map((line) => line.trim())
    .find((line) => HEADER_PATTERN.test(line));

  if (headerLine === undefined) {
    adjustments.push('模型输出中没有可识别的头部，已用变更摘要兜底生成');
    const text = createCommitMessage({
      type: options.fallbackType ?? 'chore',
      subject: options.fallbackSubject ?? '更新生成产物',
      spec,
      ...(options.sources !== undefined ? { sources: options.sources } : {}),
    });
    return { message: parseCommitMessage(text) as CommitMessage, text, adjustments };
  }

  const headerIndex = candidate.split('\n').findIndex((line) => line.trim() === headerLine);
  const tail = candidate
    .split('\n')
    .slice(headerIndex + 1)
    .join('\n')
    .trim();
  candidate = tail.length > 0 ? `${headerLine}\n\n${tail}` : headerLine;

  const parsed = parseCommitMessage(candidate);
  if (parsed === null) {
    adjustments.push('解析头部失败，已用变更摘要兜底生成');
    const text = createCommitMessage({
      type: 'chore',
      subject: options.fallbackSubject ?? '更新生成产物',
      spec,
    });
    return { message: parseCommitMessage(text) as CommitMessage, text, adjustments };
  }

  let type = parsed.type;
  if (!spec.types.includes(type)) {
    const mapped = mapToConventionalType(type, parsed.subject);
    adjustments.push(`type「${type}」不在白名单，已映射为「${mapped}」`);
    type = mapped;
  }
  const subject = truncate(parsed.subject, spec.subjectMaxLength);
  if (subject !== parsed.subject) adjustments.push('subject 过长已截断');

  const bodyParts: string[] = [];
  if (parsed.body.length > 0) bodyParts.push(parsed.body);
  if (options.sources !== undefined && options.sources.length > 0)
    bodyParts.push(`来源：${options.sources.join('、')}`);

  const message: CommitMessage = {
    type,
    scope: parsed.scope,
    subject,
    body: bodyParts.join('\n\n'),
    breaking: parsed.breaking,
    footer: parsed.footer,
  };
  return { message, text: formatCommitMessage(message), adjustments };
}

function mapToConventionalType(type: string, subject: string): string {
  const table: Record<string, string> = {
    add: 'feat',
    added: 'feat',
    create: 'feat',
    new: 'feat',
    update: 'fix',
    updated: 'fix',
    modify: 'fix',
    modified: 'fix',
    remove: 'refactor',
    delete: 'refactor',
    deleted: 'refactor',
    rename: 'refactor',
    renamed: 'refactor',
    docs: 'docs',
    doc: 'docs',
    test: 'test',
    tests: 'test',
    build: 'build',
    ci: 'ci',
    style: 'style',
    perf: 'perf',
  };
  const direct = table[type.toLowerCase()];
  if (direct !== undefined) return direct;
  if (/文档|说明/.test(subject)) return 'docs';
  if (/测试/.test(subject)) return 'test';
  if (/修复|修正|bug/i.test(subject)) return 'fix';
  if (/重命名|重构|整理/.test(subject)) return 'refactor';
  if (/新增|新建|实现|添加/.test(subject)) return 'feat';
  return 'chore';
}

function stripCodeFence(text: string): string {
  const fenced = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/* -------------------------------------------------------------------------- */
/* 自动提交策略（FR-GIT-09）                                                   */
/* -------------------------------------------------------------------------- */

/** `off`：全手动；`per-stage`：每个流水线阶段产物提交一次（推荐）；`per-node`：每个生成节点提交一次 */
export type AutoCommitTrigger = 'off' | 'per-stage' | 'per-node';

export const AUTO_COMMIT_TRIGGER_LABELS: Record<AutoCommitTrigger, string> = {
  off: '关闭（默认）',
  'per-stage': '每阶段提交（建议）',
  'per-node': '每个生成节点提交',
};

export interface AutoCommitPolicy {
  trigger: AutoCommitTrigger;
  convention: CommitConvention;
}

export const DEFAULT_AUTO_COMMIT_POLICY: AutoCommitPolicy = {
  trigger: 'off',
  convention: 'angular',
};

export type GenerationEventKind = 'stage' | 'node';

/** 该事件是否应触发自动提交 */
export function shouldAutoCommit(policy: AutoCommitPolicy, event: GenerationEventKind): boolean {
  if (policy.trigger === 'off') return false;
  if (policy.trigger === 'per-stage') return event === 'stage';
  return true;
}

export interface AutoCommitMessageInput {
  policy: AutoCommitPolicy;
  kind: GenerationEventKind;
  /** 生成节点 / 阶段标识 */
  ref: string;
  /** 中文显示名（进 body，不进 subject 的 scope） */
  displayName: string;
  /** 机器可读 scope（英文 / 拼音，D-10） */
  scope: string | null;
  /** 变更文件数（写进 body） */
  fileCount: number;
}

/**
 * 生成节点自动提交的信息。
 * subject 用机器可读 scope + 英文 type（Conventional Commits 硬要求），
 * body 里带中文说明与来源标记（`节点：<ref>`），满足"提交信息含生成节点来源标记"。
 */
export function buildAutoCommitMessage(input: AutoCommitMessageInput): string {
  const type = input.kind === 'stage' ? 'feat' : 'feat';
  const subject =
    input.kind === 'stage'
      ? `完成阶段产物 ${input.displayName}`
      : `完成生成节点 ${input.displayName}`;
  return createCommitMessage({
    type,
    scope: input.scope,
    subject,
    body: `由 EveryoneCoding 自动提交（策略：${AUTO_COMMIT_TRIGGER_LABELS[input.policy.trigger]}）。\n本次共 ${input.fileCount} 个文件变更。`,
    sources: [`生成节点 ${input.ref}`],
    spec: COMMIT_CONVENTIONS[input.policy.convention],
  });
}
