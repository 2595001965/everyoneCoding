import type { DesignGenerationPort } from '../store/ports';

/**
 * 草图导入（T3-11 要点 1）。
 *
 * 上传的草图（图片）经此模块校验后转成 Provider 需要的载荷；
 * **Provider 不支持视觉时入口必须禁用并给出中文提示**，不允许静默失败。
 */

/** 支持的图片类型 */
export const SUPPORTED_SKETCH_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
] as const;
/** 草图上上限（8MB）：过大的图片先提示用户压缩，避免把接口打爆 */
export const MAX_SKETCH_BYTES = 8 * 1024 * 1024;

export interface SketchFileLike {
  name: string;
  size: number;
  type: string;
}

export type SketchPayloadKind = 'dataUrl' | 'path';

export interface SketchPayload {
  kind: SketchPayloadKind;
  value: string;
  mime: string;
  name: string;
  sizeBytes: number;
}

export interface SketchValidation {
  ok: boolean;
  message?: string;
}

/** 校验待上传的草图文件（类型 + 体积） */
export function validateSketchFile(file: SketchFileLike): SketchValidation {
  const mime = file.type.toLowerCase();
  if (!(SUPPORTED_SKETCH_TYPES as readonly string[]).includes(mime)) {
    return {
      ok: false,
      message: `不支持的图片类型「${file.type || '未知'}」，请使用 PNG / JPG / WebP`,
    };
  }
  if (file.size <= 0) return { ok: false, message: '图片内容为空' };
  if (file.size > MAX_SKETCH_BYTES) {
    return {
      ok: false,
      message: `图片超过 ${Math.round(MAX_SKETCH_BYTES / 1024 / 1024)}MB，请先压缩后再上传`,
    };
  }
  return { ok: true };
}

/** dataURL 的字节数（base64 解码长度） */
export function dataUrlByteLength(value: string): number {
  const comma = value.indexOf(',');
  const body = comma === -1 ? value : value.slice(comma + 1);
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

/** dataURL → 载荷（含类型与体积校验） */
export function createSketchFromDataUrl(
  value: string,
  name = 'sketch.png',
): { ok: true; payload: SketchPayload } | { ok: false; message: string } {
  const match = /^data:([^;,]+)[;,]/.exec(value);
  const mime = match?.[1]?.toLowerCase() ?? 'image/png';
  const sizeBytes = dataUrlByteLength(value);
  const validation = validateSketchFile({ name, size: sizeBytes, type: mime });
  if (!validation.ok) return { ok: false, message: validation.message ?? '草图校验失败' };
  return { ok: true, payload: { kind: 'dataUrl', value, mime, name, sizeBytes } };
}

/** 本地路径 → 载荷（体积由外壳读盘时校验） */
export function createSketchFromPath(
  path: string,
  options: { mime?: string; name?: string } = {},
): SketchPayload {
  const name = options.name ?? path.split(/[\\/]/).pop() ?? 'sketch.png';
  const mime = options.mime ?? guessMime(name);
  return { kind: 'path', value: path, mime, name, sizeBytes: 0 };
}

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

/** Provider 是否具备视觉能力（无设计端口视为不支持） */
export function isVisionSupported(port: DesignGenerationPort | undefined): boolean {
  return port?.supportsVision === true;
}

/** 草图中文描述（UI 展示） */
export function describeSketch(payload: SketchPayload): string {
  const size = payload.sizeBytes > 0 ? `${Math.round(payload.sizeBytes / 1024)}KB` : '大小未知';
  return `${payload.name}（${payload.mime}，${size}）`;
}

/** 处理 File 输入：读成 dataURL 后校验（浏览器环境） */
export async function readSketchFile(
  file: File,
): Promise<{ ok: true; payload: SketchPayload } | { ok: false; message: string }> {
  const validation = validateSketchFile(file);
  if (!validation.ok) return { ok: false, message: validation.message ?? '草图校验失败' };
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
  return createSketchFromDataUrl(dataUrl, file.name);
}
