import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SYNC_PROGRESS_REFRESH_MS } from '../../../../../src/store/helpers';

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

// ---------------------------------------------------------------------------
// PROGRESSIVE FILL during a sync.
//
// `syncEmails` refreshes the view only once the WHOLE sync resolves — INBOX,
// Sent and Starred, each to the per-folder cap. On a first-run account (or one
// whose cache is being rebuilt) that is minutes of an empty list sitting next
// to a sidebar already counting mail that is in the DB. The engine reports
// progress after each batch is COMMITTED, so every tick is a chance to show
// what has landed; handleSyncProgress turns those ticks into a throttled
// refresh of whatever the user is actually looking at.
// ---------------------------------------------------------------------------

const loadSliceWithSet = async (getState: () => any) => {
  vi.resetModules();
  (globalThis as any).window = { electronAPI: {} };
  const mod = await import('../../../../../src/store/slices/sync-slice');
  const set = vi.fn();
  return { slice: mod.createSyncSlice(set, getState, {} as any), set };
};

/** A flat INBOX view — the refresh lands on mergeNewEmails. */
const flatInboxState = (overrides: Record<string, unknown> = {}) => {
  const mergeNewEmails = vi.fn().mockResolvedValue(undefined);
  const state = {
    folders: [{ id: 'f-inbox', path: 'INBOX' }, { id: 'f-sent', path: '[Gmail]/Sent Mail' }],
    selectedFolderId: 'f-inbox',
    inboxType: 'default',
    inboxSections: [],
    mergeNewEmails,
    // The real store always has this; a progress tick past the throttle re-reads
    // the folder list for its counts, so leaving it out would have every test in
    // here exercising the failure path instead of the one it is about.
    loadFolders: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { state, mergeNewEmails };
};

describe('handleSyncProgress (progressive fill during a sync)', () => {
  beforeEach(() => {
    // The gate compares against Date.now(); pin it so the throttle is exact.
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
  });

  // THE REGRESSION: the first committed batch must be on screen at once, not
  // after the whole multi-folder sync finishes.
  it('shows the first committed batch immediately', async () => {
    const { state, mergeNewEmails } = flatInboxState();
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 50 } as never);

    expect(mergeNewEmails).toHaveBeenCalledWith('f-inbox');
  });

  // Breaks: ~500 batch ticks on a 25k first sync each re-query and re-render the
  // list — the progressive fill becomes a treadmill on the main thread.
  it('throttles the ticks that follow inside the window', async () => {
    const { state, mergeNewEmails } = flatInboxState();
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 50 } as never);
    vi.advanceTimersByTime(SYNC_PROGRESS_REFRESH_MS - 1);
    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 100 } as never);

    expect(mergeNewEmails).toHaveBeenCalledTimes(1);
  });

  // Breaks: only the first batch is ever shown and the list stops filling.
  it('refreshes again once the throttle window has passed', async () => {
    const { state, mergeNewEmails } = flatInboxState();
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 50 } as never);
    vi.advanceTimersByTime(SYNC_PROGRESS_REFRESH_MS);
    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 100 } as never);

    expect(mergeNewEmails).toHaveBeenCalledTimes(2);
  });

  // Breaks: a flags-only pass or an already-current folder ticks progress
  // without storing a row, and we pay for a reload that returns the same list.
  it('skips a tick that stored nothing', async () => {
    const { state, mergeNewEmails } = flatInboxState();
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 50 } as never);
    vi.advanceTimersByTime(SYNC_PROGRESS_REFRESH_MS * 4);
    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 50 } as never);

    expect(mergeNewEmails).toHaveBeenCalledTimes(1);
  });

  // Breaks: a parallel sync moves `currentFolder` between folders, so keying the
  // refresh off it drops every INBOX batch that lands while Sent is the folder
  // being named — the user watches an empty inbox fill nothing.
  it('refreshes the folder ON SCREEN, not the one the engine is reporting', async () => {
    const loadAllSections = vi.fn().mockResolvedValue(undefined);
    const { state } = flatInboxState({
      inboxType: 'important-first',
      inboxSections: [{ id: 'important' }],
      loadAllSections,
    });
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: '[Gmail]/Sent Mail', messagesProcessed: 50 } as never);

    expect(loadAllSections).toHaveBeenCalledWith('INBOX');
  });

  // Breaks: "All Email" / "Starred" have no selected folder, so a folder-keyed
  // refresh silently does nothing and those views never fill during a sync.
  it('fills a virtual view, which has no selected folder', async () => {
    const mergeNewEmailsVirtualAll = vi.fn().mockResolvedValue(undefined);
    const { state } = flatInboxState({
      selectedFolderId: null,
      selectedVirtualFolder: 'virtual-all',
      mergeNewEmailsVirtualAll,
    });
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 50 } as never);

    expect(mergeNewEmailsVirtualAll).toHaveBeenCalled();
  });

  // Breaks: the progress bar and the sync-status dot stop moving — the status
  // must be recorded on EVERY tick, including the ones we decline to refresh on.
  it('records the status even on a tick it does not refresh for', async () => {
    const { state } = flatInboxState();
    const { slice, set } = await loadSliceWithSet(() => state);
    const status = { currentFolder: 'INBOX', messagesProcessed: 50 } as never;

    slice.handleSyncProgress(status);
    slice.handleSyncProgress(status); // same count -> no refresh

    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith({ syncStatus: status });
  });

  // Breaks: the wasted reload on every renderer load. The engine's very first
  // tick of a sync reports a cumulative count of 0 — nothing has been stored, so
  // there is nothing to show, and the list must not be re-queried for it.
  it('does not refresh for the opening tick that has stored nothing', async () => {
    const { state, mergeNewEmails } = flatInboxState();
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 0 } as never);

    expect(mergeNewEmails).not.toHaveBeenCalled();
  });

  // Breaks: the FIRST batch of every sync after the first. The engine resets its
  // cumulative count to 0 per sync, so the gate has to adopt that reset — held
  // at the previous sync's total instead, the next sync's batches all read as
  // "no progress" until they exceeded it, and a 40-message second sync behind a
  // 25,000-message first one would never show anything at all.
  it('keeps filling after the count resets for a new sync', async () => {
    const { state, mergeNewEmails } = flatInboxState();
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 25_000 } as never);
    vi.advanceTimersByTime(SYNC_PROGRESS_REFRESH_MS);
    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 0 } as never); // new sync
    vi.advanceTimersByTime(SYNC_PROGRESS_REFRESH_MS);
    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 40 } as never);

    // The reset itself stored nothing; the batch behind it did.
    expect(mergeNewEmails).toHaveBeenCalledTimes(2);
  });

  // Breaks: a malformed status from an older main process throws inside the IPC
  // listener, and every later tick — the whole progressive fill — is lost.
  it('survives a status with no progress figure', async () => {
    const { state, mergeNewEmails } = flatInboxState();
    const { slice } = await loadSliceWithSet(() => state);

    expect(() => slice.handleSyncProgress({} as never)).not.toThrow();
    expect(mergeNewEmails).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleSyncProgress — showing the FOLDER LIST mid-sync.
//
// The field report this guards: connect a fresh account and the sidebar says
// "No folders yet. Click sync below to fetch emails." while the footer counts
// "5/6 folders (22%)" and the list says "Select a folder to view emails". The
// renderer lists folders once, in doConnect, BEFORE the sync starts — and the
// main process writes the folder list at the top of the sync. On a first-run
// account the pre-sync read finds an empty table, so nothing is on screen for
// the whole first sync no matter how much mail lands in the DB.
// ---------------------------------------------------------------------------
describe('handleSyncProgress (showing folders mid-sync)', () => {
  /** A renderer that has NOT got a folder list yet — the first-run shape. */
  const emptySidebarState = (overrides: Record<string, unknown> = {}) => {
    const loadFolders = vi.fn().mockResolvedValue(undefined);
    const state: Record<string, any> = {
      folders: [],
      selectedFolderId: null,
      inboxType: 'default',
      inboxSections: [],
      mergeNewEmails: vi.fn().mockResolvedValue(undefined),
      loadFolders,
      ...overrides,
    };
    return { state, loadFolders };
  };

  /**
   * The adoption is fire-and-forget, so let its `await get().loadFolders()`
   * settle and its in-flight guard clear. Microtasks only — the suite runs on
   * fake timers, and nothing here is on a timer.
   */
  const settleAdoption = () => Promise.resolve().then(() => {}).then(() => {});

  // THE REGRESSION: an empty sidebar for the whole first sync. The tick that
  // first reports a folder count is the moment the list can be shown.
  it('loads the folder list on the first tick that reports one', async () => {
    const { state, loadFolders } = emptySidebarState();
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ foldersTotal: 6, messagesProcessed: 0 } as never);

    expect(loadFolders).toHaveBeenCalledTimes(1);
  });

  // Breaks: the adoption must NOT ride the progressive-fill gate. The tick that
  // first carries a folder count has stored no messages yet, so the gate
  // rejects it — and gating the folder load on it would put the sidebar back to
  // waiting for the first committed batch.
  it('shows folders on a tick that has stored no mail yet', async () => {
    const { state, loadFolders } = emptySidebarState();
    const { slice } = await loadSliceWithSet(() => state);

    // messagesProcessed 0 == the engine's opening tick; no refresh is due.
    slice.handleSyncProgress({ foldersTotal: 6, messagesProcessed: 0 } as never);

    expect(loadFolders).toHaveBeenCalled();
    expect(state.mergeNewEmails).not.toHaveBeenCalled();
  });

  // Breaks: a tick fires every ~10 messages, so an ungated adoption runs a
  // folders:list (a withFiledCounts pass over the DB) hundreds of times per
  // sync on the main thread — the exact stall this app profiles for. Once the
  // list is adopted the ONLY thing allowed to re-read it is the throttled count
  // refresh below, so a burst of ticks inside one window costs at most one more.
  it('does not re-list folders on every later tick', async () => {
    // Mirror the real loadFolders: it populates the store's folder list.
    const loadFolders = vi.fn(async () => { state.folders = [{ id: 'f-inbox', path: 'INBOX' }]; });
    const { state } = emptySidebarState({ loadFolders });
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ foldersTotal: 6, messagesProcessed: 0 } as never);
    await settleAdoption();
    for (let processed = 10; processed <= 200; processed += 10) {
      slice.handleSyncProgress({ foldersTotal: 6, messagesProcessed: processed } as never);
      await settleAdoption();
    }

    // 1 adoption + 1 count refresh, for 20 ticks — not 21.
    expect(loadFolders).toHaveBeenCalledTimes(2);
  });

  // Breaks: a slow folders:list has several adoptions in flight at once, each
  // auto-selecting INBOX under the others — a folder the user picked mid-sync
  // gets yanked back, repeatedly.
  it('does not stack a second load while the first is still in flight', async () => {
    // Never resolves: the first adoption stays in flight for the whole test.
    const loadFolders = vi.fn(() => new Promise<void>(() => {}));
    const { state } = emptySidebarState({ loadFolders });
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ foldersTotal: 6, messagesProcessed: 0 } as never);
    slice.handleSyncProgress({ foldersTotal: 6, messagesProcessed: 10 } as never);
    await settleAdoption();

    expect(loadFolders).toHaveBeenCalledTimes(1);
  });

  // Breaks: an account that already has its folders (every sync after the
  // first, and every reconnect) gets its INBOX re-selected out from under the
  // reader. A populated sidebar is the count-refresh's job below, NOT the
  // adoption's — only the adoption auto-selects a folder, so it must stay off.
  it('does not adopt when the sidebar is already populated', async () => {
    const { state } = flatInboxState({ loadFolders: vi.fn().mockResolvedValue(undefined) });
    const { slice } = await loadSliceWithSet(() => state);

    // A tick BELOW the progressive-fill gate: nothing stored yet, so the count
    // refresh is not due either and only the adoption could fire here.
    slice.handleSyncProgress({ foldersTotal: 6, messagesProcessed: 0 } as never);

    expect((state as any).loadFolders).not.toHaveBeenCalled();
  });

  // Breaks: a folders:list that rejects (storage not initialised yet during the
  // main-process restart dev does on every save) leaves the in-flight guard
  // stuck true, and the sidebar never recovers for the life of the renderer.
  it('retries on a later tick after a failed load', async () => {
    const loadFolders = vi.fn()
      .mockRejectedValueOnce(new Error('Storage not initialized'))
      .mockResolvedValue(undefined);
    const { state } = emptySidebarState({ loadFolders });
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ foldersTotal: 6, messagesProcessed: 0 } as never);
    await settleAdoption();
    slice.handleSyncProgress({ foldersTotal: 6, messagesProcessed: 10 } as never);

    expect(loadFolders).toHaveBeenCalledTimes(2);
  });

  // Breaks: a malformed status (an older main process, a null between syncs)
  // throws inside the IPC listener and kills the whole progressive fill with it.
  it('survives a status carrying no folder count', async () => {
    const { state, loadFolders } = emptySidebarState();
    const { slice } = await loadSliceWithSet(() => state);

    expect(() => slice.handleSyncProgress({ messagesProcessed: 10 } as never)).not.toThrow();
    expect(loadFolders).not.toHaveBeenCalled();
  });
});

