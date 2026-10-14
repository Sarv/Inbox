import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirm = vi.hoisted(() => vi.fn());
vi.mock('../../../../../src/store/confirm-service', () => ({ requestConfirm: confirm }));

type BulkResponse = {
  success: boolean;
  error?: string;
  data?: { processedIds: string[]; failedIds: string[]; queuedIds?: string[] };
};

type BulkProgress = { requestId: string; action: string; accountId?: string; emailIds: string[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const row = (id: string, accountId = 'account-a', extra: Record<string, any> = {}) => ({
  id, accountId, threadId: `thread-${id}`, date: 1_000, tags: '|INBOX|', ...extra,
});
const ids = (rows: any[]) => rows.map((email) => email.id);

async function loadSlice(seed: Record<string, any> = {}) {
  vi.resetModules();
  const bulkAction = vi.fn(async (): Promise<BulkResponse> => ({ success: true }));
  const alert = vi.fn();
  (globalThis as any).window = { electronAPI: { emails: { bulkAction } }, alert };
  const { createEmailActionsSlice } = await import('../../../../../src/store/slices/email-actions-slice');
  const { createStore } = await import('zustand/vanilla');
  const store = createStore<any>((set, get, api) => ({
    ...createEmailActionsSlice(set, get, api),
    emails: [], threadEmails: [], searchResults: [], sectionData: {}, sectionLoading: new Set(),
    inboxType: 'default', inboxSections: [],
    folders: [{ id: 'inbox', path: 'INBOX' }],
    activeAccountId: 'account-a', viewAccountId: null, threadAccountId: null,
    selectedFolderId: null, selectedVirtualFolder: 'virtual-unified',
    viewingAICategory: null, viewingSection: null, viewingSnoozed: false,
    selectedEmailId: null, highlightedEmailId: null,
    searchQuery: '', searchPage: 0, searching: false, loadingMoreEmails: false,
    activeInboxFilter: null, emailsPage: 0, emailsTotal: 25,
    loadFolders: vi.fn(async () => {}), refreshCategoryCounts: vi.fn(async () => {}),
    refreshUnreadSummary: vi.fn(async () => {}), goToEmailPage: vi.fn(async () => {}),
    goToSearchPage: vi.fn(async () => {}), loadSectionEmails: vi.fn(async () => {}),
    ...seed,
  }));
  return { actions: store.getState(), get: store.getState, set: store.setState, bulkAction, alert };
}

// Use the real pager and action slices against a small paged backend. A spy on
// goToEmailPage alone misses its loading guard, the cause of the refill race.
async function loadPagedSlices(view: Record<string, any> = {}, { withProgress = false } = {}) {
  vi.resetModules();
  const [{ createStore }, { createEmailsSlice }, { createEmailActionsSlice }, { getPageSizeForState }] = await Promise.all([
    import('zustand/vanilla'),
    import('../../../../../src/store/slices/emails-slice'),
    import('../../../../../src/store/slices/email-actions-slice'),
    import('../../../../../src/store/helpers'),
  ]);
  const base = {
    activeAccountId: 'account-a', accounts: [{ id: 'account-a' }],
    selectedFolderId: 'inbox', selectedVirtualFolder: null, viewingAICategory: null,
    viewingSection: null, viewingSectionPageSize: 50, viewingSnoozed: false,
    searchQuery: '', searchResults: [], searchPage: 0, searching: false,
    activeInboxFilter: null, inboxType: 'default', inboxSections: [],
    folders: [{ id: 'inbox', path: 'INBOX' }, { id: 'sent', path: 'Sent', specialUse: '\\Sent' }],
    ...view,
  };
  const pageSize = getPageSizeForState(base);
  const original = Array.from({ length: pageSize * 2 + 3 }, (_, index) => row(`e${index}`));
  let backend = [...original];
  const removeLocally = (removed: string[]) => { backend = backend.filter((email) => !removed.includes(email.id)); };
  const restoreLocally = (restored: string[]) => {
    const retainedIds = new Set([...ids(backend), ...restored]);
    backend = original.filter((email) => retainedIds.has(email.id));
  };
  const pageFetch = vi.fn(async (limit: number, offset: number) => ({ success: true, data: backend.slice(offset, offset + limit) }));
  const bulkAction = vi.fn(async (removed: string[], ..._request: unknown[]): Promise<BulkResponse> => {
    removeLocally(removed);
    return { success: true, data: { processedIds: removed, failedIds: [] } };
  });
  const progressListeners = new Set<(progress: BulkProgress) => void>();
  const onBulkActionProgress = vi.fn((callback: (progress: BulkProgress) => void) => {
    progressListeners.add(callback);
    return vi.fn(() => { progressListeners.delete(callback); });
  });
  const emitProgress = (progress: BulkProgress) => { for (const listener of progressListeners) listener(progress); };
  const categoryCounts = async () => ({ success: true, data: { [base.viewingAICategory || 'promotions']: backend.length } });
  (globalThis as any).window = {
    alert: vi.fn(),
    electronAPI: {
      emails: {
        bulkAction,
        ...(withProgress ? { onBulkActionProgress } : {}),
        list: (_folder: string, limit: number, offset = 0) => pageFetch(limit, offset),
        getAll: pageFetch, getImportant: pageFetch, getStarred: pageFetch,
        getVirtualFolderCounts: async () => ({ success: true, data: { all: backend.length, important: backend.length, starred: backend.length, snoozed: backend.length } }),
        listBySection: (_filter: string, limit: number, offset: number) => pageFetch(limit, offset),
        sectionCounts: async (filters: string[]) => ({ success: true, data: Object.fromEntries(filters.map((filter) => [filter, backend.length])) }),
      },
      ai: {
        getByCategory: (_category: string, limit: number, offset: number) => pageFetch(limit, offset),
        getCategoryCounts: categoryCounts,
      },
      accounts: {
        unifiedCategoryCounts: categoryCounts,
        unifiedInbox: async ({ limit, offset }: { limit: number; offset: number }) => {
          const result = await pageFetch(limit, offset);
          return { success: true, data: { emails: result.data, total: backend.length, hasMore: offset + result.data.length < backend.length } };
        },
      },
      snooze: { listEmails: ({ limit, offset }: { limit: number; offset: number }) => pageFetch(limit, offset) },
    },
  };
  const store = createStore<any>((set, get, api) => ({
    ...createEmailsSlice(set, get, api),
    ...createEmailActionsSlice(set, get, api),
    ...base,
    loadFolders: vi.fn(async () => set((state: any) => ({ folders: state.folders.map((folder: any) => ({ ...folder, totalCount: backend.length, serverMessageCount: 0 })) }))),
    refreshCategoryCounts: vi.fn(async () => {}), refreshUnreadSummary: vi.fn(async () => {}),
  }));
  await store.getState().loadFolders();
  await store.getState().goToEmailPage(0);
  store.getState().loadFolders.mockClear();
  return { get: store.getState, set: store.setState, original, pageSize, pageFetch, bulkAction, removeLocally, restoreLocally, emitProgress, onBulkActionProgress, progressListeners };
}

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

describe('bulkRemoveEmails account routing and acknowledgements', () => {
  it('captures all 25 owning accounts before confirmation can refresh the page', async () => {
    const original = Array.from({ length: 25 }, (_, index) => row(`e${index}`, index < 10 ? 'account-a' : 'account-b'));
    const confirmation = deferred<boolean>();
    confirm.mockReturnValueOnce(confirmation.promise);
    const { actions, get, set, bulkAction, alert } = await loadSlice({ emails: original });
    const removing = actions.bulkRemoveEmails(ids(original), 'delete');

    expect(bulkAction).not.toHaveBeenCalled();
    set({ emails: [row('new-arrival', 'account-b')] });
    confirmation.resolve(true);
    await removing;

    expect(bulkAction).toHaveBeenCalledWith(ids(original.slice(0, 10)), 'delete', 'account-a', false);
    expect(bulkAction).toHaveBeenCalledWith(ids(original.slice(10)), 'delete', 'account-b', false);
    expect(ids(get().emails)).toEqual(['new-arrival']);
    expect(alert).not.toHaveBeenCalled();
  });

  it('does nothing when a bulk confirmation is cancelled', async () => {
    confirm.mockResolvedValueOnce(false);
    const original = Array.from({ length: 20 }, (_, index) => row(`e${index}`));
    const { actions, get, bulkAction } = await loadSlice({ emails: original });
    await actions.bulkRemoveEmails(ids(original), 'delete');
    expect(get().emails).toBe(original);
    expect(bulkAction).not.toHaveBeenCalled();
  });

  it('explains that 25 unified messages move to each of their two accounts’ Trash', async () => {
    const original = Array.from({ length: 25 }, (_, index) => row(`e${index}`, index < 10 ? 'account-a' : 'account-b'));
    const { actions, alert } = await loadSlice({ emails: original });
    await actions.bulkRemoveEmails(ids(original), 'delete');
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0].message).toBe("You're about to move 25 messages to Trash across 2 accounts. Find these messages in each account's Trash. Continue?");
    expect(alert).not.toHaveBeenCalled();
  });

  it('captures the active account for single-account rows before an account switch', async () => {
    const confirmation = deferred<boolean>();
    confirm.mockReturnValueOnce(confirmation.promise);
    const original = Array.from({ length: 20 }, (_, index) => row(`e${index}`, 'account-a', { accountId: undefined }));
    const { actions, get, set, bulkAction } = await loadSlice({ emails: original, selectedVirtualFolder: null, selectedFolderId: 'inbox' });
    const removing = actions.bulkRemoveEmails(ids(original), 'delete');
    const newView = [row('other-account', 'account-b')];
    set({ activeAccountId: 'account-b', emails: newView });
    confirmation.resolve(true);
    await removing;
    expect(bulkAction).toHaveBeenCalledWith(ids(original), 'delete', 'account-a', false);
    expect(get().emails).toBe(newView);
  });

  it('awaits the account requests and accepts queued messages', async () => {
    const pending = deferred<BulkResponse>();
    const { actions, get, bulkAction, alert } = await loadSlice({ emails: [row('e1'), row('e2')] });
    bulkAction.mockReturnValueOnce(pending.promise);
    let complete = false;
    const removing = actions.bulkRemoveEmails(['e1', 'e2'], 'delete').then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(get().loadFolders).not.toHaveBeenCalled();

    pending.resolve({ success: true, data: { processedIds: ['e1'], failedIds: [], queuedIds: ['e2'] } });
    await removing;
    expect(ids(get().emails)).toEqual([]);
    expect(complete).toBe(true);
    expect(alert).not.toHaveBeenCalled();
    expect(get().goToEmailPage).toHaveBeenCalledWith(0);
  });

  it('restores only failed and omitted rows without overwriting a background refresh', async () => {
    const pending = deferred<BulkResponse>();
    const failed = row('failed');
    const omitted = row('omitted');
    const original = [row('accepted'), failed, omitted, row('keep')];
    const { actions, get, set, bulkAction, alert } = await loadSlice({ emails: original, searchResults: original });
    bulkAction.mockReturnValueOnce(pending.promise);
    const removing = actions.bulkRemoveEmails(['accepted', 'failed', 'omitted'], 'delete');
    const freshKeep = row('keep', 'account-a', { tags: '|INBOX|read|' });
    set({ emails: [row('new-arrival'), freshKeep], searchResults: [freshKeep] });
    pending.resolve({ success: false, data: { processedIds: ['accepted'], failedIds: ['failed'] } });
    await removing;

    expect(ids(get().emails)).toEqual(['new-arrival', 'failed', 'omitted', 'keep']);
    expect(get().emails.find((email: any) => email.id === 'keep')).toBe(freshKeep);
    expect(ids(get().searchResults)).toEqual(['failed', 'omitted', 'keep']);
    expect(alert).toHaveBeenCalledWith('Could not delete 2 messages. Check your connection and try again.');
  });

  it('keeps successful account groups removed when another request rejects', async () => {
    const { actions, get, bulkAction, alert } = await loadSlice({ emails: [row('e1'), row('e2', 'account-b')] });
    bulkAction.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('connection unavailable'));
    await actions.bulkRemoveEmails(['e1', 'e2'], 'delete');
    expect(ids(get().emails)).toEqual(['e2']);
    expect(alert).toHaveBeenCalledWith('Could not delete 1 message. Check your connection and try again.');
  });

  it('removes accepted rows reintroduced by a refresh while keeping fresh failed rows', async () => {
    const pending = deferred<BulkResponse>();
    const { actions, get, set, bulkAction } = await loadSlice({ emails: [row('accepted'), row('failed')] });
    bulkAction.mockReturnValueOnce(pending.promise);
    const removing = actions.bulkRemoveEmails(['accepted', 'failed'], 'delete');
    const freshFailed = row('failed', 'account-a', { tags: '|INBOX|read|' });
    set({ emails: [row('new-arrival'), row('accepted'), freshFailed] });
    pending.resolve({ success: false, data: { processedIds: ['accepted'], failedIds: ['failed'] } });
    await removing;
    expect(ids(get().emails)).toEqual(['new-arrival', 'failed']);
    expect(get().emails[1]).toBe(freshFailed);
  });

  it('treats a legacy success:false response as a complete failure', async () => {
    const { actions, get, bulkAction, alert } = await loadSlice({ emails: [row('e1'), row('e2')] });
    bulkAction.mockResolvedValueOnce({ success: false, error: 'Account unavailable' });
    await actions.bulkRemoveEmails(['e1', 'e2'], 'delete');
    expect(ids(get().emails)).toEqual(['e1', 'e2']);
    expect(alert).toHaveBeenCalledOnce();
    expect(get().goToEmailPage).not.toHaveBeenCalled();
  });

  it('gives explicit failures priority over processed or queued acknowledgements', async () => {
    const { actions, get, bulkAction } = await loadSlice({ emails: [row('e1'), row('e2')] });
    bulkAction.mockResolvedValueOnce({ success: true, data: { processedIds: ['e1', 'e2'], failedIds: ['e2'], queuedIds: ['e2'] } });
    await actions.bulkRemoveEmails(['e1', 'e2'], 'delete');
    expect(ids(get().emails)).toEqual(['e2']);
  });

  it('preserves fresh selected row flags received while confirmation is open', async () => {
    const confirmation = deferred<boolean>();
    confirm.mockReturnValueOnce(confirmation.promise);
    const original = Array.from({ length: 20 }, (_, index) => row(`e${index}`));
    const { actions, get, set, bulkAction } = await loadSlice({ emails: original });
    bulkAction.mockResolvedValueOnce({ success: false });
    const removing = actions.bulkRemoveEmails(ids(original), 'delete');
    const fresh = row('e0', 'account-a', { tags: '|INBOX|read|' });
    set({ emails: [fresh, ...original.slice(1)] });
    confirmation.resolve(true);
    await removing;
    expect(get().emails[0]).toBe(fresh);
  });
});

