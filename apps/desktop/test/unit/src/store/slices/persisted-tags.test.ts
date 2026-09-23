import { afterEach, describe, expect, it, vi } from 'vitest';

// Adopting a tag change MAIN made on its own — the one direction that had no
// way back into the renderer. An extension acting on a card (the OTP card's
// copy button) writes through `context.mail`, which persists to storage and
// pushes the flag to the server without ever asking the window. Before this the
// row simply kept its old tags: the mail was read everywhere except on screen.

const loadSlice = async (seed: Record<string, any> = {}) => {
  vi.resetModules();
  (globalThis as any).window = { electronAPI: { emails: {} } };
  const mod = await import('../../../../../src/store/slices/email-actions-slice');
  let state: any = {};
  const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const get = () => state;
  const slice = mod.createEmailActionsSlice(set, get, {} as any);
  state = {
    emails: [], searchResults: [], threadEmails: [], sectionData: {},
    manuallyMarkedUnreadId: null,
    ...slice,
    ...seed,
    _accountIdFor: () => 'acct-1',
    loadFolders: vi.fn(),
    refreshCategoryCounts: vi.fn(),
    refreshUnreadSummary: vi.fn(),
  };
  return { get, actions: slice as any };
};

/** `buildThreads` (called when a section rebuilds) reads a flag off localStorage. */
const installLocalStorage = () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};

const row = (id: string, tags = '|INBOX|') => ({ id, threadId: `t-${id}`, tags, date: 1_000 });

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
});

describe('applyPersistedTags', () => {
  // Regression: THE reported bug, at the seat that shows it. The extension
  // marked the mail read in storage and on the server and the list row stayed
  // bold, which reads as a copy button that did nothing.
  it('replaces the row tags in the flat list', async () => {
    const { get, actions } = await loadSlice({ emails: [row('e1'), row('e2')] });

    actions.applyPersistedTags('e1', '|INBOX|read|otp|');

    expect(get().emails.map((e: any) => e.tags)).toEqual(['|INBOX|read|otp|', '|INBOX|']);
  });

  // The same message is on screen in up to four places at once — the list, the
  // open thread, a search result and a section bucket. One of them keeping the
  // old tags is the same bug in a different pane.
  it('reaches the thread, the search results and every section', async () => {
    installLocalStorage();
    const { get, actions } = await loadSlice({
      emails: [row('e1')],
      threadEmails: [row('e1')],
      searchResults: [row('e1')],
      sectionData: {
        today: { emails: [row('e1')], threads: [], offset: 0, hasMore: false, total: 1, loading: false },
      },
    });

    actions.applyPersistedTags('e1', '|INBOX|read|');

    expect(get().emails[0].tags).toBe('|INBOX|read|');
    expect(get().threadEmails[0].tags).toBe('|INBOX|read|');
    expect(get().searchResults[0].tags).toBe('|INBOX|read|');
    expect(get().sectionData.today.emails[0].tags).toBe('|INBOX|read|');
  });

  // The badge and the unread bell are backend reads. A message no open list is
  // showing must not cost three queries — on a first sync that is once per mail.
  it('refreshes the counts only when a row actually moved', async () => {
    const { get, actions } = await loadSlice({ emails: [row('e1')] });

    actions.applyPersistedTags('elsewhere', '|INBOX|read|');
    expect(get().loadFolders).not.toHaveBeenCalled();
    expect(get().refreshUnreadSummary).not.toHaveBeenCalled();

    actions.applyPersistedTags('e1', '|INBOX|read|');
    expect(get().loadFolders).toHaveBeenCalled();
    expect(get().refreshUnreadSummary).toHaveBeenCalled();
  });

  // Re-delivery of the same payload (a reconnect, a duplicate send) must not
  // churn the list — an unchanged tag string leaves the array identity alone,
  // which is what stops every row re-rendering.
  it('leaves state untouched when the tags already match', async () => {
    const { get, actions } = await loadSlice({ emails: [row('e1', '|INBOX|read|')] });
    const before = get().emails;

    actions.applyPersistedTags('e1', '|INBOX|read|');

    expect(get().emails).toBe(before);
    expect(get().loadFolders).not.toHaveBeenCalled();
  });

  // Main is the authority here, but the payload crosses an IPC boundary: a
  // malformed one must be ignored, not written into a row as `undefined` tags
  // — a row whose tags are not a string breaks every tag check downstream.
  it('ignores a payload with no id or no tag string', async () => {
    const { get, actions } = await loadSlice({ emails: [row('e1')] });

    actions.applyPersistedTags('', '|INBOX|read|');
    actions.applyPersistedTags('e1', undefined as unknown as string);

    expect(get().emails[0].tags).toBe('|INBOX|');
  });
});

