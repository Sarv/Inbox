import { isMainThread } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

// What breaks if this file fails: the rest of this suite — slowly, intermittently,
// and only for whoever runs it inside Electron, which CI never does.
//
// vitest.config.ts pins `pool: 'forks'`; the comment there has the measurements.
// As worker threads sharing one Electron process, this suite's SQLite work queues
// on Electron's allocator: body-relocation.test.ts went from 381 ms to 57 s, the
// pacing and bulkUpdateTags tests blew their 5 s timeout, and the pacing test
// that timed out kept logging into the next one ("names the account database"),
// failing that as well. Three failures, none of them a bug in the code under
// test. Plain Node shows none of it, so without this check CI stays green while
// the pool is switched back.
describe('storage-node test runtime', () => {
  it('runs each test file in its own process, not in a worker thread', () => {
    expect(
      isMainThread,
      'storage-node tests must run with pool: "forks" — see the pool comment in vitest.config.ts',
    ).toBe(true);
  });
});