describe('bulkRemoveEmails rollback respects navigation and sections', () => {
  it('does not remove the new view if navigation occurs during confirmation', async () => {
    const confirmation = deferred<boolean>();
    confirm.mockReturnValueOnce(confirmation.promise);
    const original = Array.from({ length: 20 }, (_, index) => row(`e${index}`, 'account-b'));
    const { actions, get, set, bulkAction } = await loadSlice({ emails: original });
    const removing = actions.bulkRemoveEmails(ids(original), 'delete');
    const newView = [row('e0', 'account-b'), row('other-message')];
    set({ selectedVirtualFolder: null, selectedFolderId: 'different-folder', emails: newView });
    confirmation.resolve(true);
    await removing;
    expect(bulkAction).toHaveBeenCalledWith(ids(original), 'delete', 'account-b', false);
    expect(get().emails).toBe(newView);
    expect(get().goToEmailPage).not.toHaveBeenCalled();
  });

  it('does not inject a failed selection into a different page or conversation', async () => {
    const pending = deferred<BulkResponse>();
    const { actions, get, set, bulkAction } = await loadSlice({ emails: [row('e1')], threadEmails: [row('e1')], selectedEmailId: 'e1' });
    bulkAction.mockReturnValueOnce(pending.promise);
    const removing = actions.bulkRemoveEmails(['e1'], 'delete');
    const newPage = [row('new-page')];
    const newThread = [row('other-thread')];
    set({ emailsPage: 1, emails: newPage, threadEmails: newThread, selectedEmailId: 'other-thread' });
    pending.resolve({ success: false });
    await removing;
    expect(get().emails).toBe(newPage);
    expect(get().threadEmails).toBe(newThread);
    expect(get().selectedEmailId).toBe('other-thread');
    expect(get().goToEmailPage).not.toHaveBeenCalled();
  });

  it('restores a failed section row without replacing updated counts or other rows', async () => {
    const pending = deferred<BulkResponse>();
    const original = [row('e1'), row('keep')];
    const section = { emails: original, threads: [], offset: 2, hasMore: true, total: 12, loading: false, page: 0 };
    const { actions, get, set, bulkAction } = await loadSlice({ emails: [], sectionData: { primary: section } });
    bulkAction.mockReturnValueOnce(pending.promise);
    const removing = actions.bulkRemoveEmails(['e1'], 'delete');
    expect(bulkAction).toHaveBeenCalledWith(['e1'], 'delete', 'account-a', false);
    const freshKeep = row('keep', 'account-a', { tags: '|INBOX|starred|' });
    set({ sectionData: { primary: { ...section, emails: [row('new-arrival'), freshKeep], total: 14 } } });
    pending.resolve({ success: false });
    await removing;
    expect(ids(get().sectionData.primary.emails)).toEqual(['new-arrival', 'e1', 'keep']);
    expect(get().sectionData.primary.emails.find((email: any) => email.id === 'keep')).toBe(freshKeep);
    expect(get().sectionData.primary.total).toBe(14);
  });

  it('undoes its section count decrement when the section has not refreshed', async () => {
    const original = [row('e1'), row('keep')];
    const section = { emails: original, threads: [], offset: 2, hasMore: false, total: 2, loading: false };
    const { actions, get, bulkAction } = await loadSlice({ emails: [], sectionData: { primary: section } });
    bulkAction.mockResolvedValueOnce({ success: false });
    await actions.bulkRemoveEmails(['e1'], 'delete');
    expect(ids(get().sectionData.primary.emails)).toEqual(['e1', 'keep']);
    expect(get().sectionData.primary.total).toBe(2);
  });

  it('refills and clamps the original Promotions page after all selected rows are accepted', async () => {
    const { actions, get, set } = await loadSlice({ emails: [row('e1')], viewingAICategory: 'promotions', emailsPage: 1 });
    get().goToEmailPage.mockImplementation(async (page: number) => {
      if (page === 0) set({ emails: [row('next-promotion')], emailsPage: 0 });
    });
    await actions.bulkRemoveEmails(['e1'], 'delete');
    expect(get().goToEmailPage).toHaveBeenNthCalledWith(1, 1);
    expect(get().goToEmailPage).toHaveBeenNthCalledWith(2, 0);
    expect(get().viewingAICategory).toBe('promotions');
    expect(ids(get().emails)).toEqual(['next-promotion']);
  });
});

