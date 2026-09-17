/**
 * 统一业务异常。错误处理器会将其转为 { code, message, traceId }。
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = 'AppError';
  }
}

/** 常见错误码（与 openapi.yaml 保持一致） */
export const ErrCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  BINDING_LAST_METHOD: 'BINDING_LAST_METHOD',
  RATE_LIMITED: 'RATE_LIMITED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  OAUTH_FAILED: 'OAUTH_FAILED',
  OAUTH_STATE_EXPIRED: 'OAUTH_STATE_EXPIRED',
  OAUTH_PKCE_MISMATCH: 'OAUTH_PKCE_MISMATCH',
  INTERNAL: 'INTERNAL',
} as const;
