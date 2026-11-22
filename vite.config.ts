import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 纯静态、相对路径部署（可直接拖进任意静态服务器或 file:// 预览）
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: {
    // Safari 直到 15 才支持 module worker；macOS 10.14.6 最高只有 Safari 14.1，
    // 因此 Worker 必须打成经典 IIFE，并用 `new Worker(url)` 加载。
    format: 'iife',
  },
  build: {
    // 覆盖 macOS 10.14.6：Safari 12+ / Chrome 80+ / Firefox 78+
    target: ['safari12', 'chrome80', 'firefox78'],
    cssTarget: 'safari12',
    sourcemap: false,
  },
});