describe('bulkRemoveEmails page refill through the real pager', () => {
  const categoryViews = ['important', 'needs_response', 'reminders', 'meetings', 'invoices', 'finance', 'promotions', 'social']
    .map((category) => ({ label: category, view: { viewingAICategory: category } }));
  const otherViews = [
    { label: 'unified category', view: { viewingAICategory: 'promotions', selectedFolderId: null, selectedVirtualFolder: 'virtual-unified' } },
    { label: 'All Inboxes', view: { selectedFolderId: null, selectedVirtualFolder: 'virtual-unified' } },
    { label: 'All Email', view: { selectedFolderId: null, selectedVirtualFolder: 'virtual-all' } },
    { label: 'Inbox', view: {} },
    { label: 'Sent', view: { selectedFolderId: 'sent' } },
    { label: 'Important virtual folder', view: { selectedFolderId: null, selectedVirtualFolder: 'virtual-important' } },
    { label: 'Starred', view: { selectedFolderId: null, selectedVirtualFolder: 'virtual-starred' } },
    { label: 'Snoozed', view: { selectedFolderId: null, viewingSnoozed: true } },
    { label: 'full section', view: { viewingSection: 'important' } },
  ];

  it.each([...categoryViews, ...otherViews])('loads the next page window after deleting every visible row in $label', async ({ view }) => {
    const { get, original, pageSize, pageFetch } = await loadPagedSlices(view);
    expect(ids(get().emails)).toEqual(ids(original.slice(0, pageSize)));

    await get().bulkRemoveEmails(ids(get().emails), 'delete');

    expect(ids(get().emails)).toEqual(ids(original.slice(pageSize, pageSize * 2)));
    expect(get().emailsPage).toBe(0);
    expect(get().emailsTotal).toBe(pageSize + 3);
    expect(get().hasMoreEmails).toBe(true);
    expect(pageFetch).toHaveBeenLastCalledWith(pageSize, 0);
  });

  it('waits for a pre-delete page request to finish before refilling', async () => {
    const { get, original, pageSize, pageFetch } = await loadPagedSlices({ viewingAICategory: 'promotions' });
    const stalePage = deferred<{ success: boolean; data: any[] }>();
    pageFetch.mockReturnValueOnce(stalePage.promise);
    const refreshing = get().goToEmailPage(0);
    expect(get().loadingMoreEmails).toBe(true);
    let finished = false;
    const removing = get().bulkRemoveEmails(ids(original.slice(0, pageSize)), 'delete').then(() => { finished = true; });
    await vi.waitFor(() => expect(get().loadFolders).toHaveBeenCalled());

    expect(finished).toBe(false);
    expect(pageFetch).toHaveBeenCalledTimes(2);
    stalePage.resolve({ success: true, data: original.slice(0, pageSize) });
    await Promise.all([refreshing, removing]);

    expect(ids(get().emails)).toEqual(ids(original.slice(pageSize, pageSize * 2)));
    expect(pageFetch).toHaveBeenCalledTimes(3);
    expect(get().loadingMoreEmails).toBe(false);
  });

  it.each([
    { label: 'category', view: { viewingAICategory: 'promotions' } },
    ...otherViews,
  ])('preserves a new tab when leaving $label while awaiting a page request', async ({ view }) => {
    const { get, set, original, pageSize, pageFetch } = await loadPagedSlices(view);
    const stalePage = deferred<{ success: boolean; data: any[] }>();
    pageFetch.mockReturnValueOnce(stalePage.promise);
    const refreshing = get().goToEmailPage(0);
    const removing = get().bulkRemoveEmails(ids(original.slice(0, pageSize)), 'delete');
    await vi.waitFor(() => expect(get().loadFolders).toHaveBeenCalled());

    const socialRows = [row('social-arrival')];
    set({ viewingAICategory: 'social', selectedVirtualFolder: null, viewingSection: null, viewingSnoozed: false, emails: socialRows, emailsTotal: 1 });
    await removing;
    stalePage.resolve({ success: true, data: original.slice(0, pageSize) });
    await refreshing;

    expect(get().viewingAICategory).toBe('social');
    expect(get().emails).toBe(socialRows);
    expect(pageFetch).toHaveBeenCalledTimes(2);
  });

  it('still refills when a badge-count refresh fails', async () => {
    const { get, original, pageSize } = await loadPagedSlices({ viewingAICategory: 'finance' });
    get().refreshCategoryCounts.mockRejectedValueOnce(new Error('count unavailable'));
    await get().bulkRemoveEmails(ids(get().emails), 'delete');
    expect(ids(get().emails)).toEqual(ids(original.slice(pageSize, pageSize * 2)));
  });

  it('refills an accepted mailbox deletion while unread-summary refresh remains pending', async () => {
    const { get, original, pageSize } = await loadPagedSlices();
    const summary = deferred<void>();
    get().refreshUnreadSummary.mockReturnValueOnce(summary.promise);
    let finished = false;
    const removing = get().bulkRemoveEmails(ids(get().emails), 'delete').then(() => { finished = true; });
    try {
      await vi.waitFor(() => {
        expect(ids(get().emails)).toEqual(ids(original.slice(pageSize, pageSize * 2)));
        expect(finished).toBe(true);
      });
      expect(get().refreshUnreadSummary).toHaveBeenCalledOnce();
    } finally {
      summary.resolve();
      await removing;
    }
  });

  it('refills a category despite orphan search-loading flags when no search is active', async () => {
    const { get, set, original, pageSize } = await loadPagedSlices({ viewingAICategory: 'promotions' });
    set({ searching: true, searchingServer: true });
    const removing = get().bulkRemoveEmails(ids(get().emails), 'delete');
    try {
      await vi.waitFor(() => expect(ids(get().emails)).toEqual(ids(original.slice(pageSize, pageSize * 2))));
      expect(get().searchQuery).toBe('');
    } finally {
      set({ searching: false, searchingServer: false });
      await removing;
    }
  });
});

