import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * 渲染层 Vite 配置。
 * 双形态共用：Tauri dev 走 5173 端口；Electron dev 也加载同一地址。
 * @ec/* 直接指向各包 src（源码级引用，跳过构建产物）。
 */
export default defineConfig({
  // Electron 生产环境通过 file:// 加载；相对资源路径同时兼容 Tauri 自定义协议。
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      // 注意顺序：CSS 子路径别名必须放在 @ec/ui 之前（alias 按前缀匹配）
      '@ec/ui/tokens.css': resolve(__dirname, '../../packages/ui/src/tokens.css'),
      '@ec/ui/styles.css': resolve(__dirname, '../../packages/ui/src/styles.css'),
      '@ec/shell-api': resolve(__dirname, '../../packages/shell-api/src/index.ts'),
      '@ec/ai': resolve(__dirname, '../../packages/ai/src/browser.ts'),
      // core 走浏览器条件入口：排除 docs 的 docx / pdf / image-ocr 解析器（node:zlib）
      '@ec/core': resolve(__dirname, '../../packages/core/src/browser.ts'),
      '@ec/ui': resolve(__dirname, '../../packages/ui/src/index.ts'),
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
});
