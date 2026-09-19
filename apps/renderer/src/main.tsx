import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './error-boundary';
import { createShell, detectShellKind, negotiate } from '@ec/shell-api';
import { createRendererAiSettings } from './runtime/ai-settings';
import { installDomainPorts } from './runtime/domain-ports';
import { settingsStore } from '@ec/core';
import { useAppStore } from './store/useAppStore';
import '@ec/ui/tokens.css';
import '@ec/ui/styles.css';
import './theme/app.css';
import './features/memory/memory.css';
import './features/settings/settings.css';
import './features/pipeline/pipeline.css';

/**
 * 应用启动：
 * 1. createShell() 探测外壳（Tauri / Electron / mock）——渲染层零感知外壳差异
 * 2. negotiate() 能力协商，缺失能力降级
 * 3. 挂载 ErrorBoundary + App
 */

async function bootstrap(): Promise<void> {
  let shellKind = 'mock';
  let degraded: string[] = [];
  let domainReport = '';
  try {
    // 外壳包只在对应运行环境中加载：其模块副作用会注册 ShellFactory。
    // 这样渲染层仍不感知 Electron/Tauri API，同时生产启动不会因为工厂未注册而静默回退。
    const detected = detectShellKind();
    if (detected === 'electron') await import('../../desktop-electron/src/bridge');
    if (detected === 'tauri') await import('../../desktop-tauri/src/bridge');
    const shell = await createShell();
    const handshake = await negotiate(shell);
    shellKind = handshake.kind;
    degraded = handshake.degraded;
    (
      globalThis as unknown as { __EC_SHELL__?: unknown; __EC_AI_SETTINGS__?: unknown }
    ).__EC_SHELL__ = shell;
    if (handshake.capabilities.ai) {
      try {
        const api = await createRendererAiSettings(shell.ai);
        (globalThis as unknown as { __EC_AI_SETTINGS__?: unknown }).__EC_AI_SETTINGS__ = api;
      } catch (error) {
        console.warn(
          `[bootstrap] AI 设置初始化失败：${error instanceof Error ? error.message : ''}`,
        );
      }
    }
    if (handshake.capabilities.domain) {
      try {
        // 只有 describe() 报 available 的域才会产出端口；未装配的域保持不注入，
        // 对应页面继续显示既有的装配引导（而不是拿到一个每个动作都失败的空壳）。
        const result = await installDomainPorts(shell.domain);
        domainReport = result.installed.join(',') || '无';
        if (result.unavailable.length > 0) {
          const reasons = result.unavailable
            .map((item) => `${item.kind}（${item.reason ?? '未装配'}）`)
            .join('；');
          console.info(`[bootstrap] 域端口未装配：${reasons}`);
        }
      } catch (error) {
        domainReport = '装配失败';
        console.warn(`[bootstrap] 域端口装配失败：${error instanceof Error ? error.message : ''}`);
      }
    }
  } catch (error) {
    // 无外壳环境（纯浏览器开发）自动回退 mock
    console.warn(
      `[bootstrap] 外壳创建失败，回退 mock：${error instanceof Error ? error.message : ''}`,
    );
  }

  useAppStore.getState().setShellReady(shellKind, degraded);
  console.info(
    `[bootstrap] 外壳=${shellKind} 主题=${settingsStore.getGlobal().theme} 降级能力=[${degraded.join(', ')}]` +
      (domainReport ? ` 域端口=[${domainReport}]` : ''),
  );

  const root = document.getElementById('root');
  if (!root) throw new Error('未找到 #root 挂载点');
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

void bootstrap();
