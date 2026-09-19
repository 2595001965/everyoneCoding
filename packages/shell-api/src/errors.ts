import type { ShellKind } from './types.js';

/** 统一错误码：跨外壳一致，UI 按 code 决定提示与重试策略 */
export type ShellErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'PATH_ESCAPE'
  | 'IO_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'DECRYPT_FAILED'
  | 'ENCRYPT_FAILED'
  | 'PROCESS_SPAWN_FAILED'
  | 'PROCESS_KILLED'
  | 'NET_BLOCKED'
  | 'NET_ERROR'
  | 'NOT_SUPPORTED'
  | 'UNKNOWN';

const CODE_MESSAGE: Record<ShellErrorCode, string> = {
  NOT_FOUND: '目标不存在',
  ALREADY_EXISTS: '目标已存在',
  PERMISSION_DENIED: '没有访问权限',
  INVALID_ARGUMENT: '参数不合法',
  PATH_ESCAPE: '路径越出允许范围',
  IO_ERROR: '读写失败',
  TIMEOUT: '操作超时',
  CANCELLED: '操作已取消',
  DECRYPT_FAILED: '解密失败（可能已切换 Windows 用户或数据损坏）',
  ENCRYPT_FAILED: '加密失败',
  PROCESS_SPAWN_FAILED: '进程启动失败',
  PROCESS_KILLED: '进程被终止',
  NET_BLOCKED: '目标主机未被放行',
  NET_ERROR: '网络请求失败',
  NOT_SUPPORTED: '当前外壳不支持该能力',
  UNKNOWN: '未知错误',
};

/**
 * 外壳统一错误类型。
 * 注意：`cause` 只保留底层错误的 message，绝不携带可能含密钥的堆栈上下文。
 */
export class ShellError extends Error {
  readonly code: ShellErrorCode;
  readonly shell: ShellKind | 'unknown';
  override readonly cause?: string;

  constructor(
    code: ShellErrorCode,
    message?: string,
    cause?: unknown,
    shell: ShellKind | 'unknown' = 'unknown',
  ) {
    super(message ?? CODE_MESSAGE[code]);
    this.name = 'ShellError';
    this.code = code;
    this.shell = shell;
    if (cause !== undefined) {
      this.cause = cause instanceof Error ? cause.message : String(cause);
    }
    Object.setPrototypeOf(this, ShellError.prototype);
  }
}

export function isShellError(error: unknown): error is ShellError {
  return error instanceof ShellError;
}

/** 把任意异常规整为 ShellError，避免底层异常泄漏到业务层 */
export function toShellError(
  error: unknown,
  fallbackCode: ShellErrorCode = 'UNKNOWN',
  shell: ShellKind | 'unknown' = 'unknown',
): ShellError {
  if (isShellError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|not found|找不到/i.test(message))
    return new ShellError('NOT_FOUND', message, error, shell);
  if (/EACCES|EPERM|denied|拒绝访问/i.test(message)) {
    return new ShellError('PERMISSION_DENIED', message, error, shell);
  }
  if (/EEXIST|already exists/i.test(message))
    return new ShellError('ALREADY_EXISTS', message, error, shell);
  if (/ETIMEDOUT|timeout|超时/i.test(message))
    return new ShellError('TIMEOUT', message, error, shell);
  return new ShellError(fallbackCode, message, error, shell);
}
