import { describe, it, expect } from 'vitest';

import { INBOX_QUICK_FILTERS, QUICK_SEARCH_SUGGESTIONS } from '../../../../src/config/search-suggestions';

describe('QUICK_SEARCH_SUGGESTIONS', () => {
  // The chips shown when the search bar is focused. Each chip's `query` is
  // pasted verbatim into the search box, so it must be a real search token.
  it('gives every chip a label, an icon component and a search token', () => {
    for (const s of QUICK_SEARCH_SUGGESTIONS) {
      expect(s.label).toBeTruthy();
      expect(s.icon).toBeTruthy();
      expect(s.query).toMatch(/^(is|has|from|in):[a-z]+$/);
    }
  });

  it('has no duplicate queries (two chips inserting the same token)', () => {
    const queries = QUICK_SEARCH_SUGGESTIONS.map((s) => s.query);
    expect(new Set(queries).size).toBe(queries.length);
  });

  it('offers the read/unread pair, starred, attachment, from:me, sent and unlabelled', () => {
    expect(QUICK_SEARCH_SUGGESTIONS.map((s) => s.query)).toEqual([
      'is:unread',
      'is:starred',
      'has:attachment',
      'from:me',
      'in:sent',
      'is:read',
      'is:unlabelled',
    ]);
  });
});

describe('INBOX_QUICK_FILTERS', () => {
  // Keyed by the EXACT chip query so only a bare filter click narrows the
  // sectioned inbox in place; "is:unread meeting" must still text-search.
  it('is keyed by a query string that an actual chip produces', () => {
    const chipQueries = new Set(QUICK_SEARCH_SUGGESTIONS.map((s) => s.query));
    for (const key of Object.keys(INBOX_QUICK_FILTERS)) {
      expect(chipQueries.has(key)).toBe(true);
    }
  });

  it('maps is:unread / is:read to OPPOSITE isUnread values (not both true)', () => {
    // The classic bug: both chips mapping to `isUnread: true` makes "Read" show
    // unread mail. The `false` must be an explicit false, never undefined.
    expect(INBOX_QUICK_FILTERS['is:unread'].filter).toEqual({ isUnread: true });
    expect(INBOX_QUICK_FILTERS['is:read'].filter).toEqual({ isUnread: false });
  });

  it('maps starred / attachment / unlabelled to their ViewFilter fields', () => {
    expect(INBOX_QUICK_FILTERS['is:starred'].filter).toEqual({ isFlagged: true });
    expect(INBOX_QUICK_FILTERS['has:attachment'].filter).toEqual({ hasAttachments: true });
    expect(INBOX_QUICK_FILTERS['is:unlabelled'].filter).toEqual({ noCategory: true });
  });

  it('carries the chip label so the active-filter pill reads the same as the chip', () => {
    for (const [query, entry] of Object.entries(INBOX_QUICK_FILTERS)) {
      const chip = QUICK_SEARCH_SUGGESTIONS.find((s) => s.query === query);
      expect(entry.label).toBe(chip?.label);
    }
  });

  it('deliberately omits the chips that cannot become a ViewFilter', () => {
    // from:me and in:sent are text/folder searches — routing them through the
    // sectioned inbox would silently drop the sender/folder constraint.
    expect(INBOX_QUICK_FILTERS['from:me']).toBeUndefined();
    expect(INBOX_QUICK_FILTERS['in:sent']).toBeUndefined();
  });
});
