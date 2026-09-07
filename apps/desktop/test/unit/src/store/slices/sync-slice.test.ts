import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CategoryBadges owns a renderer-only cache the slice clears; stub it so the
// module graph under test stays free of IPC/DOM side effects.
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
}));

// handleFoldersUpdated is the renderer half of the live-counter feature: a
// main-process "folder counts changed" signal (from the backfill/gap-drain
// schedulers), coalesced into the SAME flush window as IDLE events — but only
// for the ACTIVE account, since background accounts surface unread through a
// separate aggregate. We assert the gate and that it arms a single debounced
// flush, WITHOUT running the (heavy, IPC-driven) flush itself: fake timers let us
// observe the armed timer directly. Each test re-imports the module so the
// module-scoped coalescer batch starts fresh.

const loadSlice = async (getState: () => any) => {
  vi.resetModules();
  (globalThis as any).window = { electronAPI: {} }; // read lazily; the flush never runs here
  const mod = await import('../../../../../src/store/slices/sync-slice');
  // SliceCreator has Zustand's (set, get, store) shape; handleFoldersUpdated only
  // uses set + get, so a stub store api is fine.
  return mod.createSyncSlice(vi.fn(), getState, {} as any);
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers(); // drop the armed flush so it never fires against the mock get()
  vi.useRealTimers();
  delete (globalThis as any).window;
});

