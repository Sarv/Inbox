import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// CategoryBadges is imported by the slice for its cache-clear helper; the two
// pure functions under test never touch it, so a stub keeps the module graph
// free of IPC.
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
}));

import { buildEmailReplacementPatch, createEmailsSlice, sectionRowsPatch, selectLoadedEmailIds } from '../../../../../src/store/slices/emails-slice';
import { getPageSizeForView } from '../../../../../src/store/helpers';

/** The vitest env is 'node'; buildThreads (called through the patch) reads the
 *  Smart-Prioritize flag from localStorage on every rebuild. */
const installLocalStorage = () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  threadId: `t-${id}`,
  tags: '|INBOX|',
  date: 1_000,
  fromName: 'Sender',
  fromAddress: 's@x.com',
  ...over,
});

beforeEach(installLocalStorage);
afterEach(() => {
  delete (globalThis as any).localStorage;
});

describe('selectLoadedEmailIds', () => {
  // Answers "would refreshing this row change anything the user can SEE?" without
  // a DB round trip — re-reading a row we don't hold is pure waste, since
  // buildEmailReplacementPatch would drop it anyway.
  it('collects ids from the flat list and from every section bucket', () => {
    const ids = selectLoadedEmailIds({
      emails: [row('a'), row('b')],
      sectionData: {
        's1': { emails: [row('b'), row('c')] },
        's2': { emails: [row('d')] },
      },
    });
    expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd']); // 'b' deduped by the Set
  });

  it('returns an empty set for an empty store', () => {
    expect(selectLoadedEmailIds({ emails: [] }).size).toBe(0);
  });

  it('tolerates a missing/nullish emails array and sectionData', () => {
    expect(selectLoadedEmailIds({ emails: null as unknown as any[] }).size).toBe(0);
    expect(selectLoadedEmailIds({ emails: [row('a')], sectionData: undefined }).size).toBe(1);
  });

  it('skips a section bucket that has no emails yet (loading / null)', () => {
    const ids = selectLoadedEmailIds({
      emails: [],
      sectionData: { s1: { loading: true }, s2: null, s3: { emails: [row('z')] } },
    });
    expect([...ids]).toEqual(['z']);
  });
});

describe('buildEmailReplacementPatch', () => {
  // Swaps freshly-read rows in wherever the renderer already holds them, as ONE
  // pure patch so N rows fold into a single set(). It must NEVER add a row —
  // that is what stops an optimistically-deleted mail from being resurrected.
  it('returns null when there is nothing fresh to apply', () => {
    expect(buildEmailReplacementPatch({ emails: [row('a')] }, new Map())).toBeNull();
  });

  it('returns null when nothing on screen references any of the fresh rows', () => {
    // The caller can then skip set() entirely — no re-render at all.
    const patch = buildEmailReplacementPatch({ emails: [row('a')] }, new Map([['zzz', row('zzz')]]));
    expect(patch).toBeNull();
  });

  it('replaces the row in the flat list, leaving the others by reference', () => {
    const a = row('a');
    const b = row('b');
    const freshA = row('a', { tags: '|INBOX|read|' });
    const patch = buildEmailReplacementPatch({ emails: [a, b] }, new Map([['a', freshA]]));
    expect(patch?.emails?.[0]).toBe(freshA);
    expect(patch?.emails?.[1]).toBe(b); // untouched rows keep identity
    expect(patch?.sectionData).toBeUndefined();
  });

  it('does NOT resurrect a row the renderer no longer holds', () => {
    // An optimistically-deleted row must stay gone even though the DB still has it.
    const patch = buildEmailReplacementPatch(
      { emails: [row('a')] },
      new Map([['a', row('a', { tags: '|INBOX|read|' })], ['deleted', row('deleted')]]),
    );
    expect(patch?.emails?.map((e) => e.id)).toEqual(['a']);
  });

  it('replaces inside a section bucket AND rebuilds that bucket\'s threads', () => {
    // The sectioned inbox renders from `threads`, not `emails` — a patch that
    // updated only `emails` would leave the visible row stale.
    const stale = row('a', { tags: '|INBOX|' });
    const fresh = row('a', { tags: '|INBOX|read|' });
    const patch = buildEmailReplacementPatch(
      { emails: [], sectionData: { s1: { emails: [stale], total: 7, page: 0 } } },
      new Map([['a', fresh]]),
    );
    expect(patch?.sectionData?.s1.emails[0]).toBe(fresh);
    expect(patch?.sectionData?.s1.threads).toHaveLength(1);
    expect(patch?.sectionData?.s1.threads[0].hasUnread).toBe(false); // rebuilt from the FRESH tags
    // Non-email bucket metadata (pagination) is carried over, not dropped.
    expect(patch?.sectionData?.s1).toMatchObject({ total: 7, page: 0 });
  });

  it('leaves UNTOUCHED buckets identical (same object) so React skips them', () => {
    const untouched = { emails: [row('b')] };
    const patch = buildEmailReplacementPatch(
      { emails: [], sectionData: { s1: { emails: [row('a')] }, s2: untouched } },
      new Map([['a', row('a', { tags: '|INBOX|read|' })]]),
    );
    expect(patch?.sectionData?.s2).toBe(untouched);
    expect(patch?.sectionData?.s1).not.toBe(untouched);
  });

  it('patches the flat list and several buckets in ONE patch', () => {
    const patch = buildEmailReplacementPatch(
      {
        emails: [row('a'), row('b')],
        sectionData: { s1: { emails: [row('a')] }, s2: { emails: [row('c')] } },
      },
      new Map([
        ['a', row('a', { tags: '|INBOX|read|' })],
        ['c', row('c', { tags: '|INBOX|read|' })],
      ]),
    );
    expect(patch?.emails).toHaveLength(2);
    expect(patch?.sectionData?.s1.emails[0].tags).toBe('|INBOX|read|');
    expect(patch?.sectionData?.s2.emails[0].tags).toBe('|INBOX|read|');
  });

  it('skips a bucket with no emails array rather than crashing', () => {
    const patch = buildEmailReplacementPatch(
      { emails: [row('a')], sectionData: { s1: { loading: true }, s2: null } },
      new Map([['a', row('a', { tags: '|INBOX|read|' })]]),
    );
    expect(patch?.emails).toHaveLength(1);
    expect(patch?.sectionData).toBeUndefined();
  });

  it('returns a section-only patch when the flat list holds none of the rows', () => {
    const patch = buildEmailReplacementPatch(
      { emails: [row('x')], sectionData: { s1: { emails: [row('a')] } } },
      new Map([['a', row('a', { tags: '|INBOX|read|' })]]),
    );
    expect(patch?.emails).toBeUndefined();
    expect(patch?.sectionData).toBeDefined();
  });

  it('does not mutate the input state', () => {
    const state = { emails: [row('a')], sectionData: { s1: { emails: [row('a')] } } };
    const originalTags = state.emails[0].tags;
    buildEmailReplacementPatch(state, new Map([['a', row('a', { tags: '|INBOX|read|' })]]));
    expect(state.emails[0].tags).toBe(originalTags);
    expect(state.sectionData.s1.emails[0].tags).toBe(originalTags);
  });

  it('tolerates a nullish emails array alongside real section data', () => {
    const patch = buildEmailReplacementPatch(
      { emails: null as unknown as any[], sectionData: { s1: { emails: [row('a')] } } },
      new Map([['a', row('a', { tags: '|INBOX|read|' })]]),
    );
    expect(patch?.sectionData?.s1.emails[0].tags).toBe('|INBOX|read|');
  });
});

