import { describe, expect, it } from 'vitest';

import {
  buildImapSearchCriteria,
  hasServerSearchableCriteria,
} from '../../../src/imap/search-criteria';

// These map the renderer's parsed query onto an IMAP SERVER SEARCH. If they
// regress, server search silently searches for the WRONG thing (or nothing) —
// mail that exists on the server never surfaces, with no crash to notice.

describe('buildImapSearchCriteria', () => {
  it('maps text/header terms onto the criteria the server understands', () => {
    // Regression: a text/from/to/cc/subject term must reach the server verbatim
    // (trimmed) — dropping any one means that facet of the search never runs.
    const criteria = buildImapSearchCriteria({
      textQuery: '  invoice  ',
      from: ' alice@example.com ',
      to: ' bob@example.com ',
      cc: ' carol@example.com ',
      subject: ' quarterly report ',
    });
    expect(criteria).toEqual({
      text: 'invoice',
      from: 'alice@example.com',
      to: 'bob@example.com',
      cc: 'carol@example.com',
      subject: 'quarterly report',
    });
  });

  it('maps isUnread/isFlagged only when explicitly true', () => {
    // Regression: `seen`/`flagged` are opt-in. Emitting `unseen` for a plain
    // search would wrongly exclude every already-read message from the results.
    expect(buildImapSearchCriteria({ subject: 'x', isUnread: true, isFlagged: true }))
      .toMatchObject({ unseen: true, flagged: true });
    const noFlags = buildImapSearchCriteria({ subject: 'x', isUnread: false });
    expect(noFlags.unseen).toBeUndefined();
    expect(noFlags.flagged).toBeUndefined();
  });

  it('maps dateFrom→since and dateTo→before as Date objects', () => {
    // Regression: dates are stored as epoch-ms but imapflow wants Date. A wrong
    // conversion (or leaving them as numbers) makes the server reject the SEARCH.
    const from = Date.UTC(2026, 0, 1);
    const to = Date.UTC(2026, 1, 1);
    const criteria = buildImapSearchCriteria({ dateFrom: from, dateTo: to });
    expect(criteria.since).toBeInstanceOf(Date);
    expect(criteria.before).toBeInstanceOf(Date);
    expect((criteria.since as Date).getTime()).toBe(from);
    expect((criteria.before as Date).getTime()).toBe(to);
  });

  it('maps positive sizeMin→larger and sizeMax→smaller, ignoring zero/negative', () => {
    // Regression: only a real byte bound should map. A 0 bound is "no bound" —
    // emitting `larger: 0` would match everything and silently defeat the filter.
    expect(buildImapSearchCriteria({ sizeMin: 1024, sizeMax: 4096 }))
      .toMatchObject({ larger: 1024, smaller: 4096 });
    const zeroed = buildImapSearchCriteria({ sizeMin: 0, sizeMax: -1 });
    expect(zeroed.larger).toBeUndefined();
    expect(zeroed.smaller).toBeUndefined();
  });

  it('drops empty/whitespace strings rather than searching for ""', () => {
    // Regression: a blank term must not become an empty criterion — an empty
    // `text: ''` would match everything and flood the download with the folder.
    expect(buildImapSearchCriteria({ textQuery: '   ', from: '', subject: '' })).toEqual({});
  });
});

describe('hasServerSearchableCriteria', () => {
  it('is true for any text/header/date/size constraint', () => {
    // Regression: these are the terms worth a server round-trip. If the predicate
    // says false for one, that search is never escalated to the server.
    for (const criteria of [
      { text: 'x' },
      { from: 'x' },
      { to: 'x' },
      { cc: 'x' },
      { subject: 'x' },
      { since: new Date() },
      { before: new Date() },
      { larger: 10 },
      { smaller: 10 },
    ]) {
      expect(hasServerSearchableCriteria(criteria)).toBe(true);
    }
  });

  it('is false for empty criteria or a flag-only query', () => {
    // Regression: escalating a flag-only (or empty) query would re-fetch the whole
    // folder for nothing the local index cannot already answer.
    expect(hasServerSearchableCriteria({})).toBe(false);
    expect(hasServerSearchableCriteria({ unseen: true })).toBe(false);
    expect(hasServerSearchableCriteria({ flagged: true })).toBe(false);
  });
});
