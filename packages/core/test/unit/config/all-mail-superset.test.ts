import { describe, it, expect } from 'vitest';

import { isAllMailSuperset } from '../../../src/config/folder-mapping';

// The backfill uses this to fetch each Gmail message ONCE (via All Mail) instead
// of once per label. It must match the \All superset but NOT a disjoint \Archive.
describe('isAllMailSuperset', () => {
  it('matches the \\All special-use (Gmail All Mail)', () => {
    expect(isAllMailSuperset({ path: '[Gmail]/All Mail', specialUse: '\\All' })).toBe(true);
  });

  it('matches by path when SPECIAL-USE is absent', () => {
    expect(isAllMailSuperset({ path: '[Gmail]/All Mail' })).toBe(true);
    expect(isAllMailSuperset({ path: 'All Mail' })).toBe(true);
  });

  it('does NOT match a disjoint \\Archive folder', () => {
    expect(isAllMailSuperset({ path: 'Archive', specialUse: '\\Archive' })).toBe(false);
  });

  it('does NOT match ordinary folders', () => {
    expect(isAllMailSuperset({ path: 'INBOX', specialUse: '\\Inbox' })).toBe(false);
    expect(isAllMailSuperset({ path: 'Sent', specialUse: '\\Sent' })).toBe(false);
    expect(isAllMailSuperset({ path: 'Work/All Mailings' })).toBe(false); // not "All Mail"
  });
});
