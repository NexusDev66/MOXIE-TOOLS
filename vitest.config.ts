import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest 配置
 *
 * 目标：覆盖 src/app/api/internal/* 的 route handler 单测。
 * 排除：cli/、node_modules/、.next/、e2e（如果以后加）
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Next 运行时守卫在 vite/node 测试环境无法解析，alias 到空 stub（测试里本就 no-op）
      'server-only': path.resolve(__dirname, './src/test/server-only-stub.ts'),
      'client-only': path.resolve(__dirname, './src/test/server-only-stub.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: [
      'node_modules/**',
      '.next/**',
      'cli/**',
      'dist/**',
    ],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/app/api/**', 'src/lib/sync/**'],
    },
  },
});