describe('bulkRemoveEmails local progress before the server response', () => {
  it.each([
    { label: 'category', view: { viewingAICategory: 'promotions' } },
    { label: 'Inbox', view: {} },
    { label: 'All Inboxes', view: { selectedFolderId: null, selectedVirtualFolder: 'virtual-unified' } },
  ])('refills $label from local progress while the final response is still pending', async ({ view }) => {
    const { get, original, pageSize, pageFetch, bulkAction, removeLocally, emitProgress, onBulkActionProgress, progressListeners } = await loadPagedSlices(view, { withProgress: true });
    const response = deferred<BulkResponse>();
    const removed = ids(original.slice(0, pageSize));
    bulkAction.mockImplementationOnce(async (selected) => { removeLocally(selected); return response.promise; });
    let finished = false;
    const removing = get().bulkRemoveEmails(removed, 'delete').then(() => { finished = true; });
    await vi.waitFor(() => expect(bulkAction).toHaveBeenCalledOnce());
    const requestId = bulkAction.mock.calls[0][4] as string;
    expect(requestId).toEqual(expect.any(String));
    expect(requestId.length).toBeGreaterThan(0);
    expect(onBulkActionProgress).toHaveBeenCalledOnce();

    emitProgress({ requestId: `other-${requestId}`, action: 'delete', accountId: 'account-a', emailIds: removed });
    emitProgress({ requestId, action: 'delete', accountId: 'account-a', emailIds: ['unselected-message'] });
    await Promise.resolve();
    await Promise.resolve();
    expect(pageFetch).toHaveBeenCalledTimes(1);
    emitProgress({ requestId, action: 'delete', accountId: 'account-a', emailIds: removed });
    await vi.waitFor(() => expect(ids(get().emails)).toEqual(ids(original.slice(pageSize, pageSize * 2))));
    expect(finished).toBe(false);
    expect(progressListeners.size).toBe(1);

    response.resolve({ success: true, data: { processedIds: removed, failedIds: [] } });
    await removing;
    expect(ids(get().emails)).toEqual(ids(original.slice(pageSize, pageSize * 2)));
    expect(get().emailsTotal).toBe(pageSize + 3);
    expect(progressListeners.size).toBe(0);
    expect(onBulkActionProgress.mock.results[0].value).toHaveBeenCalledOnce();
  });

  it('preserves navigation while a progress-triggered refill waits for an older read', async () => {
    const { get, set, original, pageSize, pageFetch, bulkAction, removeLocally, emitProgress, progressListeners } = await loadPagedSlices({ viewingAICategory: 'promotions' }, { withProgress: true });
    const staleRead = deferred<{ success: boolean; data: any[] }>();
    pageFetch.mockReturnValueOnce(staleRead.promise);
    const refreshing = get().goToEmailPage(0);
    const response = deferred<BulkResponse>();
    const removed = ids(original.slice(0, pageSize));
    bulkAction.mockImplementationOnce(async (selected) => { removeLocally(selected); return response.promise; });
    const removing = get().bulkRemoveEmails(removed, 'delete');
    await vi.waitFor(() => expect(bulkAction).toHaveBeenCalledOnce());
    const requestId = bulkAction.mock.calls[0][4] as string;
    emitProgress({ requestId, action: 'delete', accountId: 'account-a', emailIds: removed });
    await Promise.resolve();
    const socialRows = [row('social-result')];
    set({ viewingAICategory: 'social', emails: socialRows });
    response.resolve({ success: true, data: { processedIds: removed, failedIds: [] } });
    await removing;
    staleRead.resolve({ success: true, data: original.slice(0, pageSize) });
    await refreshing;

    expect(get().emails).toBe(socialRows);
    expect(get().viewingAICategory).toBe('social');
    expect(pageFetch).toHaveBeenCalledTimes(2);
    expect(progressListeners.size).toBe(0);
  });

  it('restores a failed row and keeps one page after the backend rolls back local progress', async () => {
    const { get, original, pageSize, bulkAction, removeLocally, restoreLocally, emitProgress, onBulkActionProgress } = await loadPagedSlices({ viewingAICategory: 'promotions' }, { withProgress: true });
    const response = deferred<BulkResponse>();
    const removed = ids(original.slice(0, pageSize));
    bulkAction.mockImplementationOnce(async (selected) => { removeLocally(selected); return response.promise; });
    const removing = get().bulkRemoveEmails(removed, 'delete');
    await vi.waitFor(() => expect(bulkAction).toHaveBeenCalledOnce());
    const requestId = bulkAction.mock.calls[0][4] as string;
    emitProgress({ requestId, action: 'delete', accountId: 'account-a', emailIds: removed });
    await vi.waitFor(() => expect(ids(get().emails)).toEqual(ids(original.slice(pageSize, pageSize * 2))));

    restoreLocally(['e0']);
    response.resolve({ success: false, data: { processedIds: removed.slice(1), failedIds: ['e0'] } });
    await removing;

    expect(ids(get().emails)).toEqual(['e0', ...ids(original.slice(pageSize, pageSize * 2 - 1))]);
    expect(get().emails).toHaveLength(pageSize);
    expect(get().emailsTotal).toBe(pageSize + 4);
    expect((globalThis as any).window.alert).toHaveBeenCalledWith('Could not delete 1 message. Check your connection and try again.');
    expect(onBulkActionProgress.mock.results[0].value).toHaveBeenCalledOnce();
  });

  it('refetches the original page after every locally moved row is rolled back', async () => {
    const { get, original, pageSize, bulkAction, removeLocally, restoreLocally, emitProgress, progressListeners } = await loadPagedSlices({ viewingAICategory: 'promotions' }, { withProgress: true });
    const response = deferred<BulkResponse>();
    const removed = ids(original.slice(0, pageSize));
    bulkAction.mockImplementationOnce(async (selected) => { removeLocally(selected); return response.promise; });
    const removing = get().bulkRemoveEmails(removed, 'delete');
    await vi.waitFor(() => expect(bulkAction).toHaveBeenCalledOnce());
    const requestId = bulkAction.mock.calls[0][4] as string;
    emitProgress({ requestId, action: 'delete', accountId: 'account-a', emailIds: removed });
    await vi.waitFor(() => expect(ids(get().emails)).toEqual(ids(original.slice(pageSize, pageSize * 2))));

    restoreLocally(removed);
    response.resolve({ success: false, data: { processedIds: [], failedIds: removed } });
    await removing;

    expect(ids(get().emails)).toEqual(removed);
    expect(get().emails).toHaveLength(pageSize);
    expect(get().emailsTotal).toBe(original.length);
    expect(progressListeners.size).toBe(0);
  });

  it.each(['accepted', 'failed'])('keeps a second pending deletion hidden during the first final refill, then handles its %s response', async (outcome) => {
    const { get, original, pageSize, bulkAction, removeLocally, emitProgress, progressListeners, onBulkActionProgress } = await loadPagedSlices({ viewingAICategory: 'promotions' }, { withProgress: true });
    const firstResponse = deferred<BulkResponse>();
    const secondResponse = deferred<BulkResponse>();
    const firstIds = ids(original.slice(0, pageSize));
    const secondIds = ids(original.slice(pageSize, pageSize * 2));
    bulkAction
      .mockImplementationOnce(async (selected) => { removeLocally(selected); return firstResponse.promise; })
      // The second request is waiting before its local mutation/progress event.
      .mockImplementationOnce(async () => secondResponse.promise);
    const firstRemoval = get().bulkRemoveEmails(firstIds, 'delete');
    await vi.waitFor(() => expect(bulkAction).toHaveBeenCalledOnce());
    const firstRequestId = bulkAction.mock.calls[0][4] as string;
    emitProgress({ requestId: firstRequestId, action: 'delete', accountId: 'account-a', emailIds: firstIds });
    await vi.waitFor(() => expect(ids(get().emails)).toEqual(secondIds));

    const secondRemoval = get().bulkRemoveEmails(secondIds, 'delete');
    await vi.waitFor(() => expect(bulkAction).toHaveBeenCalledTimes(2));
    expect(get().emails).toEqual([]);
    const secondRequestId = bulkAction.mock.calls[1][4] as string;
    firstResponse.resolve({ success: true, data: { processedIds: firstIds, failedIds: [] } });
    await firstRemoval;

    // The backend still returns the second batch here. Its ongoing optimistic
    // deletion must survive a final page read belonging to the first batch.
    expect(get().emails.some((email: any) => secondIds.includes(email.id))).toBe(false);
    expect(progressListeners.size).toBe(1);

    if (outcome === 'accepted') {
      removeLocally(secondIds);
      emitProgress({ requestId: secondRequestId, action: 'delete', accountId: 'account-a', emailIds: secondIds });
      await vi.waitFor(() => expect(ids(get().emails)).toEqual(ids(original.slice(pageSize * 2))));
      secondResponse.resolve({ success: true, data: { processedIds: secondIds, failedIds: [] } });
      await secondRemoval;
      expect(ids(get().emails)).toEqual(ids(original.slice(pageSize * 2)));
      expect(get().emailsTotal).toBe(3);
    } else {
      secondResponse.resolve({ success: false, data: { processedIds: [], failedIds: secondIds } });
      await secondRemoval;
      expect(ids(get().emails)).toEqual(secondIds);
      expect(get().emailsTotal).toBe(pageSize + 3);
    }
    expect(progressListeners.size).toBe(0);
    expect(onBulkActionProgress.mock.results[0].value).toHaveBeenCalledOnce();
    expect(onBulkActionProgress.mock.results[1].value).toHaveBeenCalledOnce();
  });
});

