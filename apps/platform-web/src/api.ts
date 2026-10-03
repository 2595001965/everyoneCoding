export interface ApiErrorPayload {
  code?: string;
  message?: string;
  traceId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId: string | null;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message || '请求失败，请稍后重试');
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.code || 'REQUEST_FAILED';
    this.traceId = payload.traceId || null;
  }
}

export async function api<T>(
  path: string,
  options: {
    token?: string;
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
    body?: unknown;
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  let response: Response;
  try {
    const request: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      credentials: 'omit',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    };
    if (options.body !== undefined) request.body = JSON.stringify(options.body);
    response = await fetch(path, request);
  } catch {
    throw new ApiError(0, {
      code: 'NETWORK_UNAVAILABLE',
      message: '账号服务暂不可用，请检查服务状态后重试',
    });
  }
  const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload;
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload as T;
}

export function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