// A search view — and the flat-search quick-filters (Unread / Starred) that run
// through it — renders from `searchResults` ONLY. While that array was invisible
// to these two helpers, a mail read or unstarred in webmail was (a) not even
// re-read, because the row counted as "not held", and (b) not swapped in if it
// was, so the search list kept showing the stale read/starred state.
describe('search results as a first-class row holder', () => {
  it('counts searchResults rows as loaded, so they get re-read', () => {
    const ids = selectLoadedEmailIds({ emails: [row('a')], searchResults: [row('s1'), row('a')] });
    expect([...ids].sort()).toEqual(['a', 's1']); // 'a' deduped across both holders
  });

  it('tolerates a missing searchResults array', () => {
    expect(selectLoadedEmailIds({ emails: [row('a')], searchResults: undefined }).size).toBe(1);
  });

  it('swaps the fresh row into searchResults, keeping the others by reference', () => {
    const s1 = row('s1');
    const s2 = row('s2');
    const fresh = row('s1', { tags: '|INBOX|read|' });
    const patch = buildEmailReplacementPatch({ emails: [], searchResults: [s1, s2] }, new Map([['s1', fresh]]));
    expect(patch?.searchResults?.[0]).toBe(fresh);
    expect(patch?.searchResults?.[1]).toBe(s2);
    expect(patch?.emails).toBeUndefined(); // no flat-list re-render for a search-only change
  });

  it('patches the flat list AND searchResults in one patch', () => {
    const patch = buildEmailReplacementPatch(
      { emails: [row('a')], searchResults: [row('a')] },
      new Map([['a', row('a', { tags: '|INBOX|read|' })]]),
    );
    expect(patch?.emails?.[0].tags).toBe('|INBOX|read|');
    expect(patch?.searchResults?.[0].tags).toBe('|INBOX|read|');
  });

  it('returns null when the search list holds none of the fresh rows', () => {
    expect(buildEmailReplacementPatch({ emails: [], searchResults: [row('s1')] }, new Map([['zzz', row('zzz')]])))
      .toBeNull();
  });

  it('never adds a row to searchResults that is not already there', () => {
    // Same no-resurrection rule as the flat list: an optimistically-removed
    // search hit must stay gone.
    const patch = buildEmailReplacementPatch(
      { emails: [], searchResults: [row('s1')] },
      new Map([['s1', row('s1', { tags: '|INBOX|read|' })], ['other', row('other')]]),
    );
    expect(patch?.searchResults?.map((e: any) => e.id)).toEqual(['s1']);
  });

  it('does not mutate the input searchResults', () => {
    const state = { emails: [], searchResults: [row('s1')] };
    buildEmailReplacementPatch(state, new Map([['s1', row('s1', { tags: '|INBOX|read|' })]]));
    expect(state.searchResults[0].tags).toBe('|INBOX|');
  });
});

