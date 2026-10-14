import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirm = vi.hoisted(() => vi.fn());
vi.mock('../../../../../src/store/confirm-service', () => ({ requestConfirm: confirm }));
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
  applyEmailCategories: vi.fn(),
  getCachedCategorySlugs: vi.fn(() => []),
  warmCategoryDefs: vi.fn(),
}));
vi.mock('../../../../../src/services/ai-service', () => ({
  isAISearchEnabled: () => false,
  getDefaultProvider: () => null,
  parseSearchQuery: async (query: string) => ({
    query: query === 'is:starred' ? { isFlagged: true } : { isUnread: true },
    interpretation: query,
  }),
  isSignatureDetectionEnabled: () => false,
  detectSignature: vi.fn(),
  getAIHealth: vi.fn(),
  reportAIHealthy: vi.fn(),
  reportAIUnhealthy: vi.fn(),
  syncAIProviderToMain: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type BulkResponse = {
  success: boolean;
  data: { processedIds: string[]; failedIds: string[]; queuedIds?: string[] };
};

const row = (id: string, extra: Record<string, any> = {}) => ({
  id, accountId: 'account-a', threadId: `thread-${id}`, date: 1_000,
  tags: extra.isUnread === false ? '|INBOX|read|' : '|INBOX|', isUnread: true, isFlagged: false, ...extra,
});
const ids = (rows: any[]) => rows.map((email) => email.id);

// Keep the real search pager and mutation actions together: the action
// invalidates the cached count and the pager must reload rows and their total.
async function loadSlices() {
  vi.resetModules();
  const unread = Array.from({ length: 53 }, (_, index) => row(`unread-${index}`));
  const starred = Array.from({ length: 31 }, (_, index) => row(`starred-${index}`, { isUnread: false, isFlagged: true }));
  let backend = [...unread, ...starred];
  const matches = (query: any) => backend.filter((email) =>
    (!query.isUnread || email.isUnread) && (!query.isFlagged || email.isFlagged));
  const searchPage = vi.fn(async (query: any) => ({
    success: true, data: matches(query).slice(query.offset, query.offset + query.limit),
  }));
  const searchCount = vi.fn(async (query: any) => ({ success: true, data: matches(query).length }));
  const persistRead = (changed: string[], read: boolean) => {
    const selected = new Set(changed);
    backend = backend.map((email) => selected.has(email.id) ? {
      ...email, isUnread: !read,
      tags: read ? '|INBOX|read|' : '|INBOX|',
    } : email);
  };
  const bulkAction = vi.fn(async (changed: string[], action: string): Promise<BulkResponse> => {
    if (action === 'markRead' || action === 'markUnread') persistRead(changed, action === 'markRead');
    else backend = backend.filter((email) => !changed.includes(email.id));
    return { success: true, data: { processedIds: changed, failedIds: [] } };
  });
  vi.stubGlobal('window', {
    alert: vi.fn(),
    electronAPI: { ai: { search: searchPage, searchCount }, emails: { bulkAction } },
  });
  const [{ createStore }, { createSearchAISlice }, { createEmailActionsSlice }] = await Promise.all([
    import('zustand/vanilla'),
    import('../../../../../src/store/slices/search-ai-slice'),
    import('../../../../../src/store/slices/email-actions-slice'),
  ]);
  const store = createStore<any>((set, get, api) => ({
    ...createSearchAISlice(set, get, api),
    ...createEmailActionsSlice(set, get, api),
    activeAccountId: 'account-a', accounts: [{ id: 'account-a' }],
    folders: [{ id: 'inbox', path: 'INBOX' }],
    selectedFolderId: 'inbox', selectedVirtualFolder: null,
    viewingSnoozed: false, inboxType: 'default', inboxSections: [],
    emails: [], threadEmails: [], sectionData: {}, sectionLoading: new Set(),
    emailsPage: 0, emailsTotal: 0, loadingEmails: false, loadingMoreEmails: false,
    selectedEmailId: null, highlightedEmailId: null, threadAccountId: null,
    loadFolders: vi.fn(async () => {}), refreshUnreadSummary: vi.fn(async () => {}),
    goToEmailPage: vi.fn(async () => {}),
  }));
  return { get: store.getState, set: store.setState, unread, starred, searchPage, searchCount, bulkAction, persistRead };
}

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true);
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('search pagination after bulk removal', () => {
  it('replaces all 25 deleted results with the next matches and refreshes the total', async () => {
    const { get, unread, searchPage, searchCount, bulkAction } = await loadSlices();
    await get().search('is:unread', { folderId: 'inbox', aiCategory: 'promotions', skipAI: true });
    expect(ids(get().searchResults)).toEqual(ids(unread.slice(0, 25)));
    expect(get().searchTotal).toBe(53);

    await get().bulkRemoveEmails(ids(get().searchResults), 'delete');

    expect(bulkAction).toHaveBeenCalledWith(ids(unread.slice(0, 25)), 'delete', 'account-a', false);
    expect(ids(get().searchResults)).toEqual(ids(unread.slice(25, 50)));
    expect(get()).toMatchObject({ searchPage: 0, searchTotal: 28, searchHasMore: true, searching: false });
    expect(searchPage).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 25, offset: 0, aiCategory: 'promotions' }));
    expect(searchCount).toHaveBeenCalledTimes(2);
    expect(searchCount).toHaveBeenLastCalledWith({ isUnread: true, folderId: 'inbox', aiCategory: 'promotions' });
  });

  it('reuses the known total when navigating ordinary search pages', async () => {
    const { get, unread, searchCount } = await loadSlices();
    await get().search('is:unread');

    await get().goToSearchPage(1);

    expect(ids(get().searchResults)).toEqual(ids(unread.slice(25, 50)));
    expect(get()).toMatchObject({ searchPage: 1, searchTotal: 53, searching: false });
    expect(searchCount).toHaveBeenCalledOnce();
  });

  it('returns to a populated first page when deleting the final search page', async () => {
    const { get, unread, searchCount } = await loadSlices();
    await get().search('is:unread');
    await get().goToSearchPage(2);
    expect(ids(get().searchResults)).toEqual(ids(unread.slice(50)));

    await get().bulkRemoveEmails(ids(get().searchResults), 'delete');

    expect(ids(get().searchResults)).toEqual(ids(unread.slice(0, 25)));
    expect(get()).toMatchObject({ searchPage: 0, searchTotal: 50, searchHasMore: true, searching: false });
    expect(searchCount).toHaveBeenCalledTimes(2);
  });

  it('does not let a pending recount overwrite a newer query or its results', async () => {
    const { get, set, starred, searchCount } = await loadSlices();
    await get().search('is:unread', { folderId: 'inbox', aiCategory: 'promotions' });
    const oldCount = deferred<{ success: boolean; data: number }>();
    searchCount.mockReturnValueOnce(oldCount.promise);
    set({ searchTotal: 0 });
    const oldPage = get().goToSearchPage(0);
    await vi.waitFor(() => expect(searchCount).toHaveBeenCalledTimes(2));

    await get().search('is:starred', { folderId: 'inbox', aiCategory: 'important' });
    oldCount.resolve({ success: true, data: 999 });
    await oldPage;

    expect(get()).toMatchObject({ searchQuery: 'is:starred', searchTotal: 31, searching: false });
    expect(ids(get().searchResults)).toEqual(ids(starred.slice(0, 25)));
    expect(searchCount.mock.calls[1][0]).toEqual({ isUnread: true, folderId: 'inbox', aiCategory: 'promotions' });
    expect(searchCount.mock.calls[2][0]).toEqual({ isFlagged: true, folderId: 'inbox', aiCategory: 'important' });
  });

  it('ignores pending refill rows after switching categories with the same query text', async () => {
    const { get, set, unread, searchPage, searchCount } = await loadSlices();
    set({ viewingAICategory: 'promotions' });
    await get().search('is:unread', { folderId: 'inbox', aiCategory: 'promotions' });
    const oldRows = deferred<{ success: boolean; data: any[] }>();
    searchPage.mockReturnValueOnce(oldRows.promise);
    set({ searchTotal: 0 });
    const oldRefill = get().goToSearchPage(0);
    await vi.waitFor(() => expect(searchPage).toHaveBeenCalledTimes(2));

    const financeRows = Array.from({ length: 7 }, (_, index) => row(`finance-${index}`));
    searchPage.mockResolvedValueOnce({ success: true, data: financeRows });
    searchCount.mockResolvedValueOnce({ success: true, data: financeRows.length });
    set({ viewingAICategory: 'finance' });
    await get().search('is:unread', { folderId: 'inbox', aiCategory: 'finance' });
    oldRows.resolve({ success: true, data: unread.slice(25, 50) });
    await oldRefill;

    expect(get()).toMatchObject({ searchQuery: 'is:unread', viewingAICategory: 'finance', searchTotal: 7, searching: false });
    expect(ids(get().searchResults)).toEqual(ids(financeRows));
    expect(searchCount).toHaveBeenCalledTimes(2);
    expect(searchPage).toHaveBeenLastCalledWith(expect.objectContaining({ aiCategory: 'finance' }));
  });

  it('ignores a pending recount after switching categories with the same query text', async () => {
    const { get, set, searchPage, searchCount } = await loadSlices();
    set({ viewingAICategory: 'promotions' });
    await get().search('is:unread', { folderId: 'inbox', aiCategory: 'promotions' });
    const oldCount = deferred<{ success: boolean; data: number }>();
    searchCount.mockReturnValueOnce(oldCount.promise);
    set({ searchTotal: 0 });
    const oldRefill = get().goToSearchPage(0);
    await vi.waitFor(() => expect(searchCount).toHaveBeenCalledTimes(2));

    const financeRows = Array.from({ length: 7 }, (_, index) => row(`finance-${index}`));
    searchPage.mockResolvedValueOnce({ success: true, data: financeRows });
    searchCount.mockResolvedValueOnce({ success: true, data: financeRows.length });
    set({ viewingAICategory: 'finance' });
    await get().search('is:unread', { folderId: 'inbox', aiCategory: 'finance' });
    oldCount.resolve({ success: true, data: 999 });
    await oldRefill;

    expect(get()).toMatchObject({ searchQuery: 'is:unread', viewingAICategory: 'finance', searchTotal: 7, searching: false });
    expect(ids(get().searchResults)).toEqual(ids(financeRows));
    expect(searchCount.mock.calls[1][0]).toEqual({ isUnread: true, folderId: 'inbox', aiCategory: 'promotions' });
    expect(searchCount.mock.calls[2][0]).toEqual({ isUnread: true, folderId: 'inbox', aiCategory: 'finance' });
  });

  it('keeps the cleared search empty when an old recount completes after navigation', async () => {
    const { get, set, searchCount } = await loadSlices();
    await get().search('is:unread');
    const oldCount = deferred<{ success: boolean; data: number }>();
    searchCount.mockReturnValueOnce(oldCount.promise);
    set({ searchTotal: 0 });
    const oldPage = get().goToSearchPage(0);
    await vi.waitFor(() => expect(searchCount).toHaveBeenCalledTimes(2));

    get().clearSearch();
    set({ selectedFolderId: 'other-folder' });
    oldCount.resolve({ success: true, data: 999 });
    await oldPage;

    expect(get()).toMatchObject({ searchQuery: '', searchResults: [], searchTotal: 0, searching: false, selectedFolderId: 'other-folder' });
  });

  it('clears the spinner immediately during a pending search read and permits normal-view removal', async () => {
    const { get, set, unread, searchPage, searchCount } = await loadSlices();
    const oldRows = deferred<{ success: boolean; data: any[] }>();
    searchPage.mockReturnValueOnce(oldRows.promise);
    const oldSearch = get().search('is:unread');
    await vi.waitFor(() => expect(searchPage).toHaveBeenCalledOnce());
    expect(get().searching).toBe(true);

    get().clearSearch();
    expect(get().searching).toBe(false);
    oldRows.resolve({ success: true, data: unread.slice(0, 25) });
    await oldSearch;
    expect(get()).toMatchObject({ searchQuery: '', searchResults: [], searchTotal: 0, searching: false });
    expect(searchCount).not.toHaveBeenCalled();

    set({ emails: [row('normal-email')] });
    await get().bulkRemoveEmails(['normal-email'], 'delete');
    expect(get().goToEmailPage).toHaveBeenCalledWith(0);
    expect(get().emails).toEqual([]);
  });

  it('clears the spinner when folder navigation empties the query during a pending recount', async () => {
    const { get, set, searchCount } = await loadSlices();
    await get().search('is:unread');
    const oldCount = deferred<{ success: boolean; data: number }>();
    searchCount.mockReturnValueOnce(oldCount.promise);
    set({ searchTotal: 0 });
    const oldRefill = get().goToSearchPage(0);
    await vi.waitFor(() => expect(searchCount).toHaveBeenCalledTimes(2));
    expect(get().searching).toBe(true);

    set({ selectedFolderId: 'other-folder', searchQuery: '', searchResults: [], searchTotal: 0 });
    oldCount.resolve({ success: true, data: 999 });
    await oldRefill;

    expect(get()).toMatchObject({ searchQuery: '', searchResults: [], searchTotal: 0, searching: false, selectedFolderId: 'other-folder' });
  });
});

