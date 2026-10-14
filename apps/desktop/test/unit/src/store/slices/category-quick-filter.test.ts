import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(), applyEmailCategories: vi.fn(),
  getCachedCategorySlugs: () => ['finance', 'social'], warmCategoryDefs: vi.fn(),
}));

import { createEmailActionsSlice } from '../../../../../src/store/slices/email-actions-slice';
import { createEmailsSlice } from '../../../../../src/store/slices/emails-slice';
import { createSearchAISlice } from '../../../../../src/store/slices/search-ai-slice';

const row = (id: string, tags: string, date: number) => ({
  id, threadId: `thread-${id}`, accountId: 'account-a', tags, date,
  hasAttachments: Number(id.split('-')[1]) % 3 === 0,
});

function harness(overrides: Record<string, unknown> = {}) {
  let backend = [
    ...Array.from({ length: 53 }, (_, i) => row(`read-${i}`, '|INBOX|finance|read|', 1_000 - i)),
    ...Array.from({ length: 53 }, (_, i) => row(`unread-${i}`, `|INBOX|finance|${i % 2 ? 'starred|' : ''}`, 900 - i)),
    row('social-0', '|INBOX|social|', 1_100),
  ];
  const matching = (query: any) => backend.filter((email) =>
    (!query.aiCategory || email.tags.includes(`|${query.aiCategory}|`))
    && (query.isUnread === undefined || email.tags.includes('|read|') !== query.isUnread)
    && (!query.isFlagged || email.tags.includes('|starred|'))
    && (!query.hasAttachments || email.hasAttachments)
    && (!query.noCategory || !['finance', 'social'].some((slug) => email.tags.includes(`|${slug}|`))))
    .sort((a, b) => b.date - a.date);
  const search = vi.fn(async (query: any) => ({
    success: true, data: matching(query).slice(query.offset, query.offset + query.limit),
  }));
  const searchCount = vi.fn(async (query: any) => ({ success: true, data: matching(query).length }));
  const getByCategory = vi.fn(async (category: string, limit: number, offset: number) => ({
    success: true, data: matching({ aiCategory: category }).slice(offset, offset + limit),
  }));
  const getCategoryCounts = vi.fn(async () => ({ success: true, data: { finance: 106, social: 1 } }));
  const unifiedInbox = vi.fn(async (options: any) => {
    const matches = matching({ ...options.filter, aiCategory: options.aiCategory });
    const emails = matches.slice(options.offset, options.offset + options.limit);
    return { success: true, data: { emails, total: matches.length, hasMore: options.offset + emails.length < matches.length } };
  });
  const bulkAction = vi.fn(async (ids: string[], action: string) => {
    backend = backend.map((email) => {
      if (!ids.includes(email.id)) return email;
      const tags = email.tags.replace('|read|', '|');
      return { ...email, tags: action === 'markRead' ? `${tags}read|` : tags };
    });
    return { success: true, data: { processedIds: ids, failedIds: [] } };
  });
  vi.stubGlobal('window', {
    alert: vi.fn(),
    electronAPI: {
      ai: { search, searchCount, getByCategory, getCategoryCounts },
      accounts: { unifiedInbox, unifiedCategoryCounts: getCategoryCounts },
      emails: { bulkAction },
    },
  });
  const store = createStore<any>((set, get, api) => ({
    ...createEmailsSlice(set, get, api),
    ...createSearchAISlice(set, get, api),
    ...createEmailActionsSlice(set, get, api),
    activeAccountId: 'account-a',
    accounts: [{ id: 'account-a' }, { id: 'account-b' }, { id: 'excluded', includeInUnified: false }],
    folders: [{ id: 'inbox', path: 'INBOX' }], selectedFolderId: 'inbox',
    selectedVirtualFolder: null, inboxType: 'unread_first',
    inboxSections: [{ id: 'unread', filter: 'unread', maxItems: 25 }],
    sectionData: {}, threadEmails: [],
    loadAllSections: vi.fn(async () => {}),
    loadFolders: vi.fn(async () => {}), refreshUnreadSummary: vi.fn(async () => {}),
    ...overrides,
  }));
  return { get: store.getState, set: store.setState, search, searchCount, getByCategory, getCategoryCounts, unifiedInbox, bulkAction };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('category tabs retaining an inbox quick-filter', () => {
  it('loads Finance unread matches and refills the same later page after marking its 25 rows read', async () => {
    const h = harness();
    await h.get().setInboxFilter({ isUnread: true }, 'Unread');
    await h.get().loadAICategoryEmails('finance');

    expect(h.get().searchQuery).toBe('');
    expect(h.get().activeInboxFilter).toEqual({ isUnread: true });
    expect(h.get().emails.map((email: any) => email.id)).toEqual(Array.from({ length: 25 }, (_, i) => `unread-${i}`));
    expect(h.get().emailsTotal).toBe(53);
    expect(h.get().hasMoreEmails).toBe(true);
    expect(h.search).toHaveBeenLastCalledWith({ aiCategory: 'finance', folderId: 'inbox', isUnread: true, limit: 25, offset: 0 });
    expect(h.searchCount).toHaveBeenCalledWith({ aiCategory: 'finance', folderId: 'inbox', isUnread: true });

    await h.get().goToEmailPage(1);
    const selected = h.get().emails.map((email: any) => email.id);
    h.get().bulkMarkRead(selected, true);
    await vi.waitFor(() => expect(h.get().emailsTotal).toBe(28));

    expect(h.get().emailsPage).toBe(1);
    expect(h.get().emails.map((email: any) => email.id)).toEqual(['unread-50', 'unread-51', 'unread-52']);
    expect(h.get().viewingAICategory).toBe('finance');
    expect(h.get().hasMoreEmails).toBe(false);
    expect(h.getByCategory).not.toHaveBeenCalled();
    expect(h.getCategoryCounts).not.toHaveBeenCalled();
  });

  it('preserves the inverse Read quick-filter when rows are marked unread', async () => {
    const h = harness({ activeInboxFilter: { isUnread: false } });
    await h.get().loadAICategoryEmails('finance');
    h.get().bulkMarkRead(h.get().emails.map((email: any) => email.id), false);
    await vi.waitFor(() => expect(h.get().emailsTotal).toBe(28));

    expect(h.get().emails.map((email: any) => email.id)).toEqual(Array.from({ length: 25 }, (_, i) => `read-${i + 25}`));
    expect(h.search).toHaveBeenLastCalledWith({ aiCategory: 'finance', folderId: 'inbox', isUnread: false, limit: 25, offset: 0 });
  });

  it.each([
    { filter: { isFlagged: true }, total: 26, fields: { isFlagged: true } },
    { filter: { hasAttachments: true }, total: 36, fields: { hasAttachments: true } },
    { filter: { isUnread: true, hasAttachments: true }, total: 18, fields: { isUnread: true, hasAttachments: true } },
    { filter: { noCategory: true }, total: 0, fields: { noCategory: true } },
    { filter: { isFlagged: false, hasAttachments: false, noCategory: false }, total: 106, fields: {} },
  ])('counts and pages the same ViewFilter predicate: $filter', async ({ filter, total, fields }) => {
    const h = harness({ activeInboxFilter: filter });
    await h.get().loadAICategoryEmails('finance');

    expect(h.get().emailsTotal).toBe(total);
    expect(h.searchCount).toHaveBeenCalledWith({ aiCategory: 'finance', folderId: 'inbox', ...fields });
    expect(h.get().emails).toHaveLength(Math.min(25, total));
  });

  it('uses the unified filtered total and participating accounts for initial and later category pages', async () => {
    const h = harness({ selectedFolderId: null, selectedVirtualFolder: 'virtual-unified', activeInboxFilter: { isUnread: true } });
    await h.get().loadAICategoryEmails('finance');
    await h.get().goToEmailPage(1);

    expect(h.unifiedInbox).toHaveBeenNthCalledWith(1, {
      accountIds: ['account-a', 'account-b'], aiCategory: 'finance', filter: { isUnread: true }, limit: 25, offset: 0,
    });
    expect(h.unifiedInbox).toHaveBeenNthCalledWith(2, {
      accountIds: ['account-a', 'account-b'], aiCategory: 'finance', filter: { isUnread: true }, limit: 25, offset: 25,
    });
    expect(h.get().emailsTotal).toBe(53);
    expect(h.get().emails[0].id).toBe('unread-25');
    expect(h.getCategoryCounts).not.toHaveBeenCalled();
    expect(h.searchCount).not.toHaveBeenCalled();
  });

  it('keeps the retained quick-filter when a category caller requests more rows', async () => {
    const h = harness({ activeInboxFilter: { isUnread: true } });
    await h.get().loadAICategoryEmails('finance');
    await h.get().loadMoreEmails();

    expect(h.get().emails.map((email: any) => email.id)).toEqual(Array.from({ length: 50 }, (_, i) => `unread-${i}`));
    expect(h.search).toHaveBeenLastCalledWith({ aiCategory: 'finance', folderId: 'inbox', isUnread: true, limit: 25, offset: 25 });
    expect(h.getByCategory).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer filter when its initial category query finishes late', async () => {
    const h = harness({ activeInboxFilter: { isUnread: true } });
    let resolve!: (value: { success: boolean; data: any[] }) => void;
    h.search.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = h.get().loadAICategoryEmails('finance');
    const replacement = [row('new-filter', '|INBOX|finance|read|', 2_000)];
    h.set({ activeInboxFilter: { isUnread: false }, emails: replacement, loadingEmails: false });
    resolve({ success: true, data: [row('old-filter', '|INBOX|finance|', 1_000)] });
    await pending;

    expect(h.get().emails).toBe(replacement);
    expect(h.get().loadingEmails).toBe(false);
  });

  it('keeps category-only browsing on its existing category query and count source', async () => {
    const h = harness();
    await h.get().loadAICategoryEmails('finance');
    await h.get().goToEmailPage(1);

    expect(h.getByCategory).toHaveBeenNthCalledWith(1, 'finance', 25, 0, 'inbox');
    expect(h.getByCategory).toHaveBeenNthCalledWith(2, 'finance', 25, 25, 'inbox');
    expect(h.get().emailsTotal).toBe(106);
    expect(h.search).not.toHaveBeenCalled();
    expect(h.searchCount).not.toHaveBeenCalled();
  });
});