describe('fetchEmailBody — a defer must not park the email', () => {
  /**
   * `failedBodies` is a session-permanent skip list: `fetchEmailBody` returns
   * early for anything in it, and so does `fetchBodiesForVisibleEmails`. Before
   * this, only "queue full" was treated as retryable — so an engine DEFER
   * (folder wouldn't open, cooling down after timeouts) parked the email and the
   * user saw a body-less mail until the app restarted.
   */
  interface Harness {
    state: Record<string, any>;
    slice: any;
    synced: number;
  }

  const harness = (fetchBody: () => Promise<any>): Harness => {
    const h: Harness = {
      state: {
        loadingBodies: new Set<string>(),
        failedBodies: new Set<string>(),
        emails: [row('e1')],
        threadEmails: [],
        searchResults: [],
        folders: [],
        selectedFolderId: null,
        viewAccountId: 'acct-a',
        sectionData: undefined,
      },
      slice: null,
      synced: 0,
    };
    (globalThis as any).window = { electronAPI: { emails: { fetchBody } } };
    const set = (patch: Record<string, any>) => { Object.assign(h.state, patch); };
    const get = () => ({ ...h.state, ...h.slice, syncEmails: async () => { h.synced += 1; } });
    h.slice = createEmailsSlice(set as any, get as any, undefined as any);
    return h;
  };

  afterEach(() => { delete (globalThis as any).window; });

  it('leaves a DEFERRED body out of failedBodies so a later tick retries it', async () => {
    const h = harness(async () => ({
      success: false,
      error: 'Body fetch deferred (folder "INBOX" would not open) — will retry',
    }));
    await h.slice.fetchEmailBody('e1');
    expect(h.state.failedBodies.has('e1')).toBe(false);
    expect(h.state.loadingBodies.has('e1')).toBe(false); // the finally-block always releases
    expect(h.synced).toBe(0);                            // and never asks for a deletion reconcile
  });

  it('still parks a body that genuinely could not be fetched', async () => {
    // The skip list keeps its original job: without this the renderer retries a
    // dead row on every render. This wording says nothing about the server, so
    // no reconcile is asked for either.
    const h = harness(async () => ({ success: false, error: 'No message found for UID 9' }));
    await h.slice.fetchEmailBody('e1');
    expect(h.state.failedBodies.has('e1')).toBe(true);
    expect(h.synced).toBe(0);
  });

  it('asks the GUARDED folder sync to reconcile one that looks gone', async () => {
    // Never a blind expunge from a single failed body fetch — the folder sync is
    // the only path with the empty-list / mass-deletion-ratio safety nets.
    const h = harness(async () => ({ success: false, error: 'Message not found on server' }));
    await h.slice.fetchEmailBody('e1');
    expect(h.state.failedBodies.has('e1')).toBe(true);
    expect(h.synced).toBe(1);
  });

  it('treats a THROWN defer the same as a returned one', async () => {
    // The IPC layer surfaces some engine errors as a rejection; that path knew
    // only about "queue full", so a deferred fetch still parked the email.
    const h = harness(async () => {
      throw new Error('Body fetch deferred (3 consecutive timeouts) — will retry');
    });
    await h.slice.fetchEmailBody('e1');
    expect(h.state.failedBodies.has('e1')).toBe(false);
    expect(h.state.loadingBodies.has('e1')).toBe(false);
  });

  it('parks a thrown NON-deferred error', async () => {
    const h = harness(async () => { throw new Error('IMAP authentication failed'); });
    await h.slice.fetchEmailBody('e1');
    expect(h.state.failedBodies.has('e1')).toBe(true);
  });
});

