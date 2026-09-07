import { describe, expect, it } from 'vitest';

import { bulkTagUpdates } from '../../../../electron/services/bulk-backfill';

// The bulk backfill re-reads List-Id/List-Unsubscribe/Precedence for already-stored
// mail and tags the bulk ones. bulkTagUpdates is the pure decision: only UID-bearing
// rows that the server says are bulk and aren't already tagged get a |bulk| tag,
// preserving their existing tags.

describe('bulkTagUpdates', () => {
  it('tags only the bulk UIDs, preserving existing tags', () => {
    const rows = [
      { id: 'a', uid: 1, tags: '|INBOX|read|' },   // bulk
      { id: 'b', uid: 2, tags: '|INBOX|' },         // not bulk
    ];
    const updates = bulkTagUpdates(rows, new Set([1]));
    expect(updates).toEqual([{ id: 'a', tags: '|INBOX|read|bulk|' }]);
  });

  it('skips rows already tagged bulk (idempotent re-run)', () => {
    const rows = [{ id: 'a', uid: 1, tags: '|INBOX|bulk|' }];
    expect(bulkTagUpdates(rows, new Set([1]))).toEqual([]);
  });

  it('skips UID-less rows (uid null or <= 0) — no server UID to trust', () => {
    const rows = [
      { id: 'a', uid: null, tags: '|INBOX|' },
      { id: 'b', uid: 0, tags: '|INBOX|' },
    ];
    expect(bulkTagUpdates(rows, new Set([0]))).toEqual([]);
  });

  it('returns nothing when no row is bulk', () => {
    const rows = [{ id: 'a', uid: 1, tags: '|INBOX|' }, { id: 'b', uid: 2, tags: '|INBOX|' }];
    expect(bulkTagUpdates(rows, new Set())).toEqual([]);
  });

  it('handles an empty/blank tag string', () => {
    const rows = [{ id: 'a', uid: 5, tags: '' }];
    const updates = bulkTagUpdates(rows, new Set([5]));
    expect(updates).toHaveLength(1);
    expect(updates[0].tags).toContain('|bulk|');
  });
});
