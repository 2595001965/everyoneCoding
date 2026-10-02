/**
 * 项目缩略图截图端口（V2-D02，Electron 专属能力）。
 *
 * 为什么放在这里而不是 domain 层：预览域必须保持"不 import electron"（bootstrap 的
 * 装配纪律，见 `runtime/bootstrap.ts` 头注释），所以离屏窗口截图作为端口注入
 * `createPreviewDomain({ capturePage })`；Tauri/测试形态不注入 ⇒ 缩略图如实不生成，
 * 工作台卡片显示明确占位，而不是假图。
 *
 * 安全边界：离屏窗口只加载**本机预览服务**的 URL（127.0.0.1，由预览域生成），
 * 不挂 preload、不开 nodeIntegration；截图完成后窗口立即销毁，不驻留。
 */
import { BrowserWindow, nativeImage } from 'electron';

/** 截图视口（4:3，卡片缩略图按宽缩放） */
const VIEWPORT = { width: 640, height: 480 } as const;
/** 缩略图落盘宽度（再放大无意义，控制 data URL 体积） */
const THUMBNAIL_WIDTH = 480;
/** 单次截图超时：页面挂起也不能拖住预览启动流程 */
const CAPTURE_TIMEOUT_MS = 10_000;

export function createPageCapturePort(): (url: string) => Promise<Buffer | null> {
  return async (url: string): Promise<Buffer | null> => {
    // 仅允许本机回环地址：这个端口只用于预览页截图，不做通用网页快照
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(`${url}/`)) return null;
    let window: BrowserWindow | null = null;
    // 整体超时兜底：页面挂起也不能拖住调用方（预览启动流程是 fire-and-forget 调它）
    const timeout = new Promise<null>((resolveTimeout) =>
      setTimeout(() => resolveTimeout(null), CAPTURE_TIMEOUT_MS),
    );
    const capture = (async (): Promise<Buffer | null> => {
      try {
        window = new BrowserWindow({
          ...VIEWPORT,
          show: false,
          frame: false,
          // 后台渲染：不可见窗口也产帧，否则 capturePage 拿到的是空图
          webPreferences: { backgroundThrottling: false, offscreen: true },
        });
        const target = window;
        await target.loadURL(url);
        // did-finish-load 后再让出一拍，等首屏 paint 提交（dev server 冷启动时首帧慢）
        await new Promise<void>((resolvePaint) => {
          target.webContents.once('did-frame-finish-load', () => setTimeout(resolvePaint, 120));
          setTimeout(resolvePaint, 2_000);
        });
        const image = await target.webContents.capturePage();
        if (image.isEmpty()) return null;
        const resized =
          image.getSize().width > THUMBNAIL_WIDTH
            ? nativeImage.createFromBuffer(image.toPNG()).resize({ width: THUMBNAIL_WIDTH })
            : image;
        const png = resized.toPNG();
        return png.length > 0 ? png : null;
      } catch {
        return null;
      } finally {
        const created = window;
        window = null;
        if (created !== null && !created.isDestroyed()) created.destroy();
      }
    })();
    return Promise.race([capture, timeout]);
  };
}

/** 供测试与诊断引用的视口常量（保持单一来源） */
export const PAGE_CAPTURE_VIEWPORT = VIEWPORT;
export const PAGE_CAPTURE_TIMEOUT_MS = CAPTURE_TIMEOUT_MS;
