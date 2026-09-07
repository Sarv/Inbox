import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types/**',
      ],
    },
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'build', '.expo'],
  },
  resolve: {
    alias: {
      '@sarvinbox/core': path.resolve(__dirname, './packages/core/src'),
      '@sarvinbox/storage-node': path.resolve(__dirname, './packages/storage-node/src'),
      '@sarvinbox/storage-mobile': path.resolve(__dirname, './packages/storage-mobile/src'),
      '@sarvinbox/ui-shared': path.resolve(__dirname, './packages/ui-shared/src'),
      '@sarvinbox/ui-primitives': path.resolve(__dirname, './packages/ui-primitives/src'),
    },
  },
});
