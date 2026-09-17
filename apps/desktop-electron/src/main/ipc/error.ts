/**
 * 主进程 IPC 错误工具：统一以 `JSON {code,message}` 过通道传递，
 * 渲染层桥接（src/bridge.ts）负责解析回 ShellError。
 */

export interface WireError {
  code: string;
  message: string;
}

export function toWireError(code: string, message: string): Error {
  return new Error(JSON.stringify({ code, message } satisfies WireError));
}

export function parseWireError(error: unknown): WireError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith('{') || !message.includes('"code"')) return null;
  try {
    const parsed = JSON.parse(message) as Partial<WireError>;
    if (typeof parsed.code === 'string' && typeof parsed.message === 'string') {
      return { code: parsed.code, message: parsed.message };
    }
    return null;
  } catch {
    return null;
  }
}
