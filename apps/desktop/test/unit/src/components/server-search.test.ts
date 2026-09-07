import { describe, expect, it } from 'vitest';

import {
  canOfferServerSearch,
  describeServerSearchResult,
  hasServerSearchableParsedQuery,
  shouldAutoEscalateToServer,
} from '../../../../src/components/server-search';

// These decide WHEN the app reaches past the local index to the server, and what
// it tells the user afterwards. If they regress the failure is invisible: a
// searchable query never escalates (mail on the server stays hidden), or a
// flag-only query escalates and re-fetches the whole folder, or the status chip
// lies about what happened.

describe('hasServerSearchableParsedQuery', () => {
  it('is true for any text/header/date/size term', () => {
    // Regression: these are the terms the server can act on. A false here means
    // that query never gets a server round-trip and stays local-only.
    for (const parsed of [
      { textQuery: 'invoice' },
      { from: 'a@b.com' },
      { to: 'a@b.com' },
      { cc: 'a@b.com' },
      { subject: 'report' },
      { dateFrom: 1 },
      { dateTo: 1 },
      { sizeMin: 1 },
      { sizeMax: 1 },
    ]) {
      expect(hasServerSearchableParsedQuery(parsed)).toBe(true);
    }
  });

  it('is false for empty, whitespace-only text, flag-only, or non-object input', () => {
    // Regression: a pure flag/category query is fully answered locally; escalating
    // it re-fetches the folder for nothing. Blank text must not count as a term.
    expect(hasServerSearchableParsedQuery({})).toBe(false);
    expect(hasServerSearchableParsedQuery({ textQuery: '   ' })).toBe(false);
    expect(hasServerSearchableParsedQuery({ isUnread: true, aiCategory: 'Important' })).toBe(false);
    expect(hasServerSearchableParsedQuery(null)).toBe(false);
    expect(hasServerSearchableParsedQuery(undefined)).toBe(false);
    expect(hasServerSearchableParsedQuery('subject:x')).toBe(false);
  });
});

describe('shouldAutoEscalateToServer', () => {
  const base = {
    hasServerSearchableTerms: true,
    localResultCount: 2,
    pageSize: 25,
    page: 0,
    alreadyRanServer: false,
    isUnifiedView: false,
  };

  it('escalates on the first page when local came back thin', () => {
    // Regression: the core promise — a searchable query that under-fills the first
    // page must auto-reach the server so results are not silently truncated.
    expect(shouldAutoEscalateToServer(base)).toBe(true);
  });

  it('does not escalate when the local page is already full', () => {
    // Regression: a full page means local is plenty; an automatic server sweep
    // would be wasted work (the manual button still exists for a forced sweep).
    expect(shouldAutoEscalateToServer({ ...base, localResultCount: 25 })).toBe(false);
  });

  it('never escalates a flag-only query, past the first page, twice, or in unified view', () => {
    // Regression: each of these guards prevents a distinct waste/error — folder
    // re-fetch, mid-pagination churn, duplicate sweeps, or a no-single-folder view.
    expect(shouldAutoEscalateToServer({ ...base, hasServerSearchableTerms: false })).toBe(false);
    expect(shouldAutoEscalateToServer({ ...base, page: 1 })).toBe(false);
    expect(shouldAutoEscalateToServer({ ...base, alreadyRanServer: true })).toBe(false);
    expect(shouldAutoEscalateToServer({ ...base, isUnifiedView: true })).toBe(false);
  });
});

describe('canOfferServerSearch', () => {
  it('offers the manual button only for a searchable query in a single-folder view', () => {
    // Regression: the button must appear when (and only when) a server search can
    // actually run — offering it in unified view or for a flag-only query misleads.
    expect(canOfferServerSearch({ hasServerSearchableTerms: true, isUnifiedView: false })).toBe(true);
    expect(canOfferServerSearch({ hasServerSearchableTerms: false, isUnifiedView: false })).toBe(false);
    expect(canOfferServerSearch({ hasServerSearchableTerms: true, isUnifiedView: true })).toBe(false);
  });
});

describe('describeServerSearchResult', () => {
  it('summarises a completed search for the status chip', () => {
    // Regression: the chip must tell the truth about what the sweep did — "found
    // N more" only when mail was actually downloaded, otherwise the quieter states.
    expect(describeServerSearchResult({ skipped: false, matched: 7, inserted: 3 }))
      .toBe('Found 3 more on the server');
    expect(describeServerSearchResult({ skipped: false, matched: 4, inserted: 0 }))
      .toBe('All server matches already downloaded');
    expect(describeServerSearchResult({ skipped: false, matched: 0, inserted: 0 }))
      .toBe('No more matches on the server');
  });

  it('stays silent for a skipped or missing result', () => {
    // Regression: a skipped (non-searchable) or failed run must not post a chip —
    // a stale "No more matches" message would confuse the next search.
    expect(describeServerSearchResult({ skipped: true, matched: 0, inserted: 0 })).toBeNull();
    expect(describeServerSearchResult(null)).toBeNull();
  });
});
