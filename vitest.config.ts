import path from 'path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Each test file in its own child PROCESS, never a worker thread. Pinned, not
    // left to vitest's default, because that default has already moved once
    // (`threads` up to vitest 1, `forks` from 2): under the old one these suites
    // failed inside Electron, and they pass today only because the default moved.
    //
    // Inside Electron means `ELECTRON_RUN_AS_NODE=1 electron vitest.mjs run`, the
    // way to run them while the dev app holds the Electron ABI. Worker threads
    // share one process, and in Electron's process SQLite's malloc goes through
    // Electron's own allocator: a CPU sample of the threaded run found those
    // calls, across the worker threads, waiting on one lock inside it
    // (`_os_unfair_lock_lock_slow`). body-relocation.test.ts took 381 ms alone
    // and 57 s in the full storage-node run, the heaviest tests blew their 5 s
    // timeout, and a test that timed out kept running and logging into the next
    // one, failing that too. Forced onto threads under vitest 3 the run crashed
    // Electron with SIGSEGV. The same threaded run under plain Node is fast, so CI
    // never saw any of it — `test-pool-guard.test.ts` in storage-node and desktop
    // is what fails if this is switched back.
    pool: 'forks',
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
