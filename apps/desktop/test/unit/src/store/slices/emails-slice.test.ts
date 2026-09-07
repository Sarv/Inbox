import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// CategoryBadges is imported by the slice for its cache-clear helper; the two
// pure functions under test never touch it, so a stub keeps the module graph
// free of IPC.
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
}));

import { buildEmailReplacementPatch, createEmailsSlice, selectLoadedEmailIds } from '../../../../../src/store/slices/emails-slice';

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
