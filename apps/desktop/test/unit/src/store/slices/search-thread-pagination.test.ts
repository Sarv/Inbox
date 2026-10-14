import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(), applyEmailCategories: vi.fn(),
  getCachedCategorySlugs: vi.fn(() => []), warmCategoryDefs: vi.fn(),
}));
vi.mock('../../../../../src/services/ai-service', () => ({
  isAISearchEnabled: () => false, getDefaultProvider: () => null,
  parseSearchQuery: async (query: string) => ({ query: query === 'budget' ? { textQuery: 'budget' } : { isUnread: true }, interpretation: query }),
  isSignatureDetectionEnabled: () => false, detectSignature: vi.fn(), getAIHealth: vi.fn(),
  reportAIHealthy: vi.fn(), reportAIUnhealthy: vi.fn(), syncAIProviderToMain: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness({ unified = false, knownTotal = true, threads = 31, extraMessages = 2, extraThread = 0 } = {}) {
  vi.resetModules();
  const messages = [
    ...Array.from({ length: threads }, (_, index) => ({
      id: `e${index}`, threadId: `t${index}`, accountId: 'account-a', date: 1_000 - index, tags: '|INBOX|finance|',
    })),
    ...Array.from({ length: extraMessages }, (_, index) => ({
      id: `extra-${index}`, threadId: `t${extraThread}`, accountId: 'account-a', date: 1_000 - extraThread, tags: '|INBOX|finance|',
    })),
  ];
  // The API pages conversations and returns every MATCHING member of the chosen
  // conversations. A raw-array-length pagination check is therefore incorrect.
  const page = (limit: number, offset: number) => {
    const keys = new Set([...new Set(messages.map((row) => row.threadId))].slice(offset, offset + limit));
    return messages.filter((row) => keys.has(row.threadId));
  };
  const search = vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => ({ success: true, data: page(limit, offset) }));
  const searchCount = vi.fn(async () => {
    if (!knownTotal) throw new Error('Count unavailable');
    return { success: true, data: threads };
  });
  const unifiedSearch = vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => ({
    success: true, data: page(limit, offset), ...(knownTotal ? { total: threads } : {}),
  }));
  const unifiedInbox = vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => ({
    success: true, data: { emails: page(limit, offset), total: knownTotal ? threads : 0, hasMore: offset + limit < threads },
  }));
  const getByCategory = vi.fn(async (_category: string, limit: number, offset: number) => ({ success: true, data: page(limit, offset) }));
  const serverSearch = vi.fn(async () => ({ success: true, data: { skipped: false, matched: 0, inserted: 0 } }));
  vi.stubGlobal('window', {
    electronAPI: {
      ai: { search, searchCount, getByCategory, getCategoryCounts: async () => ({ success: true, data: { finance: knownTotal ? threads : 0 } }) },
      accounts: { unifiedSearch, unifiedInbox },
      emails: { searchServer: serverSearch },
    },
  });
  const [{ createStore }, { createSearchAISlice }, { threadRowCount }] = await Promise.all([
    import('zustand/vanilla'),
    import('../../../../../src/store/slices/search-ai-slice'),
    import('../../../../../src/utils/thread-utils'),
  ]);
  const store = createStore<any>((set, get, api) => ({
    ...createSearchAISlice(set, get, api),
    activeAccountId: 'account-a', accounts: [{ id: 'account-a' }],
    folders: [{ id: 'inbox', path: 'INBOX' }], selectedFolderId: unified ? null : 'inbox',
    selectedVirtualFolder: unified ? 'virtual-unified' : null,
    inboxType: 'default', inboxSections: [], emails: [], emailsPage: 0, emailsTotal: 0,
    selectedEmailId: null, sectionData: {}, viewingSnoozed: false,
  }));
  return { get: store.getState, set: store.setState, messages, search, searchCount, serverSearch, unifiedSearch, unifiedInbox, threadRowCount };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('search pages use matching conversations', () => {
  it('pages 33 matching messages as 25 plus 6 distinct conversations', async () => {
    const { get, messages, search, threadRowCount } = await harness();
    expect(messages).toHaveLength(33);
    await get().search('is:unread');
    expect(get().searchResults).toHaveLength(27);
    expect(threadRowCount(get().searchResults)).toBe(25);
    expect(get()).toMatchObject({ searchPage: 0, searchTotal: 31, searchHasMore: true });

    await get().goToSearchPage(1);

    expect(threadRowCount(get().searchResults)).toBe(6);
    expect(get()).toMatchObject({ searchPage: 1, searchTotal: 31, searchHasMore: false });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 25, offset: 25 }));
  });

  it('does not infer another page from 31 messages belonging to six final-page conversations', async () => {
    const { get, threadRowCount } = await harness({ knownTotal: false, extraMessages: 25, extraThread: 30 });
    await get().search('is:unread');
    await get().goToSearchPage(1);

    expect(get().searchResults).toHaveLength(31);
    expect(threadRowCount(get().searchResults)).toBe(6);
    expect(get()).toMatchObject({ searchTotal: 0, searchHasMore: false });
  });

  it('disables another page when the count confirms exactly 25 matching conversations', async () => {
    const { get, threadRowCount } = await harness({ threads: 25 });
    await get().search('is:unread');
    expect(get().searchResults).toHaveLength(27);
    expect(threadRowCount(get().searchResults)).toBe(25);
    expect(get()).toMatchObject({ searchTotal: 25, searchHasMore: false });
  });

  it('uses the exact unified free-text conversation total while preserving array results', async () => {
    const { get, unifiedSearch, searchCount, threadRowCount } = await harness({ unified: true });
    await get().search('budget');
    expect(get().searchTotal).toBe(31);
    expect(threadRowCount(get().searchResults)).toBe(25);
    await get().goToSearchPage(1);

    expect(get()).toMatchObject({ searchPage: 1, searchTotal: 31, searchHasMore: false });
    expect(threadRowCount(get().searchResults)).toBe(6);
    expect(unifiedSearch).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 25, offset: 25 }));
    expect(searchCount).not.toHaveBeenCalled();
  });

  it('uses the exact unified filter conversation total', async () => {
    const { get, unifiedInbox, threadRowCount } = await harness({ unified: true });
    await get().search('is:unread');
    expect(get().searchTotal).toBe(31);
    await get().goToSearchPage(1);

    expect(threadRowCount(get().searchResults)).toBe(6);
    expect(get()).toMatchObject({ searchTotal: 31, searchHasMore: false });
    expect(unifiedInbox).toHaveBeenLastCalledWith(expect.objectContaining({ filter: expect.objectContaining({ isUnread: true }), limit: 25, offset: 25 }));
  });

  it('keeps unified free-text fallback hasMore in conversation units when the total is omitted', async () => {
    const { get, threadRowCount } = await harness({ unified: true, knownTotal: false, extraMessages: 25, extraThread: 30 });
    await get().search('budget');
    await get().goToSearchPage(1);
    expect(get().searchResults).toHaveLength(31);
    expect(threadRowCount(get().searchResults)).toBe(6);
    expect(get().searchHasMore).toBe(false);
  });

  it('uses conversation count for an initial category page when its count query is unavailable', async () => {
    const { get, threadRowCount } = await harness({ threads: 6, extraMessages: 27, knownTotal: false });
    await get().loadAICategoryEmails('finance');
    expect(get().emails).toHaveLength(33);
    expect(threadRowCount(get().emails)).toBe(6);
    expect(get()).toMatchObject({ emailsTotal: 0, hasMoreEmails: false, viewingAICategory: 'finance' });
  });

  it('uses unified category totals even without an active quick filter', async () => {
    const { get, threadRowCount } = await harness({ unified: true });
    await get().loadAICategoryEmails('finance');
    expect(threadRowCount(get().emails)).toBe(25);
    expect(get()).toMatchObject({ emailsTotal: 31, hasMoreEmails: true });
  });

  it('does not let an old server search change the same query in a newer category', async () => {
    const { get, set, messages, search, searchCount, serverSearch } = await harness();
    const oldResponse = deferred<{ success: boolean; data: { skipped: boolean; matched: number; inserted: number } }>();
    const newResponse = deferred<{ success: boolean; data: { skipped: boolean; matched: number; inserted: number } }>();
    serverSearch.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    set({ viewingAICategory: 'promotions' });
    await get().search('budget', { folderId: 'inbox', aiCategory: 'promotions' });
    const oldSearch = get().searchServer();
    expect(serverSearch).toHaveBeenCalledOnce();

    const finance = messages.slice(0, 7).map((row) => ({ ...row, id: `finance-${row.id}` }));
    search.mockResolvedValueOnce({ success: true, data: finance });
    searchCount.mockResolvedValueOnce({ success: true, data: 7 });
    set({ viewingAICategory: 'finance' });
    const newSearch = get().search('budget', { folderId: 'inbox', aiCategory: 'finance' });
    await vi.waitFor(() => expect(serverSearch).toHaveBeenCalledTimes(2));
    expect(get()).toMatchObject({ searchTotal: 7, searchingServer: true });

    oldResponse.resolve({ success: true, data: { skipped: false, matched: 1, inserted: 1 } });
    await oldSearch;

    expect(get().searchResults).toBe(finance);
    expect(get()).toMatchObject({ viewingAICategory: 'finance', searchQuery: 'budget', searchTotal: 7, searchingServer: true });
    expect(searchCount).toHaveBeenCalledTimes(2);
    newResponse.resolve({ success: true, data: { skipped: false, matched: 7, inserted: 0 } });
    await newSearch;
    expect(get()).toMatchObject({ searchTotal: 7, searchingServer: false, serverSearchStatus: 'All server matches already downloaded' });
  });
});
