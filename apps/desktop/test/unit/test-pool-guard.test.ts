import { isMainThread } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

// What breaks if this file fails: the suites here that open real SQLite (the
// reputation cache, the domain-identity store, the local mirror's content hash)
// when they run inside Electron — and nothing at all under plain Node, which is
// why it needs a check of its own.
//
// vitest.config.ts pins `pool: 'forks'`. As worker threads sharing one Electron
// process this suite ran 4x slower, and the storage-node suite, which leans on
// SQLite far harder, timed out and failed; the root vitest.config.ts has the
// measurements. CI runs plain Node, so this is what notices the pool being
// switched back.
describe('desktop test runtime', () => {
  it('runs each test file in its own process, not in a worker thread', () => {
    expect(
      isMainThread,
      'desktop tests must run with pool: "forks" — see the pool comment in vitest.config.ts',
    ).toBe(true);
  });
});