describe('markAsRead still records a manual unread', () => {
  // Regression: `manuallyMarkedUnreadId` is set even when NO row moved — the
  // shared applier gained an "extras" channel when applyPersistedTags was
  // added, and counting only tag changes would have made marking an already
  // unread message unread a silent no-op that skipped the persist.
  it('sets manuallyMarkedUnreadId for a row that is already unread', async () => {
    const { get, actions } = await loadSlice({ emails: [row('e1')] });
    (globalThis as any).window.electronAPI.emails.markRead = vi.fn(async () => ({ success: true }));

    await actions.markAsRead('e1', false);
    // The persist is deferred to a macrotask; let it land before teardown pulls
    // `window` out from under it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(get().manuallyMarkedUnreadId).toBe('e1');
    expect((globalThis as any).window.electronAPI.emails.markRead)
      .toHaveBeenCalledWith('e1', false, 'acct-1');
  });
});

describe('setupPersistedTagListener', () => {
  const load = async (emails: any) => {
    vi.resetModules();
    vi.doMock('../../../../../src/components/email-list/CategoryBadges', () => ({
      clearCategoryBadgeCache: vi.fn(),
      applyEmailCategories: vi.fn(),
      getCachedCategorySlugs: vi.fn(() => []),
      warmCategoryDefs: vi.fn(),
    }));
    (globalThis as any).window = { electronAPI: emails === null ? {} : { emails } };
    return import('../../../../../src/store/helpers');
  };

  // Regression: the payload has to reach the store. A listener registered
  // against the wrong API shape is the same as no listener at all — the write
  // still lands in the database and the row still never changes.
  it('routes a delivered update into applyPersistedTags', async () => {
    let deliver: ((u: unknown) => void) | null = null;
    const { setupPersistedTagListener } = await load({
      onTagsUpdated: (cb: (u: unknown) => void) => { deliver = cb; return () => {}; },
    });
    const applyPersistedTags = vi.fn();
    setupPersistedTagListener({ getState: () => ({ applyPersistedTags }) });

    deliver!({ emailId: 'e1', accountId: 'acct-1', tags: '|INBOX|read|' });

    expect(applyPersistedTags).toHaveBeenCalledWith('e1', '|INBOX|read|');
  });

  // An update with no id names no row. Passing it on would be a store write
  // that can only miss, and the guard is what lets the payload shape change
  // without this throwing in the renderer.
  it('drops an update that names no message', async () => {
    let deliver: ((u: unknown) => void) | null = null;
    const { setupPersistedTagListener } = await load({
      onTagsUpdated: (cb: (u: unknown) => void) => { deliver = cb; return () => {}; },
    });
    const applyPersistedTags = vi.fn();
    setupPersistedTagListener({ getState: () => ({ applyPersistedTags }) });

    deliver!({ tags: '|INBOX|read|' });
    deliver!(null);

    expect(applyPersistedTags).not.toHaveBeenCalled();
  });

  // The preload of an older build has no such channel. Setup runs at module
  // load, so throwing here would take the whole store down with it.
  it('does nothing when the host exposes no channel', async () => {
    const { setupPersistedTagListener } = await load(null);
    expect(() => setupPersistedTagListener({ getState: () => ({}) })).not.toThrow();
  });
});