describe('unread search pagination after bulk mark as read', () => {
  it('refills all 25 Finance results from the remaining unread matches and refreshes their total', async () => {
    const { get, set, unread, searchPage, searchCount, bulkAction } = await loadSlices();
    set({ viewingAICategory: 'finance' });
    await get().search('is:unread', { folderId: 'inbox', aiCategory: 'finance', skipAI: true });
    const selected = ids(get().searchResults);
    expect(selected).toEqual(ids(unread.slice(0, 25)));
    expect(get().searchTotal).toBe(53);

    get().bulkMarkRead(selected, true);
    await vi.waitFor(() => expect(get()).toMatchObject({ searchTotal: 28, searching: false }));

    expect(bulkAction).toHaveBeenCalledWith(selected, 'markRead', 'account-a', false);
    expect(ids(get().searchResults)).toEqual(ids(unread.slice(25, 50)));
    expect(get()).toMatchObject({ searchQuery: 'is:unread', viewingAICategory: 'finance', searchPage: 0, searchHasMore: true });
    expect(searchPage).toHaveBeenLastCalledWith(expect.objectContaining({ isUnread: true, limit: 25, offset: 0, aiCategory: 'finance' }));
    expect(searchCount).toHaveBeenCalledTimes(2);
    expect(searchCount).toHaveBeenLastCalledWith({ isUnread: true, folderId: 'inbox', aiCategory: 'finance' });
  });

  it('returns to the first unread page after marking the final page as read', async () => {
    const { get, set, unread } = await loadSlices();
    set({ viewingAICategory: 'finance' });
    await get().search('is:unread', { folderId: 'inbox', aiCategory: 'finance' });
    await get().goToSearchPage(2);
    expect(ids(get().searchResults)).toEqual(ids(unread.slice(50)));

    get().bulkMarkRead(ids(get().searchResults), true);
    await vi.waitFor(() => expect(get()).toMatchObject({ searchPage: 0, searchTotal: 50, searching: false }));

    expect(ids(get().searchResults)).toEqual(ids(unread.slice(0, 25)));
    expect(get().searchHasMore).toBe(true);
  });

  it('keeps a failed mark-read result unread while filling the other slots with remaining matches', async () => {
    const { get, set, unread, bulkAction, persistRead } = await loadSlices();
    set({ viewingAICategory: 'finance' });
    await get().search('is:unread', { folderId: 'inbox', aiCategory: 'finance' });
    const selected = ids(get().searchResults);
    bulkAction.mockImplementationOnce(async (changed) => {
      const processedIds = changed.filter((id) => id !== 'unread-0');
      persistRead(processedIds, true);
      return { success: false, data: { processedIds, failedIds: ['unread-0'] } };
    });

    get().bulkMarkRead(selected, true);
    await vi.waitFor(() => expect(get()).toMatchObject({ searchTotal: 29, searching: false }));

    expect(ids(get().searchResults)).toEqual(['unread-0', ...ids(unread.slice(25, 49))]);
    expect(get().searchResults[0].tags).not.toContain('|read|');
    expect(window.alert).toHaveBeenCalledWith('Could not mark as read 1 message. Check your connection and try again.');
  });

  it('does not refill the old Finance view after navigation while the read mutation is pending', async () => {
    const { get, set, searchPage, searchCount, bulkAction, persistRead } = await loadSlices();
    set({ viewingAICategory: 'finance' });
    await get().search('is:unread', { folderId: 'inbox', aiCategory: 'finance' });
    const selected = ids(get().searchResults);
    const pending = deferred<BulkResponse>();
    bulkAction.mockReturnValueOnce(pending.promise);
    get().bulkMarkRead(selected, true);

    const promotionRows = Array.from({ length: 7 }, (_, index) => row(`promotions-${index}`));
    searchPage.mockResolvedValueOnce({ success: true, data: promotionRows });
    searchCount.mockResolvedValueOnce({ success: true, data: promotionRows.length });
    set({ viewingAICategory: 'promotions' });
    await get().search('is:unread', { folderId: 'inbox', aiCategory: 'promotions' });
    persistRead(selected, true);
    pending.resolve({ success: true, data: { processedIds: selected, failedIds: [] } });
    await vi.waitFor(() => expect(get().loadFolders).toHaveBeenCalledOnce());

    expect(get()).toMatchObject({ viewingAICategory: 'promotions', searchQuery: 'is:unread', searchTotal: 7, searching: false });
    expect(ids(get().searchResults)).toEqual(ids(promotionRows));
    expect(searchPage).toHaveBeenCalledTimes(2);
    expect(searchCount).toHaveBeenCalledTimes(2);
  });
});