describe('loadAllSections — the click-resolution pool', () => {
  /**
   * `emails` is the flat pool `selectEmail` resolves a clicked row against. It
   * is DERIVED from `sectionData` but lives in its own slot, and `selectFolder`
   * clears it to [] while deliberately KEEPING sectionData cached. The no-op
   * guard compared only sectionData, so re-selecting INBOX (which is not
   * skipped while a message is open) emptied the pool and then skipped the
   * set() that refills it: every row stayed on screen, every click resolved to
   * nothing, and the reading pane sat on "Select an email to read" until the
   * sections happened to change.
   */
  const section = { id: 'sec-1', filter: 'everything_else', maxItems: 25 } as any;
  const serverRows = [row('e1'), row('e2')];

  interface SectionHarness {
    state: Record<string, any>;
    slice: any;
    listCalls: number;
  }

  const harness = (
    over: Record<string, any> = {},
    listBySection: () => Promise<any> = async () => ({ success: true, data: serverRows }),
  ): SectionHarness => {
    const h: SectionHarness = {
      state: {
        inboxType: 'priority_first',
        inboxSections: [section],
        pendingDeletes: [],
        activeInboxFilter: null,
        selectedFolderId: 'f-inbox',
        selectedVirtualFolder: null,
        viewingSnoozed: false,
        viewingAICategory: null,
        viewingSection: null,
        sectionData: {},
        emails: [],
        loadingEmails: false,
        ...over,
      },
      slice: null,
      listCalls: 0,
    };
    (globalThis as any).window = {
      electronAPI: {
        emails: {
          listBySection: async () => { h.listCalls += 1; return listBySection(); },
          sectionCounts: async () => ({ success: true, data: { everything_else: serverRows.length } }),
        },
      },
    };
    const set = (patch: Record<string, any>) => { Object.assign(h.state, patch); };
    // The slice object carries the slice's INITIAL state alongside its methods,
    // so the harness state must be spread LAST — otherwise `sectionData` reads
    // back as {} and every reload looks like a first load.
    const get = () => ({ ...h.slice, ...h.state });
    h.slice = createEmailsSlice(set as any, get as any, undefined as any);
    return h;
  };

  afterEach(() => { delete (globalThis as any).window; });

  // Breaks: THE bug — the rendered rows survive the folder re-selection but the
  // pool behind them does not, so no email can be opened any more.
  it('refills the pool when the rows are unchanged but selectFolder emptied it', async () => {
    const h = harness();
    await h.slice.loadAllSections('INBOX');
    expect(h.state.emails.map((e: any) => e.id)).toEqual(['e1', 'e2']);

    // What selectFolder does: pool cleared, sectionData deliberately kept.
    h.state.emails = [];
    await h.slice.loadAllSections('INBOX');

    expect(h.listCalls).toBe(2);
    expect(h.state.emails.map((e: any) => e.id)).toEqual(['e1', 'e2']);
  });

  // Breaks: the no-op guard itself — a background reload every few seconds
  // rebuilding every thread object and re-rendering every row (the "lags every
  // few seconds" beachball this guard exists to prevent).
  it('still skips the re-render when nothing changed and the pool is intact', async () => {
    const h = harness();
    await h.slice.loadAllSections('INBOX');
    const rendered = h.state.sectionData;

    // A spinner left on by an interrupted first load must still be cleared —
    // otherwise the skip hides a list that is already on screen behind it.
    h.state.loadingEmails = true;
    await h.slice.loadAllSections('INBOX');

    expect(h.listCalls).toBe(2);
    expect(h.state.sectionData).toBe(rendered); // same identities — no re-render
    expect(h.state.loadingEmails).toBe(false);
  });

  // Breaks: the section drill-in. There `emails` holds that section's flat page,
  // not the pool, so comparing it against the pool would report a mismatch on
  // every tick and re-render the list underneath the user.
  it('leaves a section drill-in page alone instead of treating it as a stale pool', async () => {
    const h = harness();
    await h.slice.loadAllSections('INBOX');
    const rendered = h.state.sectionData;

    // Drilled in: a flat page of its own, deliberately a different length.
    h.state.viewingSection = 'everything_else';
    h.state.emails = [row('e1')];
    await h.slice.loadAllSections('INBOX');

    expect(h.state.sectionData).toBe(rendered);
    expect(h.state.emails.map((e: any) => e.id)).toEqual(['e1']);
  });

  // Breaks: the drill-in page being swapped for the whole sectioned inbox
  // mid-read. A background reload that DOES find a change still has to write the
  // new rows — it just must not write the pool over a page it does not own.
  it('does not overwrite a drill-in page when the sections do change', async () => {
    const h = harness();
    await h.slice.loadAllSections('INBOX');

    h.state.viewingSection = 'everything_else';
    h.state.emails = [row('e1')];
    serverRows.push(row('e3'));
    try {
      await h.slice.loadAllSections('INBOX');
      // The rows behind the drill-in are refreshed (closing it restores from them)...
      expect(h.state.sectionData['sec-1'].emails.map((e: any) => e.id)).toEqual(['e1', 'e2', 'e3']);
      // ...but the page the user is reading is untouched.
      expect(h.state.emails.map((e: any) => e.id)).toEqual(['e1']);
    } finally {
      serverRows.pop();
    }
  });

  // Breaks: the same clobber reached through the OTHER section loaders. The
  // ownership rule has to hold everywhere section rows are written, or one of
  // them puts the pool back over the page the user is reading.
  it.each([
    ['loadSectionEmails', (slice: any) => slice.loadSectionEmails('sec-1', 'everything_else', 'INBOX')],
    ['loadMoreSectionEmails', (slice: any) => slice.loadMoreSectionEmails('sec-1', 'everything_else', 'INBOX')],
    ['goToSectionPage', (slice: any) => slice.goToSectionPage('sec-1', 'everything_else', 0, 'INBOX')],
  ])('%s leaves a drill-in page alone', async (_name, run) => {
    const h = harness({
      viewingSection: 'everything_else',
      emails: [row('e1')],
      sectionLoading: new Set<string>(),
      sectionData: {
        'sec-1': { emails: [row('e1')], threads: [], offset: 25, total: 99, hasMore: true, loading: false },
      },
    });

    await run(h.slice);

    expect(h.state.emails.map((e: any) => e.id)).toEqual(['e1']);
    expect(h.state.sectionData['sec-1'].emails.map((e: any) => e.id)).toEqual(['e1', 'e2']);
  });

  // Breaks: the two load-more paths that write rows WITHOUT new data — "the
  // server had nothing more" and a failed query. Both only flip a flag, and both
  // would have put the pool back over the drill-in page while doing it.
  it.each([
    ['finds nothing more', async () => ({ success: true, data: [] })],
    ['fails outright', async () => { throw new Error('listBySection failed'); }],
  ])('leaves a drill-in page alone when load-more %s', async (_name, list) => {
    const h = harness({
      viewingSection: 'everything_else',
      emails: [row('e1')],
      sectionData: {
        'sec-1': { emails: [row('e1')], threads: [], offset: 25, total: 99, hasMore: true, loading: false },
      },
    }, list as () => Promise<any>);

    await h.slice.loadMoreSectionEmails('sec-1', 'everything_else', 'INBOX');

    expect(h.state.emails.map((e: any) => e.id)).toEqual(['e1']);
    // The section's own spinner is always released, whichever way it ended.
    expect(h.state.sectionData['sec-1'].loading).toBe(false);
  });

  // Breaks: a genuine change being skipped — the pool must follow the rows it is
  // derived from, not just get repaired when it is empty.
  it('replaces both the rows and the pool when the sections actually change', async () => {
    const h = harness();
    await h.slice.loadAllSections('INBOX');

    serverRows.push(row('e3'));
    try {
      await h.slice.loadAllSections('INBOX');
      expect(h.state.emails.map((e: any) => e.id)).toEqual(['e1', 'e2', 'e3']);
    } finally {
      serverRows.pop();
    }
  });
});