describe('handleFoldersUpdated (live sidebar counts)', () => {
  it('arms a coalesced flush for the active account', async () => {
    const slice = await loadSlice(() => ({ activeAccountId: 'A' }));
    slice.handleFoldersUpdated('A');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('treats an undefined accountId as the active account', async () => {
    const slice = await loadSlice(() => ({ activeAccountId: 'A' }));
    slice.handleFoldersUpdated(undefined);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('ignores a background account — no flush armed (its unread is a separate aggregate)', async () => {
    const slice = await loadSlice(() => ({ activeAccountId: 'A' }));
    slice.handleFoldersUpdated('B');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces a burst of signals into a single timer', async () => {
    const slice = await loadSlice(() => ({ activeAccountId: 'A' }));
    slice.handleFoldersUpdated('A');
    slice.handleFoldersUpdated(undefined);
    slice.handleFoldersUpdated('A');
    expect(vi.getTimerCount()).toBe(1); // scheduleFlush clears+resets the one debounce timer
  });
});

// ---------------------------------------------------------------------------
// EXTERNAL (webmail / another device) flag changes must be instantly reactive.
//
// The field report this guards: "I put the unread filter on and see 30 mails,
// then mark 21 of them read in webmail — the rows stay and the counter still
// says 30." Two separate causes, both regression-tested below:
//
//  1. The count surfaces (account badges, unified list, curated Starred /
//     Important tabs, AI-category chips) were gated on `sawNew`/`sawBackground`
//     only, so an active-account flag change moved NONE of them.
//  2. The visible list is a SERVER QUERY carrying the quick-filter, not a
//     client-side filter — so only RE-RUNNING it moves the filtered totals and
//     pulls up the still-matching rows sitting past the loaded page. Flag
//     changes never triggered that re-query (the flush logged `folders=[]`).
//
// These drive the real flush (fake timers + a mocked electronAPI) rather than
// just observing the armed timer, because the gates under test live in it.
// ---------------------------------------------------------------------------

interface FlushHarness {
  slice: any;
  state: any;
  sets: any[];
  emailGet: any;
}

/** Boot the slice with a full-enough store stub and a mocked emails.get IPC. */
const loadFlushHarness = async (overrides: Record<string, any> = {}): Promise<FlushHarness> => {
  vi.resetModules();
  const sets: any[] = [];
  const emailGet = vi.fn(async (id: string) => ({
    success: true,
    data: { id, threadId: `t-${id}`, tags: ['inbox'], isRead: true },
  }));
  (globalThis as any).window = { electronAPI: { emails: { get: emailGet } } };

  const state: any = {
    activeAccountId: 'A',
    // Flat INBOX view holding one row, so a flag change on 'e1' is "visible".
    folders: [{ id: 'f-inbox', path: 'INBOX' }],
    selectedFolderId: 'f-inbox',
    selectedVirtualFolder: null,
    viewingAICategory: null,
    activeInboxFilter: null,
    inboxType: 'default',
    inboxSections: [],
    emails: [{ id: 'e1', threadId: 't-e1' }],
    sectionData: {},
    searchResults: [],
    // Every call the flush can make, all counted.
    refreshUnreadSummary: vi.fn(),
    refreshVirtualFolder: vi.fn(),
    loadFolders: vi.fn(async () => {}),
    loadAllSections: vi.fn(async () => {}),
    loadAICategoryEmails: vi.fn(async () => {}),
    mergeNewEmails: vi.fn(async () => {}),
    mergeNewEmailsVirtualAll: vi.fn(async () => {}),
    mergeNewEmailsVirtualStarred: vi.fn(async () => {}),
    fetchEmailBody: vi.fn(),
    fetchBodiesForVisibleEmails: vi.fn(),
    noteNewEmailForOpenThread: vi.fn(),
    processRecentEmailsForSignatures: vi.fn(async () => {}),
    autoExtractRecentConversations: vi.fn(async () => {}),
    ...overrides,
  };

  const mod = await import('../../../../../src/store/slices/sync-slice');
  const set = (patch: any) => {
    sets.push(patch);
    Object.assign(state, patch);
  };
  const slice = mod.createSyncSlice(set as any, (() => state) as any, {} as any);
  return { slice, state, sets, emailGet };
};

/** Let the debounce fire and the flush's awaited IPC settle. */
const runFlush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1_200);
};

describe('flushRealtimeBatch — external flag changes (webmail read / star)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Regression: the counters didn't budge. An active-account flag change must
  // move the account/unified unread badges, exactly like an arrival does.
  it('refreshes the unread summary on an active-account flag change', async () => {
    const h = await loadFlushHarness();
    h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'A', emailId: 'e1', folderPath: 'INBOX' });
    await runFlush();
    expect(h.state.refreshUnreadSummary).toHaveBeenCalledTimes(1);
    expect(h.state.loadFolders).toHaveBeenCalledTimes(1); // sidebar badges
  });

  // Regression: the rows AND the filtered totals. Re-running the folder's list
  // query is the only thing that drops now-read rows under the Unread filter
  // and pulls up still-unread rows from past the loaded page.
  it('re-runs the visible folder query when a row we hold changed', async () => {
    const h = await loadFlushHarness();
    h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'A', emailId: 'e1', folderPath: 'INBOX' });
    await runFlush();
    expect(h.state.mergeNewEmails).toHaveBeenCalledWith('f-inbox');
  });

  // Regression: a change to a row beyond the loaded page still moves a FILTERED
  // view's totals ("30 of 30" over 9 rows), so the query must re-run even though
  // nothing on screen changed.
  it('re-runs the query for an off-page change while a quick-filter is active', async () => {
    const h = await loadFlushHarness({ activeInboxFilter: { isRead: false } });
    h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'A', emailId: 'off-page', folderPath: 'INBOX' });
    await runFlush();
    expect(h.state.mergeNewEmails).toHaveBeenCalledWith('f-inbox');
  });

  // The other side of that gate: with NO filter, a change to a row we don't
  // hold cannot alter the view, so we must not pay for a re-query — while the
  // badges (which do count it) still refresh.
  it('skips the re-query for an off-page change with no filter, but still refreshes badges', async () => {
    const h = await loadFlushHarness();
    h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'A', emailId: 'off-page', folderPath: 'INBOX' });
    await runFlush();
    expect(h.state.mergeNewEmails).not.toHaveBeenCalled();
    expect(h.state.refreshUnreadSummary).toHaveBeenCalledTimes(1);
  });

  // Regression: an unstar in webmail must leave the Starred tab immediately.
  it('refreshes the curated Starred tab', async () => {
    const h = await loadFlushHarness({ selectedVirtualFolder: 'virtual-starred' });
    h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'A', emailId: 'e1', folderPath: 'INBOX' });
    await runFlush();
    expect(h.state.refreshVirtualFolder).toHaveBeenCalledWith('starred');
  });

  // Regression: the unified (all-accounts) list is itself a filtered query.
  it('refreshes the unified list', async () => {
    const h = await loadFlushHarness({ selectedVirtualFolder: 'virtual-unified' });
    h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'A', emailId: 'e1', folderPath: 'INBOX' });
    await runFlush();
    expect(h.state.refreshVirtualFolder).toHaveBeenCalledWith('unified');
  });

  // Regression: the AI-category chips carry their own counts and went stale.
  it('invalidates the AI-category counts', async () => {
    const h = await loadFlushHarness({ viewingAICategory: 'needs-response' });
    h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'A', emailId: 'e1', folderPath: 'INBOX' });
    await runFlush();
    expect(h.sets.some((p) => typeof p.aiCategoryCountsLastUpdate === 'number')).toBe(true);
  });

  // Regression: the sectioned inbox renders from `sectionData`, so a plain
  // mergeNewEmails is a no-op there — the section totals are what the user sees.
  it('reloads sections (not the flat list) for a sectioned inbox', async () => {
    const h = await loadFlushHarness({ inboxType: 'focused', inboxSections: [{ id: 's1' }] });
    h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'A', emailId: 'e1', folderPath: 'INBOX' });
    await runFlush();
    expect(h.state.loadAllSections).toHaveBeenCalledWith('INBOX');
    expect(h.state.mergeNewEmails).not.toHaveBeenCalled();
  });

  // Multi-account: a flag change on a BACKGROUND account must move the shared
  // badges but never touch the active account's list.
  it('moves badges only for a background-account flag change', async () => {
    const h = await loadFlushHarness();
    h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'B', emailId: 'x1', folderPath: 'INBOX' });
    await runFlush();
    expect(h.state.refreshUnreadSummary).toHaveBeenCalledTimes(1);
    expect(h.state.mergeNewEmails).not.toHaveBeenCalled();
  });

  // Transient failure path: the per-row IPC read fails (connection blip). The
  // flush must still refresh the filtered view and the badges, not abort — the
  // row read is an optimisation, the query re-run is the correctness fix.
  it('still refreshes the view and badges when the row re-read fails', async () => {
    const h = await loadFlushHarness({ activeInboxFilter: { isRead: false } });
    h.emailGet.mockRejectedValue(new Error('IPC blip'));
    h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'A', emailId: 'e1', folderPath: 'INBOX' });
    await runFlush();
    expect(h.state.mergeNewEmails).toHaveBeenCalledWith('f-inbox');
    expect(h.state.refreshUnreadSummary).toHaveBeenCalledTimes(1);
  });

  // Coalescing invariant: 21 mails read in webmail is 21 events but must cost
  // ONE badge refresh and ONE query re-run per folder, not 21 of each.
  it('coalesces a burst of flag events into one refresh per surface', async () => {
    const h = await loadFlushHarness();
    for (let i = 0; i < 21; i++) {
      h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'A', emailId: 'e1', folderPath: 'INBOX' });
    }
    await runFlush();
    expect(h.state.refreshUnreadSummary).toHaveBeenCalledTimes(1);
    expect(h.state.mergeNewEmails).toHaveBeenCalledTimes(1);
  });

  // Idempotent re-run: a second window with nothing queued must be a no-op —
  // no repeat IPC storm after the batch has been drained.
  it('does nothing on a second flush window with an empty batch', async () => {
    const h = await loadFlushHarness();
    h.slice.handleRealtimeEvent({ type: 'flagsChanged', accountId: 'A', emailId: 'e1', folderPath: 'INBOX' });
    await runFlush();
    const callsAfterFirst = h.state.refreshUnreadSummary.mock.calls.length;
    await runFlush();
    expect(h.state.refreshUnreadSummary.mock.calls.length).toBe(callsAfterFirst);
  });

  // Regression: the non-INBOX sweep reconciles flags with NO per-email events
  // (IDLE watches INBOX only), so `folders:updated` naming a folder is the ONLY
  // signal that folder's rows moved — it must always re-run that folder's query,
  // with or without a filter, held rows or not.
  it('re-runs the query for a folder main-process reconciled (folders:updated)', async () => {
    const h = await loadFlushHarness();
    h.slice.handleFoldersUpdated('A', 'INBOX');
    await runFlush();
    expect(h.state.mergeNewEmails).toHaveBeenCalledWith('f-inbox');
    expect(h.state.loadFolders).toHaveBeenCalledTimes(1);
  });

  // The signal is also sent without a folder (pure count change from the
  // backfill schedulers) — that must reload badges only, never re-query lists.
  it('reloads badges only when folders:updated names no folder', async () => {
    const h = await loadFlushHarness();
    h.slice.handleFoldersUpdated('A');
    await runFlush();
    expect(h.state.loadFolders).toHaveBeenCalledTimes(1);
    expect(h.state.mergeNewEmails).not.toHaveBeenCalled();
  });
});
