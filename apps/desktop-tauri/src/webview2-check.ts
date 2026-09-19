/**
 * WebView2 运行环境探测与缺失引导。
 *
 * 在渲染层入口调用 `ensureWebView2()`；若运行时缺失，调用 `renderWebView2Guide()`
 * 渲染安装引导界面，避免出现白屏。
 */

import { invoke } from '@tauri-apps/api/core';

/** 探测结果。 */
export interface WebView2Status {
  ok: boolean;
  guideUrl: string;
}

const DEFAULT_GUIDE_URL = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

/** 调用 Rust 命令探测 WebView2 运行时。失败时（非 Tauri 环境等）保守放行，避免阻塞。 */
export async function ensureWebView2(): Promise<WebView2Status> {
  try {
    const result = await invoke<WebView2Status>('webview2_check');
    return {
      ok: result.ok,
      guideUrl: result.guideUrl || DEFAULT_GUIDE_URL,
    };
  } catch (err) {
    console.warn('[webview2] 探测失败，按可用处理：', err);
    return { ok: true, guideUrl: DEFAULT_GUIDE_URL };
  }
}

/** 在容器内渲染 WebView2 安装引导（不白屏，始终渲染可见内容）。 */
export function renderWebView2Guide(
  container: HTMLElement,
  guideUrl: string = DEFAULT_GUIDE_URL,
): void {
  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;flex-direction:column;gap:16px;align-items:center;justify-content:center;' +
    'height:100%;width:100%;padding:32px;box-sizing:border-box;' +
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2329;';

  const title = document.createElement('h1');
  title.textContent = '需要安装 WebView2 运行时';
  title.style.fontSize = '22px';
  title.style.margin = '0';

  const desc = document.createElement('p');
  desc.textContent =
    'EveryoneCoding 依赖 Microsoft WebView2 运行环境。请点击下方按钮下载并安装「Evergreen 独立安装包」，安装完成后重新启动应用。';
  desc.style.maxWidth = '520px';
  desc.style.textAlign = 'center';
  desc.style.lineHeight = '1.6';
  desc.style.margin = '0';

  const button = document.createElement('a');
  button.href = guideUrl;
  button.target = '_blank';
  button.rel = 'noopener noreferrer';
  button.textContent = '下载并安装 WebView2';
  button.style.cssText =
    'display:inline-block;padding:12px 24px;border-radius:8px;background:#3b82f6;' +
    'color:#fff;text-decoration:none;font-weight:600;';

  const steps = document.createElement('ol');
  steps.style.maxWidth = '520px';
  steps.style.lineHeight = '1.8';
  steps.style.paddingLeft = '20px';
  steps.style.margin = '0';
  const items = [
    '点击上方按钮，下载 WebView2 安装包。',
    '运行安装包，按提示完成安装。',
    '关闭并重新启动 EveryoneCoding。',
  ];
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    steps.appendChild(li);
  }

  wrap.appendChild(title);
  wrap.appendChild(desc);
  wrap.appendChild(button);
  wrap.appendChild(steps);
  container.appendChild(wrap);
}