describe('sectionRowsPatch', () => {
  /**
   * The single rule for who owns `emails` — the flat pool a click is resolved
   * against. Every section loader writes through this, so they cannot disagree:
   * one of them writing the pool over a drill-in page is exactly the bug.
   */
  const sectionData = { s1: { emails: [row('a'), row('b')] }, s2: { emails: [row('b'), row('c')] } };

  // Breaks: the pool stops following the rows it is derived from, and clicks on
  // freshly-loaded rows resolve to nothing.
  it('derives the pool from every section, deduplicated', () => {
    const patch = sectionRowsPatch(null, sectionData);
    expect(patch.sectionData).toBe(sectionData);
    expect(patch.emails?.map((e: any) => e.id)).toEqual(['a', 'b', 'c']);
  });

  // Breaks: THE drill-in clobber — the section's own paginated page is replaced
  // by the whole sectioned inbox on the next background reload.
  it('omits the pool entirely while drilled into a section', () => {
    const patch = sectionRowsPatch('everything_else', sectionData);
    expect(patch.sectionData).toBe(sectionData);
    expect('emails' in patch).toBe(false);
  });

  // Breaks: an undefined `viewingSection` (the field's resting value) read as
  // "drilled in", which would stop the pool ever being written.
  it('treats undefined as not drilled in', () => {
    expect(sectionRowsPatch(undefined, sectionData).emails).toHaveLength(3);
  });
});

describe('goToEmailPage — paging past what the folder can actually show', () => {
  /**
   * A flat folder's "of N" is max(local, server) on purpose: the server count is
   * the truth the user sees in webmail, and paging past the local tail is what
   * nudges the background backfill. But when that page comes back EMPTY and the
   * backfill has nothing to add, the old code still navigated — leaving a blank
   * list with "next" lit, the third symptom of the Sent-folder report.
   */
  const folder = { id: 'f-sent', path: 'Sent', totalCount: 1, serverMessageCount: 1718 };
  // Sent is one of the account's own standard mailboxes — it pages at 50.
  const pageSize = getPageSizeForView({ folder });
  const firstPage = [row('e1')];

  interface PageHarness { state: Record<string, any>; slice: any; backfills: number; listed: number[] }

  const harness = (
    listRows: (offset: number) => any[],
    inserted = 0,
  ): PageHarness => {
    const h: PageHarness = {
      state: {
        selectedFolderId: 'f-sent',
        folders: [folder],
        accounts: [],
        viewingAICategory: null,
        viewingSection: null,
        viewingSectionPageSize: 0,
        selectedVirtualFolder: null,
        loadingMoreEmails: false,
        emails: firstPage,
        emailsPage: 0,
        emailsOffset: firstPage.length,
        emailsTotal: 1718,
        hasMoreEmails: true,
      },
      slice: null,
      backfills: 0,
      listed: [],
    };
    (globalThis as any).window = {
      electronAPI: {
        emails: {
          list: async (_id: string, _limit: number, offset: number) => {
            h.listed.push(offset);
            return { success: true, data: listRows(offset) };
          },
        },
        imap: {
          backfillChunk: async () => { h.backfills += 1; return { success: true, data: { inserted } }; },
        },
        // A backfill that inserted something re-reads the folder record before
        // re-listing the page, so the counts it just changed are the ones used.
        folders: { list: async () => ({ success: true, data: [folder] }) },
      },
    };
    const set = (patch: Record<string, any>) => { Object.assign(h.state, patch); };
    const get = () => ({ ...h.slice, ...h.state });
    h.slice = createEmailsSlice(set as any, get as any, undefined as any);
    return h;
  };

  afterEach(() => { delete (globalThis as any).window; });

  // Breaks: THE bug — an empty page 2 replaces the rows on screen with nothing
  // while the count still promises 1,718 more, so "next" keeps being clickable.
  it('stays on the page it was reading when the next one comes back empty', async () => {
    const h = harness((offset) => (offset === 0 ? firstPage : []));

    await h.slice.goToEmailPage(1);

    expect(h.backfills).toBe(1);                 // the backfill was still asked
    expect(h.state.emails).toBe(firstPage);      // …and the user kept their list
    expect(h.state.emailsPage).toBe(0);
    expect(h.state.hasMoreEmails).toBe(false);   // "next" stops lying
    expect(h.state.emailsTotal).toBe(pageSize);  // the count drops to what exists
    expect(h.state.loadingMoreEmails).toBe(false);
  });

  // Breaks: the clamp swallows a page the backfill DID produce, so a folder that
  // is merely behind on syncing can never be paged through.
  it('shows the page when the backfill fills it in', async () => {
    const late = [row('e2')];
    let filled = false;
    const h = harness(
      (offset) => (offset === 0 ? firstPage : filled ? late : []),
      1,
    );
    (globalThis as any).window.electronAPI.imap.backfillChunk = async () => {
      filled = true;
      return { success: true, data: { inserted: 1 } };
    };

    await h.slice.goToEmailPage(1);

    expect(h.state.emails).toBe(late);
    expect(h.state.emailsPage).toBe(1);
    expect(h.state.emailsTotal).toBe(1718);
  });

  // Breaks: an empty FIRST page (a folder that genuinely holds nothing, or one
  // whose rows were just deleted) would be treated as a paging accident and
  // leave the previous folder's rows on screen.
  it('still clears the list when page 0 itself is empty', async () => {
    const h = harness(() => []);

    await h.slice.goToEmailPage(0);

    expect(h.state.emails).toEqual([]);
    expect(h.state.emailsPage).toBe(0);
  });
});

