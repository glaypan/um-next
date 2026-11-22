import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // `src/**/__tests__` 是纯算法单测（无 DOM 依赖）；`tests/**` 是文件级 E2E，
    // 需要 Node 的 fs/crypto，各自用 `// @vitest-environment node` 覆盖环境。
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.ts'],
    passWithNoTests: true,
  },
});