describe('bulkRemoveEmails section and search refill', () => {
  it('releases a stale section page request without replacing a newly opened full-section view', async () => {
    const { get, set, original, pageSize, pageFetch } = await loadPagedSlices();
    set({ inboxType: 'important_first', inboxSections: [{ id: 'primary', filter: 'important', maxItems: 25 }] });
    await get().loadSectionEmails('primary', 'important', 'INBOX');
    const originalSectionRows = get().sectionData.primary.emails;
    const stalePage = deferred<{ success: boolean; data: any[] }>();
    pageFetch.mockReturnValueOnce(stalePage.promise);
    const paging = get().goToSectionPage('primary', 'important', 1, 'INBOX');
    expect(get().sectionData.primary.loading).toBe(true);

    const fullSectionRows = [row('full-section-result')];
    set({ viewingSection: 'important', emails: fullSectionRows });
    stalePage.resolve({ success: true, data: original.slice(pageSize, pageSize * 2) });
    await paging;

    expect(get().sectionData.primary.loading).toBe(false);
    expect(get().sectionData.primary.emails).toBe(originalSectionRows);
    expect(get().emails).toBe(fullSectionRows);
  });

  it('keeps the refilled section rows when an older background section reload finishes last', async () => {
    const { get, set, original, pageSize, pageFetch } = await loadPagedSlices();
    set({ inboxType: 'important_first', inboxSections: [{ id: 'primary', filter: 'important', maxItems: 25 }] });
    await get().loadSectionEmails('primary', 'important', 'INBOX');
    const staleSections = deferred<{ success: boolean; data: any[] }>();
    pageFetch.mockReturnValueOnce(staleSections.promise);
    const refreshing = get().loadAllSections('INBOX');
    // Existing-data background reloads have no spinner for the action to await.
    expect(get().loadingEmails).toBe(false);
    expect(get().sectionData.primary.loading).toBe(false);
    expect(get().sectionLoading.size).toBe(0);

    await get().bulkRemoveEmails(ids(original.slice(0, pageSize)), 'delete');
    const nextRows = ids(original.slice(pageSize, pageSize * 2));
    expect(ids(get().sectionData.primary.emails)).toEqual(nextRows);
    staleSections.resolve({ success: true, data: original.slice(0, pageSize) });
    await refreshing;

    expect(ids(get().sectionData.primary.emails)).toEqual(nextRows);
    expect(ids(get().emails)).toEqual(nextRows);
    expect(get().sectionData.primary.total).toBe(pageSize + 3);
  });

  it('reloads a section preview after deleting its visible rows', async () => {
    const original = Array.from({ length: 25 }, (_, index) => row(`e${index}`));
    const section = { emails: original, threads: [], offset: 25, hasMore: true, total: 51, loading: false, page: 0 };
    const { actions, get, set } = await loadSlice({
      emails: original, selectedVirtualFolder: null, selectedFolderId: 'inbox', inboxType: 'important_first',
      inboxSections: [{ id: 'primary', filter: 'important', maxItems: 25 }], sectionData: { primary: section },
    });
    const next = [row('next-important')];
    get().loadSectionEmails.mockImplementation(async () => set({ sectionData: { primary: { ...section, emails: next, total: 26 } }, emails: next }));

    await actions.bulkRemoveEmails(ids(original), 'delete');

    expect(get().loadSectionEmails).toHaveBeenCalledWith('primary', 'important', 'INBOX');
    expect(ids(get().sectionData.primary.emails)).toEqual(['next-important']);
    expect(get().goToEmailPage).not.toHaveBeenCalled();
  });

  it('waits for a loading section before refilling its preview', async () => {
    const section = { emails: [row('e1')], threads: [], offset: 1, hasMore: true, total: 30, loading: true, page: 0 };
    const { actions, get, set } = await loadSlice({
      selectedVirtualFolder: null, selectedFolderId: 'inbox', inboxType: 'important_first',
      inboxSections: [{ id: 'primary', filter: 'important', maxItems: 25 }], sectionData: { primary: section },
      sectionLoading: new Set(['primary']),
    });
    const removing = actions.bulkRemoveEmails(['e1'], 'delete');
    await vi.waitFor(() => expect(get().refreshUnreadSummary).toHaveBeenCalled());
    expect(get().loadSectionEmails).not.toHaveBeenCalled();

    set({ sectionLoading: new Set(), sectionData: { primary: { ...section, loading: false } } });
    await removing;
    expect(get().loadSectionEmails).toHaveBeenCalledWith('primary', 'important', 'INBOX');
  });

  it('refills the active search page while preserving the query', async () => {
    const { actions, get, set } = await loadSlice({ emails: [], searchResults: [row('e1')], searchQuery: 'receipt', searchPage: 1, searchTotal: 50 });
    get().goToSearchPage.mockImplementation(async (page: number) => set({ searchResults: [row('next-result')], searchPage: page, searchTotal: 49 }));
    await actions.bulkRemoveEmails(['e1'], 'delete');
    expect(get().goToSearchPage).toHaveBeenCalledWith(1);
    expect(get().searchQuery).toBe('receipt');
    expect(ids(get().searchResults)).toEqual(['next-result']);
    expect(get().goToEmailPage).not.toHaveBeenCalled();
  });

  it('returns an empty later search page to its first page', async () => {
    const { actions, get, set } = await loadSlice({ emails: [], searchResults: [row('e1')], searchQuery: 'receipt', searchPage: 1 });
    get().goToSearchPage.mockImplementation(async (page: number) => set({ searchResults: page === 0 ? [row('first-result')] : [], searchPage: page }));
    await actions.bulkRemoveEmails(['e1'], 'delete');
    expect(get().goToSearchPage).toHaveBeenNthCalledWith(1, 1);
    expect(get().goToSearchPage).toHaveBeenNthCalledWith(2, 0);
    expect(ids(get().searchResults)).toEqual(['first-result']);
  });

  it('does not refill the original search after the user changes search pages', async () => {
    const { actions, get, set } = await loadSlice({ emails: [], searchResults: [row('e1')], searchQuery: 'receipt', searchPage: 0, searching: true });
    const removing = actions.bulkRemoveEmails(['e1'], 'delete');
    await vi.waitFor(() => expect(get().refreshUnreadSummary).toHaveBeenCalled());
    const newPage = [row('next-search-page')];
    set({ searchPage: 1, searchResults: newPage });
    await removing;
    expect(get().searchResults).toBe(newPage);
    expect(get().goToSearchPage).not.toHaveBeenCalled();
  });
});