describe('refreshVirtualFolder — a refresh must not leave the page window', () => {
  /**
   * The "1–111 of nothing" report. Two bugs in one line: the background refresh
   * always re-read page 0 and merged it into whatever page the user was on
   * (growing the list past its window), and every static virtual view set
   * emailsTotal to 0 so the header showed no "of N" at all.
   */
  const pageSize = 100; // All Email / All Inboxes are the fixed-100 firehose views
  const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => row(`${prefix}${i}`));

  interface RefreshHarness { state: Record<string, any>; slice: any; offsets: number[] }

  const harness = (opts: {
    fresh: (offset: number) => any[];
    page?: number;
    emails?: any[];
    counts?: Record<string, number> | null;
    unified?: { emails: any[]; total?: number; hasMore: boolean };
    snoozed?: any[];
  }): RefreshHarness => {
    const h: RefreshHarness = {
      state: {
        emails: opts.emails ?? [],
        emailsPage: opts.page ?? 0,
        emailsOffset: 0,
        emailsTotal: 0,
        hasMoreEmails: false,
        accounts: [{ id: 'acct-a', includeInUnified: true }],
        failedBodies: new Set<string>(),
        folders: [],
        selectedFolderId: null,
        selectedVirtualFolder: 'virtual-all',
        viewingAICategory: null,
        viewingSection: null,
        viewingSectionPageSize: 0,
      },
      slice: null,
      offsets: [],
    };
    const listing = async (_limit: number, offset: number) => {
      h.offsets.push(offset);
      return { success: true, data: opts.fresh(offset) };
    };
    (globalThis as any).window = {
      electronAPI: {
        emails: {
          getAll: listing,
          getStarred: listing,
          getImportant: listing,
          getVirtualFolderCounts: async () =>
            (opts.counts === null ? { success: false } : { success: true, data: opts.counts ?? { all: 1718, starred: 42 } }),
        },
        accounts: {
          unifiedInbox: async ({ offset }: { offset: number }) => {
            h.offsets.push(offset);
            return { success: true, data: opts.unified ?? { emails: [], total: 0, hasMore: false } };
          },
        },
        snooze: {
          list: async () => ({ success: true, data: opts.snoozed ?? [] }),
          listEmails: async ({ offset }: { limit: number; offset: number }) => listing(0, offset),
        },
      },
    };
    const set = (patch: Record<string, any>) => { Object.assign(h.state, patch); };
    const get = () => ({ ...h.slice, ...h.state });
    h.slice = createEmailsSlice(set as any, get as any, undefined as any);
    return h;
  };

  afterEach(() => { delete (globalThis as any).window; });

  // Breaks: a page-4 reader gets page 1's mail spliced in by a background
  // refresh — the newest 100 messages silently replace what they were reading.
  it('re-reads the page the user is on, not page 0', async () => {
    const onScreen = rows('p3-', pageSize);
    const h = harness({ page: 3, emails: onScreen, fresh: () => onScreen });

    await h.slice.refreshVirtualFolder('all');

    expect(h.offsets).toEqual([3 * pageSize]);
  });

  // Breaks: THE symptom — "1–111" on a 100-row page. Fresh arrivals merge in,
  // but the visible list must still be exactly one page.
  it('never leaves more rows on screen than the page holds', async () => {
    const onScreen = rows('old-', pageSize);
    const h = harness({ fresh: () => [...rows('new-', 11), ...onScreen] });
    h.state.emails = onScreen;

    await h.slice.refreshVirtualFolder('all');

    expect(h.state.emails).toHaveLength(pageSize);
  });

  // Breaks: the header reads a bare "1–100" with no idea how much mail is
  // behind it. The house pattern is "1–100 of 1,718".
  it('gives the view its "of N" from the shared count', async () => {
    const h = harness({ fresh: () => rows('a', pageSize) });

    await h.slice.refreshVirtualFolder('all');

    expect(h.state.emailsTotal).toBe(1718);
    expect(h.state.hasMoreEmails).toBe(true); // 100 of 1,718 — there is more
  });

  // Breaks: a page beyond the count still lights "next", so the user clicks into
  // a blank list.
  it('stops promising more once the page reaches the total', async () => {
    // Starred is a flag list, not a firehose — it pages at the user's default.
    const starredSize = getPageSizeForView({ virtualFolder: 'virtual-starred' });
    const total = starredSize + 10;
    const h = harness({ page: 1, fresh: () => rows('a', 10), counts: { starred: total } });
    h.state.selectedVirtualFolder = 'virtual-starred';

    await h.slice.refreshVirtualFolder('starred');

    expect(h.offsets).toEqual([starredSize]);
    expect(h.state.emailsTotal).toBe(total);
    expect(h.state.hasMoreEmails).toBe(false); // the last 10 of N — nothing after them
  });

  // Breaks: a flaky count IPC would otherwise overwrite a good total with 0 and
  // strip the "of N" off a view that had one. Unknown must leave it alone.
  it('keeps the total it had when the count is unavailable', async () => {
    const h = harness({ fresh: () => rows('a', pageSize), counts: null });
    h.state.emailsTotal = 900;

    await h.slice.refreshVirtualFolder('all');

    expect(h.state.emailsTotal).toBe(900);
    expect(h.state.hasMoreEmails).toBe(true); // a full page back → assume more
  });

  // Breaks: All Inboxes paged with no total (its merged array is a page window,
  // not the mailbox) and its refresh also snapped back to offset 0.
  it('unified: pages at the current offset and takes the total from the merge', async () => {
    const h = harness({
      page: 2,
      fresh: () => [],
      unified: { emails: rows('u', pageSize), total: 5000, hasMore: true },
    });

    await h.slice.refreshVirtualFolder('unified');

    expect(h.offsets).toEqual([2 * pageSize]);
    expect(h.state.emailsTotal).toBe(5000);
    expect(h.state.emailsOffset).toBe(2 * pageSize + pageSize);
  });

  // Breaks: Snoozed refreshed itself with snooze RECORDS, which are not rows the
  // list can render, and called however many it got the total. It now takes the
  // same page-of-conversations path as every other virtual folder, with the
  // total from the counter the sidebar badge reads.
  it('snoozed: refreshes a page of emails and takes the counter as its total', async () => {
    const h = harness({ page: 1, fresh: () => rows('s', 3), counts: { snoozed: 9 } });

    await h.slice.refreshVirtualFolder('snoozed');

    const snoozedSize = getPageSizeForView({ virtualFolder: 'virtual-snoozed' });
    expect(h.offsets).toEqual([snoozedSize]); // the page the reader is on
    expect(h.state.emailsTotal).toBe(9);
    expect(h.state.emails.map((e: any) => e.id)).toEqual(['s0', 's1', 's2']);
  });
});