/**
 * THE REGRESSION: the sidebar badge that never moves during a sync.
 *
 * The badge renders `folders.unread_count`, a STORED column. The engine now
 * re-states it per folder while that folder syncs, but the renderer only SEES a
 * new value by re-listing folders — and it listed once per connect plus once
 * when the whole sync resolved. So the badge sat on its opening number for the
 * entire download while the section totals beside it, which are live queries,
 * climbed by thousands. Reported as "counters are increasing drastically ...
 * just [the] counter is stuck".
 */
describe('handleSyncProgress (folder counts during a sync)', () => {
  beforeEach(() => {
    // The refresh rides the progressive-fill gate, which compares Date.now().
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
  });

  /** Fire-and-forget, so let `await get().loadFolders()` settle and the
   *  in-flight guard clear. Microtasks only — nothing here is on a timer. */
  const settle = () => Promise.resolve().then(() => {}).then(() => {});

  // Breaks: the badge stays frozen for the whole sync. This is the fix.
  it('re-reads the folder list when the fill gate opens', async () => {
    const loadFolders = vi.fn().mockResolvedValue(undefined);
    const { state } = flatInboxState({ loadFolders });
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 50 } as never);

    expect(loadFolders).toHaveBeenCalledTimes(1);
  });

  // Breaks: a folders:list (a withFiledCounts pass over the DB) on every one of
  // the ~2,500 progress ticks a 25k-message sync fires. It must share the list
  // refresh's throttle, not run per batch.
  it('does not re-read on a tick inside the throttle window', async () => {
    const loadFolders = vi.fn().mockResolvedValue(undefined);
    const { state } = flatInboxState({ loadFolders });
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 50 } as never);
    await settle();
    vi.advanceTimersByTime(200); // well inside SYNC_PROGRESS_REFRESH_MS
    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 60 } as never);

    expect(loadFolders).toHaveBeenCalledTimes(1);
  });

  // Breaks: a slow folders:list piles up one call per tick behind the first,
  // each one landing a stale folder array on top of a newer one.
  it('does not stack a second read while one is still in flight', async () => {
    const loadFolders = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const { state } = flatInboxState({ loadFolders });
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 50 } as never);
    vi.advanceTimersByTime(5_000);
    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 100 } as never);
    await settle();

    expect(loadFolders).toHaveBeenCalledTimes(1);
  });

  // Breaks: a rejected folders:list (storage not initialised yet — dev restarts
  // the main process on every save) leaves the guard stuck true and the badge
  // frozen for the life of the renderer, which is the bug this fixes.
  it('recovers on a later tick after a failed read', async () => {
    const loadFolders = vi.fn()
      .mockRejectedValueOnce(new Error('Storage not initialized'))
      .mockResolvedValue(undefined);
    const { state } = flatInboxState({ loadFolders });
    const { slice } = await loadSliceWithSet(() => state);

    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 50 } as never);
    await settle();
    vi.advanceTimersByTime(5_000);
    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 100 } as never);

    expect(loadFolders).toHaveBeenCalledTimes(2);
  });

  // Breaks: the first-run account. An empty sidebar belongs to the ADOPTION
  // (which also selects INBOX); refreshing counts there would race it with a
  // second folders:list that has no selection to make.
  it('leaves an empty sidebar to the adoption', async () => {
    const loadFolders = vi.fn().mockResolvedValue(undefined);
    const state: Record<string, any> = {
      folders: [], selectedFolderId: null, inboxType: 'default', inboxSections: [],
      mergeNewEmails: vi.fn().mockResolvedValue(undefined), loadFolders,
    };
    const { slice } = await loadSliceWithSet(() => state);

    // No folder count on this tick, so the adoption cannot fire either: the
    // count refresh is the only candidate, and it must decline.
    slice.handleSyncProgress({ currentFolder: 'INBOX', messagesProcessed: 50 } as never);

    expect(loadFolders).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mergeNewEmails — the background refresh must re-read THE PAGE THE USER IS ON.
//
// The field report this guards: Sent showed "1–100 of 1,718" under a page that
// holds far fewer rows. Every sync completion refetched a hardcoded 100 rows at
// offset 0 and unioned them into the in-memory list, so the page grew past its
// own window (the label counts rows in memory) and, on any page but the first,
// silently replaced what the reader was looking at with page 1.
// ---------------------------------------------------------------------------
describe('mergeNewEmails (page-window refresh)', () => {
  const row = (id: string, date: number) => ({ id, threadId: `t-${id}`, date, tags: '', subject: id });

  const mergeHarness = async (state: Record<string, any>, listRows: any[]) => {
    vi.resetModules();
    const list = vi.fn(async () => ({ success: true, data: listRows }));
    (globalThis as any).window = { electronAPI: { emails: { list } } };
    const full: any = { pendingDeletes: [], emailsPage: 0, folders: [], ...state };
    const mod = await import('../../../../../src/store/slices/sync-slice');
    const slice = mod.createSyncSlice(
      ((patch: any) => Object.assign(full, patch)) as any,
      (() => full) as any,
      {} as any,
    );
    return { slice, state: full, list };
  };

  it('asks for the folder page size at the current page offset, not a fixed 100 at 0', async () => {
    // Sent is one of the account's own standard mailboxes: 50 a page. On page 3
    // the refresh must read rows 150-199, which is what the reader can see.
    const { slice, list } = await mergeHarness(
      {
        folders: [{ id: 'f-sent', path: 'Sent', specialUse: '\\Sent' }],
        selectedFolderId: 'f-sent',
        emailsPage: 3,
        emails: [row('e1', 5)],
      },
      [row('e1', 5)],
    );
    await slice.mergeNewEmails('f-sent');
    expect(list).toHaveBeenCalledWith('f-sent', 50, 150);
  });

  it('never leaves more rows in memory than the page holds', async () => {
    // This is the "1–100 of 1,718" label: the Paginator counts the rows in the
    // store, so a merge that grows the array past the window mislabels the page.
    const fresh = Array.from({ length: 50 }, (_, i) => row(`n${i}`, 1000 - i));
    const { slice, state } = await mergeHarness(
      {
        folders: [{ id: 'f-sent', path: 'Sent', specialUse: '\\Sent' }],
        selectedFolderId: 'f-sent',
        emails: [row('old', 1)],
      },
      fresh,
    );
    await slice.mergeNewEmails('f-sent');
    expect(state.emails).toHaveLength(50);
    expect(state.emails[0].id).toBe('n0');
  });

  it('leaves the list untouched when the window came back identical', async () => {
    // A new array identity on every sync tick re-renders every row and rebuilds
    // every thread — the merge must be a no-op when nothing moved.
    const same = [row('e1', 5), row('e2', 4)];
    const { slice, state } = await mergeHarness(
      { folders: [{ id: 'f-inbox', path: 'INBOX' }], selectedFolderId: 'f-inbox', emails: same },
      [row('e1', 5), row('e2', 4)],
    );
    await slice.mergeNewEmails('f-inbox');
    expect(state.emails).toBe(same);
  });

  it('does not resurrect a row inside the delete-undo window', async () => {
    // It still exists in the DB for 5s, so it is in every refetch; re-adding it
    // makes the deleted mail flash back until the user switches folders.
    const { slice, state } = await mergeHarness(
      {
        folders: [{ id: 'f-inbox', path: 'INBOX' }],
        selectedFolderId: 'f-inbox',
        emails: [row('e1', 5)],
        pendingDeletes: [{ emailId: 'ghost' }],
      },
      [row('e1', 5), row('ghost', 9)],
    );
    await slice.mergeNewEmails('f-inbox');
    expect(state.emails.map((e: any) => e.id)).toEqual(['e1']);
  });

  it('swallows an IPC failure rather than breaking the sync-complete handler', async () => {
    vi.resetModules();
    (globalThis as any).window = {
      electronAPI: { emails: { list: vi.fn(async () => { throw new Error('ipc down'); }) } },
    };
    const full: any = { pendingDeletes: [], emailsPage: 0, folders: [], emails: [] };
    const mod = await import('../../../../../src/store/slices/sync-slice');
    const slice = mod.createSyncSlice((() => {}) as any, (() => full) as any, {} as any);
    await expect(slice.mergeNewEmails('f-inbox')).resolves.toBeUndefined();
  });
});

describe('mergeNewEmailsVirtualStarred — the window is CONVERSATIONS', () => {
  // Breaks: getStarred hands back every message of the page's threads, so a
  // message-grained cap chops the tail off the last conversation — the row
  // renders missing its older mail and the next page repeats it.
  it('keeps pageSize whole conversations, not pageSize messages', async () => {
    vi.resetModules();
    const message = (id: string, threadId: string, date: number) =>
      ({ id, threadId, tags: '|INBOX|starred|', date, subject: id });
    // 30 conversations x 3 messages, against the 50-per-page Starred tier.
    const fresh = Array.from({ length: 90 }, (_, i) =>
      message(`m${i}`, `t${Math.floor(i / 3)}`, 10_000 - i));
    (globalThis as any).window = {
      electronAPI: { emails: { getStarred: async () => ({ success: true, data: fresh }) } },
    };
    const mod = await import('../../../../../src/store/slices/sync-slice');
    const state: Record<string, any> = {
      emails: [], emailsPage: 0, selectedVirtualFolder: 'virtual-starred',
      viewingSection: null, viewingSectionPageSize: 0, viewingAICategory: null,
      selectedFolderId: null, folders: [],
    };
    const set = (patch: Record<string, any>) => { Object.assign(state, patch); };
    const slice = mod.createSyncSlice(set as never, (() => state) as never, {} as never);

    await slice.mergeNewEmailsVirtualStarred();

    const byThread = new Set(state.emails.map((e: any) => e.threadId));
    expect(byThread.size).toBe(30);            // every conversation the page held
    expect(state.emails).toHaveLength(90);     // with all of their messages
  });

  // Breaks: the same cap on "All Email", whose 100-per-page window makes a
  // message-grained truncation both more likely and more visible.
  it('caps All Email by conversation too, at its own page size', async () => {
    vi.resetModules();
    // 60 conversations x 3 messages, against the 100-per-page All Email tier —
    // 180 messages, so a message-grained cap would stop inside conversation 34.
    const fresh = Array.from({ length: 180 }, (_, i) =>
      ({ id: `m${i}`, threadId: `t${Math.floor(i / 3)}`, tags: '|INBOX|', date: 10_000 - i, subject: `m${i}` }));
    (globalThis as any).window = {
      electronAPI: { emails: { getAll: async () => ({ success: true, data: fresh }) } },
    };
    const mod = await import('../../../../../src/store/slices/sync-slice');
    const state: Record<string, any> = {
      emails: [], emailsPage: 0, selectedVirtualFolder: 'virtual-all',
      viewingSection: null, viewingSectionPageSize: 0, viewingAICategory: null,
      selectedFolderId: null, folders: [],
    };
    const set = (patch: Record<string, any>) => { Object.assign(state, patch); };
    const slice = mod.createSyncSlice(set as never, (() => state) as never, {} as never);

    await slice.mergeNewEmailsVirtualAll();

    const byThread = new Set(state.emails.map((e: any) => e.threadId));
    expect(byThread.size).toBe(60);            // all 60 fit inside the 100-thread window
    expect(state.emails).toHaveLength(180);    // with all of their messages
  });
});
