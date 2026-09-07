import { describe, it, expect } from 'vitest';

import type { SearchQuery } from '../../../../src/services/ai-service';

import { emailMatchesLiveSearchFilter, hasLiveSearchFilterTokens } from '../../../../src/utils/search-filter';

const q = (over: Partial<SearchQuery> = {}): SearchQuery => over as SearchQuery;

describe('emailMatchesLiveSearchFilter', () => {
  // The search list is a DB snapshot. Optimistic actions mutate a row's tags in
  // place, so without this re-check a just-read mail lingers under `is:unread`
  // until the user re-runs the search.
  it('drops a row that has been READ while an is:unread filter is active', () => {
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|' }, q({ isUnread: true }))).toBe(true);
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|read|' }, q({ isUnread: true }))).toBe(false);
  });

  it('drops a row that has been marked UNREAD while an is:read filter is active', () => {
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|read|' }, q({ isUnread: false }))).toBe(true);
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|' }, q({ isUnread: false }))).toBe(false);
  });

  it('drops a row that has been UNSTARRED while an is:starred filter is active', () => {
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|starred|' }, q({ isFlagged: true }))).toBe(true);
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|' }, q({ isFlagged: true }))).toBe(false);
  });

  it('does NOT drop rows for isFlagged:false (there is no "is:unstarred" token)', () => {
    // Only the three tokens listed in the module doc are evaluated; anything
    // else must pass through untouched.
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|starred|' }, q({ isFlagged: false }))).toBe(true);
  });

  it('passes through every SERVER-side field — filtering those client-side would hide real hits', () => {
    // from/to/subject/attachments/labels/category/date/size define the server
    // query and cannot change from a user action, so a row the server already
    // matched must never be dropped here.
    const serverOnly = q({ from: 'someone@else.com', hasAttachments: true, subject: 'invoice' } as Partial<SearchQuery>);
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|' }, serverOnly)).toBe(true);
  });

  it('keeps a row when several live tokens are all still satisfied', () => {
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|starred|' }, q({ isUnread: true, isFlagged: true }))).toBe(true);
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|read|starred|' }, q({ isUnread: true, isFlagged: true }))).toBe(false);
  });

  it('treats missing/empty tags as unread and unstarred', () => {
    expect(emailMatchesLiveSearchFilter({}, q({ isUnread: true }))).toBe(true);
    expect(emailMatchesLiveSearchFilter({ tags: null }, q({ isFlagged: true }))).toBe(false);
  });

  it('matches whole delimited tags only (an "unread" label must not read as |read|)', () => {
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|already-read-ish|' }, q({ isUnread: true }))).toBe(true);
  });

  it('keeps everything when the filter carries no live tokens at all', () => {
    expect(emailMatchesLiveSearchFilter({ tags: '|INBOX|read|' }, q())).toBe(true);
  });
});

describe('hasLiveSearchFilterTokens', () => {
  // Gates whether the (per-row) predicate above runs at all — a false positive
  // here costs a pointless pass over the whole search snapshot on every render.
  it('is true when either live token is present, including the explicit false form', () => {
    expect(hasLiveSearchFilterTokens(q({ isUnread: true }))).toBe(true);
    expect(hasLiveSearchFilterTokens(q({ isUnread: false }))).toBe(true); // is:read
    expect(hasLiveSearchFilterTokens(q({ isFlagged: true }))).toBe(true);
    expect(hasLiveSearchFilterTokens(q({ isFlagged: false }))).toBe(true);
  });

  it('is false for a filter with only server-side fields', () => {
    expect(hasLiveSearchFilterTokens(q({ from: 'a@x.com' } as Partial<SearchQuery>))).toBe(false);
    expect(hasLiveSearchFilterTokens(q())).toBe(false);
  });

  it('is false for a null/undefined filter (no active search)', () => {
    expect(hasLiveSearchFilterTokens(null)).toBe(false);
    expect(hasLiveSearchFilterTokens(undefined)).toBe(false);
  });
});