describe('Starred/Important/All Email page in CONVERSATIONS, not messages', () => {
  /**
   * The reported bug: Starred showed "1-50 of 52" over 15 rows, then 2 more on
   * page 2. The repository now selects pageSize THREADS and hands back all of
   * their messages, and the count is in threads too — so every number the store
   * derives from a page must be counted in threads as well. Anything that goes
   * back to `emails.length` here re-opens the exact symptom. "All Email" is the
   * same query shape at a different page size, so it is covered here too.
   */
  const starredSize = getPageSizeForView({ virtualFolder: 'virtual-starred' });

  /** `threads` conversations, `per` messages each — one page as the repo returns it. */
  const conversation = (threads: number, per: number) =>
    Array.from({ length: threads * per }, (_, i) =>
      row(`m${i}`, { threadId: `t${Math.floor(i / per)}`, date: 10_000 - i, cleanBody: 'body' }));

  interface Harness { state: Record<string, any>; slice: any; offsets: number[] }

  const harness = (fresh: (offset: number) => any[], starredTotal: number, over: Record<string, any> = {}): Harness => {
    const h: Harness = {
      state: {
        emails: [], emailsPage: 0, emailsOffset: 0, emailsTotal: 0, hasMoreEmails: false,
        accounts: [], folders: [], failedBodies: new Set<string>(),
        selectedFolderId: null, selectedVirtualFolder: 'virtual-starred',
        viewingAICategory: null, viewingSection: null, viewingSectionPageSize: 0,
        inboxType: 'default', inboxSections: [],
        ...over,
      },
      slice: null,
      offsets: [],
    };
    const listing = async (_limit: number, offset: number) => {
      h.offsets.push(offset);
      return { success: true, data: fresh(offset) };
    };
    (globalThis as any).window = {
      electronAPI: {
        emails: {
          getStarred: listing,
          getImportant: listing,
          getAll: listing,
          getVirtualFolderCounts: async () => ({ success: true, data: { starred: starredTotal, important: starredTotal, all: starredTotal, snoozed: starredTotal } }),
        },
        snooze: {
          listEmails: async ({ offset }: { limit: number; offset: number }) => listing(0, offset),
        },
      },
    };
    const set = (patch: Record<string, any>) => { Object.assign(h.state, patch); };
    const get = () => ({ ...h.slice, ...h.state });
    h.slice = createEmailsSlice(set as any, get as any, undefined as any);
    return h;
  };

  afterEach(() => { delete (globalThis as any).window; });

  // Breaks: THE reported symptom. 50 messages that collapse to 15 rows, against
  // a 17-conversation total — measuring the page in messages says "50 >= 17,
  // nothing more" and kills the next button with 2 conversations unread.
  it('measures the first page in conversations, so "next" survives a collapsed page', async () => {
    const h = harness(() => conversation(15, 4), 17);

    await h.slice.loadStarredEmails();

    expect(h.state.emailsTotal).toBe(17);   // conversations
    expect(h.state.emailsOffset).toBe(15);  // conversations shown, not 60 messages
    expect(h.state.hasMoreEmails).toBe(true);
  });

  // Breaks: the same math one page on. The fetch offset is a THREAD offset, so
  // page 1 asks for thread 50 onward; when the tail arrives, "more" must go off.
  it('pages by thread offset and stops at the end of the last conversation', async () => {
    const h = harness(() => conversation(2, 3), starredSize + 2, { emailsTotal: starredSize + 2 });

    await h.slice.goToEmailPage(1);

    expect(h.offsets).toEqual([starredSize]); // threads, not messages
    expect(h.state.emailsPage).toBe(1);
    expect(h.state.emailsOffset).toBe(starredSize + 2);
    expect(h.state.hasMoreEmails).toBe(false);
  });

  // Breaks: Important is the same shape and used to disagree with its own count
  // in the same way — its ranking is by priority, its paging still by thread.
  it('applies the same conversation math to Important', async () => {
    const h = harness(() => conversation(4, 5), 9, { selectedVirtualFolder: 'virtual-important' });

    await h.slice.loadImportantEmails();

    expect(h.state.emailsOffset).toBe(4);
    expect(h.state.hasMoreEmails).toBe(true);
  });

  // Breaks: "All Email" is the biggest list in the app and the one where a
  // collapsed page is most visible — 100 messages of a busy mailbox can be a
  // couple of dozen rows. Counted in messages, the first page alone claims to
  // have shown more than the total.
  it('applies the same conversation math to All Email, at its own page size', async () => {
    const allSize = getPageSizeForView({ virtualFolder: 'virtual-all' });
    const h = harness(() => conversation(30, 4), 140, { selectedVirtualFolder: 'virtual-all' });

    await h.slice.loadAllEmails();

    expect(allSize).toBe(100);              // still the firehose tier, not 50
    expect(h.state.emailsTotal).toBe(140);  // conversations
    expect(h.state.emailsOffset).toBe(30);  // conversations shown, not 120 messages
    expect(h.state.hasMoreEmails).toBe(true);
  });

  // Breaks: All Email's own next-page math. goToEmailPage branches on
  // isThreadPagedView, so virtual-all joining that set is what makes the offset
  // a thread offset here.
  it('pages All Email by thread offset', async () => {
    const allSize = getPageSizeForView({ virtualFolder: 'virtual-all' });
    const h = harness(() => conversation(3, 2), allSize + 3, {
      selectedVirtualFolder: 'virtual-all', emailsTotal: allSize + 3,
    });

    await h.slice.goToEmailPage(1);

    expect(h.offsets).toEqual([allSize]); // threads, not messages
    expect(h.state.emailsOffset).toBe(allSize + 3);
    expect(h.state.hasMoreEmails).toBe(false);
  });

  // Breaks: Snoozed counted the messages it happened to load as its own total,
  // on a view that then claimed to be showing everything. It is a conversation
  // list like Starred, with an exact total from the same predicate.
  it('applies the same conversation math to Snoozed', async () => {
    const h = harness(() => conversation(6, 3), 20, {
      selectedVirtualFolder: null, viewingSnoozed: true,
    });

    await h.slice.loadSnoozedEmails();

    expect(h.offsets).toEqual([0]);
    expect(h.state.emailsTotal).toBe(20);  // conversations, from getSnoozedCount
    expect(h.state.emailsOffset).toBe(6);  // conversations shown, not 18 messages
    expect(h.state.hasMoreEmails).toBe(true);
  });

  // Breaks: Snoozed had no branch in goToEmailPage at all — prev/next fell
  // through to the flat-folder path, which bails on a null selectedFolderId, so
  // page 2 of a long snooze list was unreachable.
  it('pages Snoozed by thread offset', async () => {
    const snoozedSize = getPageSizeForView({ virtualFolder: 'virtual-snoozed' });
    const h = harness(() => conversation(4, 2), snoozedSize + 4, {
      selectedVirtualFolder: null, viewingSnoozed: true, emailsTotal: snoozedSize + 4,
    });

    await h.slice.goToEmailPage(1);

    expect(h.offsets).toEqual([snoozedSize]); // threads, not messages
    expect(h.state.emailsPage).toBe(1);
    expect(h.state.emailsOffset).toBe(snoozedSize + 4);
    expect(h.state.hasMoreEmails).toBe(false);
  });

  // Breaks: a background refresh capping at pageSize MESSAGES would cut a
  // conversation in half — the row renders missing its older mail.
  it('a background refresh caps the window by conversation, never mid-thread', async () => {
    const onScreen = conversation(2, 3);
    const h = harness(() => conversation(starredSize + 2, 3), 60, { emails: onScreen });

    await h.slice.refreshVirtualFolder('starred');

    // Exactly pageSize conversations, and each still carries all 3 messages.
    const byThread = new Map<string, number>();
    for (const e of h.state.emails) byThread.set(e.threadId, (byThread.get(e.threadId) ?? 0) + 1);
    expect(byThread.size).toBe(starredSize);
    expect([...byThread.values()].every((n) => n === 3)).toBe(true);
  });
});
