/**
 * 渲染层全局类型声明：window.ecShell 即 preload 通过 contextBridge 暴露的安全接口。
 * 该接口严格对应 channels.ts 的 ElectronShellApi，渲染层业务只能通过它访问外壳能力。
 */
import type { ElectronShellApi } from '../channels';

declare global {
  interface Window {
    ecShell: ElectronShellApi;
  }
}
