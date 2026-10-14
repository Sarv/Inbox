import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { id: string; accountId: string; threadId: string; date: number; tags: string };
type BulkResponse = { success: boolean; data?: { processedIds: string[]; failedIds: string[] } };
type ViewFilter = { isUnread?: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const ids = (rows: Row[]) => rows.map((row) => row.id);
const isRead = (row: Row) => row.tags.includes('|read|');

// Both slices run unchanged against this backend. Only API arguments choose
// the query predicate, so a missing filter cannot be hidden by the fixture.
async function loadReadStore(view: Record<string, any> = {}, initialRead = false) {
  vi.resetModules();
  const [{ createStore }, { createEmailsSlice }, { createEmailActionsSlice }] = await Promise.all([
    import('zustand/vanilla'),
    import('../../../../../src/store/slices/emails-slice'),
    import('../../../../../src/store/slices/email-actions-slice'),
  ]);
  const original: Row[] = Array.from({ length: 68 }, (_, index) => ({
    id: `e${index}`, accountId: 'account-a', threadId: `thread-${index}`, date: 10_000 - index,
    tags: `|INBOX|important|${(index < 60 ? initialRead : !initialRead) ? 'read|' : ''}`,
  }));
  let backend = original.map((row) => ({ ...row }));
  const changeBackendRead = (selected: string[], read: boolean) => {
    backend = backend.map((row) => {
      if (!selected.includes(row.id)) return row;
      const withoutRead = row.tags.replace('|read|', '|');
      return { ...row, tags: read ? `${withoutRead}read|` : withoutRead };
    });
  };
  const patchBackendTags = (id: string, tags: string) => {
    backend = backend.map((row) => row.id === id ? { ...row, tags } : row);
  };
  const query = (section?: string, filter?: ViewFilter) => backend.filter((row) => {
    const read = isRead(row);
    if (typeof filter?.isUnread === 'boolean' && !read !== filter.isUnread) return false;
    if (section === 'unread') return !read;
    if (section === 'read') return read;
    if (section === 'important_unread') return row.tags.includes('|important|') && !read;
    if (section === 'important') return row.tags.includes('|important|');
    if (section === 'starred') return row.tags.includes('|starred|');
    if (section === 'everything_else') return !(row.tags.includes('|important|') && !read) && !row.tags.includes('|starred|');
    return true;
  });
  const list = vi.fn(async (_folderId: string, limit: number, offset = 0) => ({ success: true, data: query().slice(offset, offset + limit) }));
  const listBySection = vi.fn(async (section: string, limit: number, offset: number, _folderPath?: string, filter?: ViewFilter) => ({
    success: true, data: query(section, filter).slice(offset, offset + limit),
  }));
  const sectionCounts = vi.fn(async (sections: string[], _folderPath?: string, filter?: ViewFilter) => ({
    success: true, data: Object.fromEntries(sections.map((section) => [section, query(section, filter).length])),
  }));
  const bulkAction = vi.fn(async (selected: string[], action: string): Promise<BulkResponse> => {
    changeBackendRead(selected, action === 'markRead');
    return { success: true, data: { processedIds: selected, failedIds: [] } };
  });
  const alert = vi.fn();
  (globalThis as any).window = { alert, electronAPI: { emails: { list, listBySection, sectionCounts, bulkAction } } };
  const store = createStore<any>((set, get, api) => ({
    ...createEmailsSlice(set, get, api),
    ...createEmailActionsSlice(set, get, api),
    activeAccountId: 'account-a', accounts: [{ id: 'account-a' }],
    folders: [{ id: 'inbox', path: 'INBOX', totalCount: backend.length, serverMessageCount: 0 }],
    selectedFolderId: 'inbox', selectedVirtualFolder: null,
    viewingAICategory: null, viewingSection: null, viewingSectionPageSize: 50,
    searchQuery: '', searchResults: [], searchPage: 0, searching: false, searchInterpretation: null,
    activeInboxFilter: null, inboxType: 'default', inboxSections: [],
    loadFolders: vi.fn(async () => {}), refreshCategoryCounts: vi.fn(), refreshUnreadSummary: vi.fn(async () => {}),
    ...view,
  }));
  const get = store.getState;
  if (get().inboxType !== 'default' && !get().viewingSection) await get().loadAllSections('INBOX');
  else await get().goToEmailPage(0);
  list.mockClear();
  listBySection.mockClear();
  sectionCounts.mockClear();
  return { get, set: store.setState, original, bulkAction, list, listBySection, sectionCounts, changeBackendRead, patchBackendTags, alert };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

describe('bulkMarkRead refills read-sensitive views', () => {
  it.each([
    { label: 'Unread → mark read', initialRead: false, isUnread: true, read: true },
    { label: 'Read → mark unread', initialRead: true, isUnread: false, read: false },
  ])('refills the current full-section quick filter after $label', async ({ initialRead, isUnread, read }) => {
    const { get, original, listBySection, bulkAction } = await loadReadStore({
      viewingSection: 'important', activeInboxFilter: { isUnread },
    }, initialRead);
    expect(ids(get().emails)).toEqual(ids(original.slice(0, 50)));

    get().bulkMarkRead(ids(get().emails), read);

    await vi.waitFor(() => expect(ids(get().emails)).toEqual(ids(original.slice(50, 60))));
    expect(bulkAction).toHaveBeenCalledWith(ids(original.slice(0, 50)), read ? 'markRead' : 'markUnread', 'account-a', false);
    expect(listBySection).toHaveBeenCalledWith('important', 50, 0, 'INBOX', { isUnread });
    expect(get().emailsTotal).toBe(10);
    expect(get().hasMoreEmails).toBe(false);
    expect(get().activeInboxFilter).toEqual({ isUnread });
  });

  it.each([
    { inboxType: 'unread_first', source: 'unread', destination: 'read' },
    { inboxType: 'priority_first', source: 'important_unread', destination: 'everything_else' },
  ])('reloads source and destination preview buckets in $inboxType', async ({ inboxType, source, destination }) => {
    const { get, original, listBySection } = await loadReadStore({
      inboxType,
      inboxSections: [
        { id: 'source', filter: source, maxItems: 25 },
        { id: 'destination', filter: 'everything_else', maxItems: 25 },
      ],
    });
    expect(ids(get().sectionData.source.emails)).toEqual(ids(original.slice(0, 25)));
    expect(ids(get().sectionData.destination.emails)).toEqual(ids(original.slice(60)));

    get().bulkMarkRead(ids(get().sectionData.source.emails), true);

    await vi.waitFor(() => {
      expect(ids(get().sectionData.source.emails)).toEqual(ids(original.slice(25, 50)));
      expect(ids(get().sectionData.destination.emails)).toEqual(ids(original.slice(0, 25)));
    });
    expect(listBySection).toHaveBeenCalledWith(source, 25, 0, 'INBOX', undefined);
    expect(listBySection).toHaveBeenCalledWith(destination, 25, 0, 'INBOX', undefined);
    expect(get().sectionData.source.total).toBe(35);
    expect(get().sectionData.destination.total).toBe(33);
    expect(get().sectionData.destination.emails.every(isRead)).toBe(true);
  });

  it('keeps the current section page and refills it while also reloading the destination bucket', async () => {
    const { get, original, listBySection } = await loadReadStore({
      inboxType: 'unread_first',
      inboxSections: [
        { id: 'source', filter: 'unread', maxItems: 25 },
        { id: 'destination', filter: 'everything_else', maxItems: 25 },
      ],
    });
    await get().goToSectionPage('source', 'unread', 1, 'INBOX');
    listBySection.mockClear();

    get().bulkMarkRead(ids(get().sectionData.source.emails), true);

    await vi.waitFor(() => {
      expect(ids(get().sectionData.source.emails)).toEqual(ids(original.slice(50, 60)));
      expect(ids(get().sectionData.destination.emails)).toEqual(ids(original.slice(25, 50)));
    });
    expect(get().sectionData.source.page).toBe(1);
    expect(get().sectionData.source.total).toBe(35);
    expect(get().sectionData.destination.total).toBe(33);
    expect(listBySection).toHaveBeenCalledWith('unread', 25, 25, 'INBOX', undefined);
    expect(listBySection).toHaveBeenCalledWith('read', 25, 0, 'INBOX', undefined);
  });

  it('waits for an older page read before requesting the post-mutation unread page', async () => {
    const { get, original, listBySection } = await loadReadStore({ viewingSection: 'unread' });
    const staleRead = deferred<{ success: boolean; data: Row[] }>();
    listBySection.mockReturnValueOnce(staleRead.promise);
    const refreshing = get().goToEmailPage(0);
    get().bulkMarkRead(ids(original.slice(0, 50)), true);
    await vi.waitFor(() => expect(get().refreshUnreadSummary).toHaveBeenCalled());
    expect(listBySection).toHaveBeenCalledTimes(1);

    staleRead.resolve({ success: true, data: original.slice(0, 50) });
    await refreshing;

    await vi.waitFor(() => expect(ids(get().emails)).toEqual(ids(original.slice(50, 60))));
    expect(listBySection).toHaveBeenCalledTimes(2);
    expect(get().loadingMoreEmails).toBe(false);
    expect(get().emailsTotal).toBe(10);
  });

  it('does not requery an unfiltered flat Inbox when read flags cannot hide its rows', async () => {
    const { get, original, list, listBySection } = await loadReadStore();
    const selected = ids(get().emails);
    get().bulkMarkRead(selected, true);
    await vi.waitFor(() => expect(get().refreshUnreadSummary).toHaveBeenCalledOnce());

    expect(ids(get().emails)).toEqual(ids(original.slice(0, 25)));
    expect(get().emails.every(isRead)).toBe(true);
    expect(list).not.toHaveBeenCalled();
    expect(listBySection).not.toHaveBeenCalled();
  });

  it('rolls back only failed read bits while preserving concurrent star and category tags', async () => {
    const { get, set, bulkAction, changeBackendRead, patchBackendTags, alert } = await loadReadStore();
    const response = deferred<BulkResponse>();
    bulkAction.mockReturnValueOnce(response.promise);
    get().bulkMarkRead(['e0', 'e1'], true);
    expect(get().emails.slice(0, 2).every(isRead)).toBe(true);
    const freshTags = '|INBOX|important|read|starred|finance|';
    set({ emails: get().emails.map((row: Row) => row.id === 'e1' ? { ...row, tags: freshTags } : row) });
    patchBackendTags('e1', freshTags.replace('|read|', '|'));
    changeBackendRead(['e0'], true);

    response.resolve({ success: false, data: { processedIds: ['e0'], failedIds: ['e1'] } });

    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('Could not mark as read 1 message. Check your connection and try again.'));
    expect(isRead(get().emails.find((row: Row) => row.id === 'e0'))).toBe(true);
    expect(get().emails.find((row: Row) => row.id === 'e1').tags).toBe('|INBOX|important|starred|finance|');
    expect(get().emails).toHaveLength(25);
  });
});
