import type { SMTPConfig } from '@sarvinbox/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { applyEmailCategories, clearCategoryBadgeCache, getCachedCategorySlugs, warmCategoryDefs } from '../../../../src/components/email-list/CategoryBadges';
import { DEFAULT_SECTIONS } from '../../../../src/config/inbox-types';
import { getDefaultProvider, reportAIHealthy, reportAIUnhealthy, syncAIProviderToMain } from '../../../../src/services/ai-service';
import {
  ACCOUNT_COLORS,
  ALL_MAIL_PAGE_SIZE,
  SECTION_FULL_PAGE_SIZE,
  STANDARD_FOLDER_PAGE_SIZE,
  accountColorForIndex,
  accountDisplayLabel,
  accountHost,
  accountIdFor,
  canonicalizeAccountIds,
  clearCredentials,
  clearImageAllowedCache,
  clearSmtpCredentials,
  computeSectionFetchLimit,
  deriveSmtpFromImap,
  effectiveSmtpConfig,
  extractSecrets,
  fetchAICategoryTotal,
  fetchVirtualFolderTotal,
  fetchVaultSecrets,
  findAccountByEmailHost,
  getBodyDownloadLimit,
  getEmailsPerPage,
  getMaxAIProcessingEmails,
  getMaxEmailsPerFolder,
  getPageSizeForView,
  isThreadPagedView,
  getPageSizeForState,
  mergePageWindow,
  getRemoteImageMode,
  isAccountEmailDuplicated,
  isFolderInView,
  findFolderPathById,
  decideSyncProgressRefresh,
  SYNC_PROGRESS_REFRESH_MS,
  isPromoOrSpam,
  isSenderImagesAllowed,
  loadAccounts,
  loadActiveAccountId,
  loadInboxSettings,
  loadQuotaCache,
  loadSavedCredentials,
  loadSavedSmtpCredentials,
  loadSavedViewMode,
  loadSmtpConfigured,
  migrateAccounts,
  migrateCredentialsToVault,
  normalizeAccount,
  pickAccountColor,
  qualifiesForSafeAutoLoad,
  rememberImagesAllowed,
  forgetImagesAllowed,
  rememberSenderImagesAllowed,
  removeAccount,
  resolveFolderTotal,
  SECTION_RELOAD_MAX_ITEMS,
  sectionDataSignature,
  sectionDataUnchanged,
  saveAccounts,
  saveActiveAccountId,
  saveCredentials,
  saveQuotaCache,
  saveSmtpConfigured,
  saveSmtpCredentials,
  saveViewMode,
  setupAICategorizationListeners,
  shouldAutoLoadRemoteImages,
  stripSecrets,
  upsertAccount,
  warmImageAllowedSenders,
} from '../../../../src/store/helpers';
import type { StoredAccount } from '../../../../src/store/types';

// CategoryBadges owns the AI-category slug cache that `qualifiesForSafeAutoLoad`
// gates on; stubbing it keeps that decision under test control instead of
// depending on an IPC round trip. (vi.mock is hoisted above the imports above.)
vi.mock('../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
  applyEmailCategories: vi.fn(),
  getCachedCategorySlugs: vi.fn(() => [] as string[]),
  warmCategoryDefs: vi.fn(),
}));

// ai-service reaches for providers/HTTP on import; the listener tests only care
// that the right health call fires.
vi.mock('../../../../src/services/ai-service', () => ({
  reportAIHealthy: vi.fn(),
  reportAIUnhealthy: vi.fn(),
  getDefaultProvider: vi.fn(() => null as unknown),
  syncAIProviderToMain: vi.fn(),
}));

const SETTINGS_KEY = 'sarvinbox-settings';

/** Minimal in-memory localStorage — the vitest env is 'node', which has none. */
const installLocalStorage = () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};

const writeSettings = (settings: Record<string, unknown> | string) =>
  localStorage.setItem(SETTINGS_KEY, typeof settings === 'string' ? settings : JSON.stringify(settings));

/** window.electronAPI does not exist under test — stub only what a unit needs. */
const installElectronAPI = (api: Record<string, unknown> = {}) => {
  (globalThis as any).window = { electronAPI: api };
};

const account = (over: Partial<StoredAccount> = {}): StoredAccount => ({
  id: 'acct-a-x-com--imap-x-com',
  email: 'a@x.com',
  imapConfig: { host: 'imap.x.com', username: 'a@x.com' },
  smtpConfig: null,
  smtpConfigured: false,
  color: '#2563eb',
  includeInUnified: true,
  backgroundSync: true,
  notify: true,
  ...over,
});

type ConsoleLevel = 'log' | 'warn' | 'error';
const spyOnConsole = (level: ConsoleLevel) => vi.spyOn(console, level).mockImplementation(() => {});
const consoleSpies = {} as Record<ConsoleLevel, ReturnType<typeof spyOnConsole>>;

beforeEach(() => {
  installLocalStorage();
  installElectronAPI();
  clearImageAllowedCache();
  vi.clearAllMocks();
  vi.mocked(getCachedCategorySlugs).mockReturnValue([]);
  vi.mocked(getDefaultProvider).mockReturnValue(null as unknown as never);
  // helpers.ts logs through raw console.* — silence it so the reporter stays
  // readable, and keep the handles so the log-mirroring test can assert on them.
  consoleSpies.log = spyOnConsole('log');
  consoleSpies.warn = spyOnConsole('warn');
  consoleSpies.error = spyOnConsole('error');
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
});

// ───────────────────────────── page sizing ─────────────────────────────────

describe('page size selection', () => {
  // A mismatch between the initial load, the Paginator label and prev/next is
  // exactly what makes the "of N" count jump (20 → 50) between renders, so all
  // three must read the size from this ONE helper.
  it('defaults emailsPerPage to 25 with no stored settings', () => {
    expect(getEmailsPerPage()).toBe(25);
  });

  it('honours the user\'s emailsPerPage setting', () => {
    writeSettings({ emailsPerPage: 50 });
    expect(getEmailsPerPage()).toBe(50);
  });

  it('falls back to 25 for a 0/absent/corrupt stored value', () => {
    writeSettings({ emailsPerPage: 0 });
    expect(getEmailsPerPage()).toBe(25);
    writeSettings({});
    expect(getEmailsPerPage()).toBe(25);
    writeSettings('{not json');
    expect(getEmailsPerPage()).toBe(25);
  });

  it('pages the firehose views at a FIXED 100, ignoring emailsPerPage', () => {
    // "All Email" / "All Inboxes" are deliberate exceptions — they span every
    // folder and account, and a 25-row page over that makes the view unusable.
    writeSettings({ emailsPerPage: 25 });
    expect(getPageSizeForView({ virtualFolder: 'virtual-all' })).toBe(ALL_MAIL_PAGE_SIZE);
    expect(getPageSizeForView({ virtualFolder: 'virtual-unified' })).toBe(100);
  });

  it('pages the account\'s own standard mailboxes at 50', () => {
    // Sent/Drafts/Trash/Spam/Archive are scanned in bulk, not read one by one.
    // If this regresses they drop back to a 25-row page (and, before the tiers
    // existed, disagreed with the background merge's hardcoded 100 — which is
    // what put "1–100 of 1,718" under a 25-row Sent page).
    writeSettings({ emailsPerPage: 25 });
    expect(getPageSizeForView({ folder: { path: 'Sent', specialUse: '\\Sent' } })).toBe(STANDARD_FOLDER_PAGE_SIZE);
    expect(getPageSizeForView({ folder: { path: 'Drafts' } })).toBe(50);
    expect(getPageSizeForView({ folder: { path: '[Gmail]/Trash' } })).toBe(50);
    expect(getPageSizeForView({ folder: { path: 'Junk Email' } })).toBe(50);
    expect(getPageSizeForView({ folder: { path: 'Archive' } })).toBe(50);
  });

  it('pages Starred and Important at 50, like the account\'s other bulk-scan lists', () => {
    // They gather ONE account's mail across its folders — the same kind of list
    // as Sent or Drafts, so they page the same way. They are NOT the firehose:
    // they don't span accounts, which is what earns All Email its 100. If this
    // regresses they drop back to a 25-row page while Sent shows 50, which is
    // exactly the inconsistency the tiers exist to remove.
    writeSettings({ emailsPerPage: 25 });
    expect(getPageSizeForView({ virtualFolder: 'virtual-starred' })).toBe(STANDARD_FOLDER_PAGE_SIZE);
    expect(getPageSizeForView({ virtualFolder: 'virtual-important' })).toBe(50);
    // ...and "All Email" keeps its 100 even though it now pages by conversation
    // too: the grain and the tier are separate decisions, and folding them into
    // one set would silently cut the firehose page in half.
    expect(getPageSizeForView({ virtualFolder: 'virtual-all' })).toBe(ALL_MAIL_PAGE_SIZE);
  });

  it('pages the section full-page view at 50 whatever folder it sits on', () => {
    // Clicking a section's counter opens its full page; the size is the
    // section's, not the folder's, so INBOX and Sent both page it at 50.
    writeSettings({ emailsPerPage: 25 });
    expect(getPageSizeForView({ section: 'unread' })).toBe(SECTION_FULL_PAGE_SIZE);
    expect(getPageSizeForView({ section: 'unread', folder: { path: 'Sent' } })).toBe(50);
    expect(getPageSizeForView({ section: 'unread', virtualFolder: 'virtual-all' })).toBe(50);
  });

  it('honours the user setting for every other view', () => {
    writeSettings({ emailsPerPage: 50 });
    expect(getPageSizeForView({ folder: { path: 'INBOX' } })).toBe(50);
    expect(getPageSizeForView({ folder: { path: 'Projects/2026' } })).toBe(50);
    expect(getPageSizeForView({})).toBe(50);
    expect(getPageSizeForView()).toBe(50);
    // A category list is the user's reading list wherever it came from — it
    // must NOT inherit the 100 of the firehose view it was opened on top of.
    expect(getPageSizeForView({ virtualFolder: 'virtual-all', aiCategory: 'needs-response' })).toBe(50);
  });

  it('pins the Gmail-style full-page section size at 50 (independent of maxItems)', () => {
    expect(SECTION_FULL_PAGE_SIZE).toBe(50);
  });
});

describe('getPageSizeForState', () => {
  // The store's loaders, the header pager and the footer pager all read the size
  // from here. If any of them re-derives it from raw state instead, the label
  // and the rows disagree — the reported "1–100 of 1,718" on a 25-row page.
  beforeEach(() => writeSettings({ emailsPerPage: 25 }));

  const folders = [
    { id: 'f-inbox', path: 'INBOX' },
    { id: 'f-sent', path: 'Sent', specialUse: '\\Sent' },
  ];

  it('reads the tier of the folder the store is on', () => {
    expect(getPageSizeForState({ selectedFolderId: 'f-sent', folders })).toBe(50);
    expect(getPageSizeForState({ selectedFolderId: 'f-inbox', folders })).toBe(25);
  });

  it('prefers the size the section view was opened with', () => {
    // Captured when the section was opened, so changing emailsPerPage mid-view
    // cannot strand the reader on a half page.
    expect(getPageSizeForState({
      viewingSection: 'unread', viewingSectionPageSize: 50, selectedFolderId: 'f-inbox', folders,
    })).toBe(50);
  });

  it('falls back to the section tier when the stored size is missing', () => {
    expect(getPageSizeForState({ viewingSection: 'unread', viewingSectionPageSize: 0, folders })).toBe(50);
  });

  it('pages the firehose views at 100 and an empty state at the user setting', () => {
    expect(getPageSizeForState({ selectedVirtualFolder: 'virtual-all' })).toBe(100);
    expect(getPageSizeForState({})).toBe(25);
  });

  // Snoozed pages like Starred (50 conversations), and the store reaches it
  // through viewingSnoozed, not a virtual folder — resolved in ONE place so the
  // loader, the pager and a background refresh can't pick different sizes.
  it('pages Snoozed at the standard tier whichever way the view is named', () => {
    expect(getPageSizeForState({ viewingSnoozed: true })).toBe(50);
    expect(getPageSizeForView({ snoozed: true })).toBe(50);
    expect(getPageSizeForView({ virtualFolder: 'virtual-snoozed' })).toBe(50);
  });
});

describe('isThreadPagedView', () => {
  // The unit the page window is measured in. Starred read "1-50 of 52" over 15
  // rows because the fetch counted conversations and everything downstream
  // counted messages; these are the views where that mistake is possible.
  it('is true for the section full-page view and the thread-paged virtual folders', () => {
    expect(isThreadPagedView({ section: 'starred' })).toBe(true);
    expect(isThreadPagedView({ virtualFolder: 'virtual-starred' })).toBe(true);
    expect(isThreadPagedView({ virtualFolder: 'virtual-important' })).toBe(true);
    expect(isThreadPagedView({ virtualFolder: 'virtual-all' })).toBe(true);
  });

  // Snoozed is the same kind of source but has no selectedVirtualFolder to
  // recognise it by — the store flags it separately. Without the flag its label
  // counts messages over collapsed rows, the bug this whole set guards.
  it('is true for the Snoozed view, which carries a flag instead of a virtual folder', () => {
    expect(isThreadPagedView({ snoozed: true })).toBe(true);
    expect(isThreadPagedView({ virtualFolder: 'virtual-snoozed' })).toBe(true);
    expect(isThreadPagedView({ snoozed: false })).toBe(false);
  });

  // The grain and the page SIZE are independent questions: "All Inboxes" shares
  // All Email's 100 but merges several accounts' lists in the renderer, with no
  // single thread-grained repository query behind it. Flipping it here without
  // changing that would break its label instead of fixing it.
  it('is false for All Inboxes and for no view at all', () => {
    expect(isThreadPagedView({ virtualFolder: 'virtual-unified' })).toBe(false);
    expect(isThreadPagedView({})).toBe(false);
    expect(isThreadPagedView()).toBe(false);
  });
});

describe('mergePageWindow', () => {
  // A background refresh (sync completion / IDLE flush) folds a re-read of the
  // CURRENT page into the rows on screen. Every assertion here is a symptom that
  // was live: a 25-row page that grew to 100, a page-4 reader whose rows were
  // replaced by page 1, and a deleted mail that would not go away.
  const row = (id: string, date: number, over: Record<string, unknown> = {}) =>
    ({ id, date, tags: '', subject: id, ...over }) as any;

  it('never returns more rows than the page holds', () => {
    const current = [row('a', 3), row('b', 2)];
    const fresh = [row('z', 9), row('y', 8), row('a', 3), row('b', 2)];
    const merged = mergePageWindow(current, fresh, 2);
    expect(merged.emails.map((e) => e.id)).toEqual(['z', 'y']);
    expect(merged.added).toBe(2);
    expect(merged.changed).toBe(true);
  });

  it('takes the fresh row when a tracked field changed, and counts it', () => {
    const current = [row('a', 3, { tags: '|unread|' })];
    const fresh = [row('a', 3, { tags: '' })];
    const merged = mergePageWindow(current, fresh, 25);
    expect(merged.emails[0].tags).toBe('');
    expect(merged.updated).toBe(1);
  });

  it('drops a row the window no longer carries (a delete the realtime path missed)', () => {
    const merged = mergePageWindow([row('a', 3), row('b', 2)], [row('a', 3)], 25);
    expect(merged.emails.map((e) => e.id)).toEqual(['a']);
    expect(merged.removed).toBe(1);
  });

  it('does not re-add a row inside the delete-undo window', () => {
    // It is still in the DB for 5s, so it comes back in every refetch; adding it
    // makes the deleted mail reappear until the user switches folders.
    const merged = mergePageWindow([row('a', 3)], [row('a', 3), row('ghost', 4)], 25, new Set(['ghost']));
    expect(merged.emails.map((e) => e.id)).toEqual(['a']);
    expect(merged.added).toBe(0);
    expect(merged.changed).toBe(false);
  });

  // A thread-paged window holds pageSize CONVERSATIONS, so capping by message
  // would lop the tail off a thread — the row would render with some of its
  // mail missing, and the next page would show the rest as a second row.
  it('caps a thread-paged window by conversation, keeping every message of the ones it keeps', () => {
    const keyOf = (r: any) => r.threadId as string;
    const current: any[] = [];
    const fresh = [
      row('a1', 9, { threadId: 't1' }),
      row('b1', 8, { threadId: 't2' }),
      row('a2', 7, { threadId: 't1' }), // older message of the FIRST thread
      row('c1', 6, { threadId: 't3' }),
    ];
    const merged = mergePageWindow(current, fresh, 2, new Set(), keyOf);
    expect(merged.emails.map((e) => e.id)).toEqual(['a1', 'b1', 'a2']);
  });

  // Without a key function the cap stays message-grained, so every existing
  // (message-paged) caller keeps its old behaviour.
  it('still caps by message when no conversation key is given', () => {
    const fresh = [row('a1', 9, { threadId: 't1' }), row('b1', 8, { threadId: 't2' }), row('a2', 7, { threadId: 't1' })];
    expect(mergePageWindow([], fresh, 2).emails.map((e) => e.id)).toEqual(['a1', 'b1']);
  });

  it('reports no change when the window came back identical', () => {
    // The caller skips `set` on this — a new array identity re-renders every row
    // and rebuilds every thread on each sync tick.
    const current = [row('a', 3), row('b', 2)];
    const merged = mergePageWindow(current, [row('a', 3), row('b', 2)], 25);
    expect(merged.changed).toBe(false);
  });

  it('shrinks a page that an older build had already over-filled', () => {
    // Upgrade path: the 100 rows a previous merge left in memory must collapse
    // back to the page window on the next refresh, not stay until a folder switch.
    const current = Array.from({ length: 100 }, (_, i) => row(`e${i}`, 100 - i));
    const fresh = current.slice(0, 25);
    const merged = mergePageWindow(current, fresh, 25);
    expect(merged.emails).toHaveLength(25);
    expect(merged.changed).toBe(true);
  });
});

describe('resolveFolderTotal', () => {
  // The "of N" denominator. It must report WHICH UNIT it is in, because
  // hasMore is computed off a thread offset in one mode and a message length in
  // the other — mixing them shows a next-page arrow that leads nowhere.
  it('uses the read-model thread count and reports threadMode when available', async () => {
    const folderThreadCount = vi.fn().mockResolvedValue({ success: true, data: 42 });
    installElectronAPI({ emails: { folderThreadCount } });
    await expect(resolveFolderTotal({ path: 'INBOX', totalCount: 900 }, { isUnread: true })).resolves.toEqual({
      total: 42,
      threadMode: true,
    });
    expect(folderThreadCount).toHaveBeenCalledWith('INBOX', { isUnread: true });
  });

  it('accepts a thread count of 0 (an empty folder is a real answer, not a miss)', async () => {
    installElectronAPI({ emails: { folderThreadCount: vi.fn().mockResolvedValue({ success: true, data: 0 }) } });
    await expect(resolveFolderTotal({ path: 'INBOX', totalCount: 5 })).resolves.toEqual({ total: 0, threadMode: true });
  });

  it('falls back to the legacy MESSAGE total when the read model is not ready', async () => {
    installElectronAPI({ emails: { folderThreadCount: vi.fn().mockResolvedValue({ success: false }) } });
    await expect(resolveFolderTotal({ totalCount: 120, serverMessageCount: 300 })).resolves.toEqual({
      total: 300, // max(local, server) — the server knows about unsynced mail
      threadMode: false,
    });
  });

  it('falls back when the count returns null data or the IPC throws', async () => {
    installElectronAPI({ emails: { folderThreadCount: vi.fn().mockResolvedValue({ success: true, data: null }) } });
    await expect(resolveFolderTotal({ totalCount: 7 })).resolves.toEqual({ total: 7, threadMode: false });

    installElectronAPI({ emails: { folderThreadCount: vi.fn().mockRejectedValue(new Error('no channel')) } });
    await expect(resolveFolderTotal({ serverMessageCount: 9 })).resolves.toEqual({ total: 9, threadMode: false });
  });

  it('resolves to 0 for an unknown folder rather than NaN/undefined', async () => {
    installElectronAPI({});
    await expect(resolveFolderTotal(undefined)).resolves.toEqual({ total: 0, threadMode: false });
  });
});

describe('fetchAICategoryTotal', () => {
  // The category paginator's "of N" denominator = the category TOTAL, so it must
  // call the count query in 'total' mode (getCategoryCounts / unifiedCategoryCounts
  // on All Inboxes) — a DIFFERENT number from the chip, which uses the default
  // 'unread' mode. It must also degrade to 0 (never throw) so a flaky count IPC
  // can't break the view.
  const base = {
    category: 'promotions',
    selectedFolderId: 'f-inbox' as string | null,
    selectedVirtualFolder: null as string | null,
    unifiedAccountIds: [] as string[],
  };

  it('non-unified: reads getCategoryCounts(folderId) and returns THIS category count', async () => {
    const getCategoryCounts = vi.fn().mockResolvedValue({ success: true, data: { promotions: 12, finance: 3 } });
    installElectronAPI({ ai: { getCategoryCounts } });
    await expect(fetchAICategoryTotal(base)).resolves.toBe(12);
    expect(getCategoryCounts).toHaveBeenCalledWith('f-inbox', 'total');
  });

  it('passes undefined (not null) to the folder-scoped count when no folder is selected', async () => {
    const getCategoryCounts = vi.fn().mockResolvedValue({ success: true, data: { promotions: 5 } });
    installElectronAPI({ ai: { getCategoryCounts } });
    await fetchAICategoryTotal({ ...base, selectedFolderId: null });
    expect(getCategoryCounts).toHaveBeenCalledWith(undefined, 'total');
  });

  it('unified: sums across accounts via unifiedCategoryCounts and ignores the folder path', async () => {
    const unifiedCategoryCounts = vi.fn().mockResolvedValue({ success: true, data: { promotions: 20 } });
    const getCategoryCounts = vi.fn();
    installElectronAPI({ accounts: { unifiedCategoryCounts }, ai: { getCategoryCounts } });
    await expect(
      fetchAICategoryTotal({ ...base, selectedVirtualFolder: 'virtual-unified', unifiedAccountIds: ['a', 'b'] }),
    ).resolves.toBe(20);
    expect(unifiedCategoryCounts).toHaveBeenCalledWith(['a', 'b'], 'total');
    expect(getCategoryCounts).not.toHaveBeenCalled(); // unified must NOT hit the single-account source
  });

  it('returns 0 when the category is absent from the map (chip would show nothing)', async () => {
    installElectronAPI({ ai: { getCategoryCounts: vi.fn().mockResolvedValue({ success: true, data: { finance: 3 } }) } });
    await expect(fetchAICategoryTotal(base)).resolves.toBe(0);
  });

  it('returns 0 on an unsuccessful response', async () => {
    installElectronAPI({ ai: { getCategoryCounts: vi.fn().mockResolvedValue({ success: false }) } });
    await expect(fetchAICategoryTotal(base)).resolves.toBe(0);
  });

  it('returns 0 when the IPC throws — never rejects into the caller', async () => {
    installElectronAPI({ ai: { getCategoryCounts: vi.fn().mockRejectedValue(new Error('no channel')) } });
    await expect(fetchAICategoryTotal(base)).resolves.toBe(0);
  });
});

describe('fetchVirtualFolderTotal', () => {
  // The "of N" for All Email / Starred / Important / Snoozed. Without it these
  // views paged with a bare "1–100" and the user had no idea how much mail sat
  // behind the list. One COUNT(*) round trip, reused across pages by the caller.
  const counts = { all: 1718, starred: 42, important: 7, snoozed: 3 };

  it.each([
    ['virtual-all', 1718],
    ['virtual-starred', 42],
    ['virtual-important', 7],
    ['virtual-snoozed', 3],
  ])('reads the %s total from the shared count IPC', async (virtualFolder, expected) => {
    const getVirtualFolderCounts = vi.fn().mockResolvedValue({ success: true, data: counts });
    installElectronAPI({ emails: { getVirtualFolderCounts } });
    await expect(fetchVirtualFolderTotal(virtualFolder)).resolves.toBe(expected);
  });

  // A view with no countable source (Outbox, a folder) must not fire the IPC at
  // all — it pages by hasMore, and a bogus total would promise pages it hasn't.
  // Each count is an unindexable tag scan. Showing ONE view's total must not
  // pay for all four.
  it('asks for this view\'s count only', async () => {
    const getVirtualFolderCounts = vi.fn().mockResolvedValue({ success: true, data: counts });
    installElectronAPI({ emails: { getVirtualFolderCounts } });
    await fetchVirtualFolderTotal('virtual-starred');
    expect(getVirtualFolderCounts).toHaveBeenCalledWith(['starred']);
  });

  it('returns 0 without calling the IPC for a view that has no count', async () => {
    const getVirtualFolderCounts = vi.fn();
    installElectronAPI({ emails: { getVirtualFolderCounts } });
    await expect(fetchVirtualFolderTotal('virtual-outbox')).resolves.toBe(0);
    expect(getVirtualFolderCounts).not.toHaveBeenCalled();
  });

  // Degrade to "unknown total", never to a wrong one: the Paginator reads 0 as
  // unknown and falls back to hasMore-gated paging.
  it('returns 0 on a missing count, an unsuccessful response, or a throwing IPC', async () => {
    installElectronAPI({ emails: { getVirtualFolderCounts: vi.fn().mockResolvedValue({ success: true, data: {} }) } });
    await expect(fetchVirtualFolderTotal('virtual-all')).resolves.toBe(0);

    installElectronAPI({ emails: { getVirtualFolderCounts: vi.fn().mockResolvedValue({ success: false }) } });
    await expect(fetchVirtualFolderTotal('virtual-all')).resolves.toBe(0);

    installElectronAPI({ emails: { getVirtualFolderCounts: vi.fn().mockRejectedValue(new Error('no channel')) } });
    await expect(fetchVirtualFolderTotal('virtual-all')).resolves.toBe(0);
  });
});

// ─────────────────────── remote images / auto-load ─────────────────────────

describe('getRemoteImageMode', () => {
  // Privacy-relevant: 'block' must never be silently upgraded, and a legacy
  // setting must map to the choice the user actually made.
  it('defaults new installs to safe', () => {
    expect(getRemoteImageMode()).toBe('safe');
    writeSettings({});
    expect(getRemoteImageMode()).toBe('safe');
  });

  it('returns each explicit mode verbatim', () => {
    for (const mode of ['block', 'safe', 'always'] as const) {
      writeSettings({ remoteImageMode: mode });
      expect(getRemoteImageMode()).toBe(mode);
    }
  });

  it('migrates the legacy "important" mode to safe', () => {
    writeSettings({ remoteImageMode: 'important' });
    expect(getRemoteImageMode()).toBe('safe');
  });

  it('maps the legacy autoLoadRemoteImages boolean to always/block', () => {
    writeSettings({ autoLoadRemoteImages: true });
    expect(getRemoteImageMode()).toBe('always');
    writeSettings({ autoLoadRemoteImages: false });
    expect(getRemoteImageMode()).toBe('block');
  });

  it('prefers the new mode field over the legacy boolean', () => {
    writeSettings({ remoteImageMode: 'block', autoLoadRemoteImages: true });
    expect(getRemoteImageMode()).toBe('block');
  });

  it('falls back to safe on an unknown mode or corrupt settings', () => {
    writeSettings({ remoteImageMode: 'sometimes' });
    expect(getRemoteImageMode()).toBe('safe');
    writeSettings('{not json');
    expect(getRemoteImageMode()).toBe('safe');
  });
});

describe('isPromoOrSpam', () => {
  it('matches the AI promotions category and every spam/junk folder tag', () => {
    expect(isPromoOrSpam('|INBOX|promotions|')).toBe(true);
    expect(isPromoOrSpam('|Junk|')).toBe(true);
    expect(isPromoOrSpam('|Spam|')).toBe(true);
    expect(isPromoOrSpam('|[Gmail]/Spam|')).toBe(true);
  });

  it('is false for ordinary mail and for missing tags', () => {
    expect(isPromoOrSpam('|INBOX|read|')).toBe(false);
    expect(isPromoOrSpam(null)).toBe(false);
    expect(isPromoOrSpam(undefined)).toBe(false);
  });
});

describe('qualifiesForSafeAutoLoad', () => {
  // 'safe' mode auto-loads images ONLY for mail the AI positively recognised.
  // Every uncertain case must stay behind the banner — that's the privacy
  // guarantee of the mode.
  it('refuses promotional / spam mail outright', () => {
    vi.mocked(getCachedCategorySlugs).mockReturnValue(['promotions', 'work']);
    expect(qualifiesForSafeAutoLoad('|INBOX|promotions|')).toBe(false);
    expect(qualifiesForSafeAutoLoad('|Spam|work|')).toBe(false);
  });

  it('stays conservative on a cold slug cache AND warms it for next time', () => {
    vi.mocked(getCachedCategorySlugs).mockReturnValue([]);
    expect(qualifiesForSafeAutoLoad('|INBOX|work|')).toBe(false);
    expect(warmCategoryDefs).toHaveBeenCalled();
  });

  it('auto-loads mail carrying a real enabled category slug', () => {
    vi.mocked(getCachedCategorySlugs).mockReturnValue(['work', 'finance']);
    expect(qualifiesForSafeAutoLoad('|INBOX|finance|read|')).toBe(true);
  });

  it('keeps UNcategorized mail behind the banner even with a warm cache', () => {
    vi.mocked(getCachedCategorySlugs).mockReturnValue(['work']);
    expect(qualifiesForSafeAutoLoad('|INBOX|read|')).toBe(false);
    expect(qualifiesForSafeAutoLoad(null)).toBe(false);
  });
});

describe('per-sender image allowlist', () => {
  // Kept synchronous because the block-vs-load decision happens inside the
  // sandboxed iframe render; a cold cache must answer "no" and warm in the
  // background rather than block the paint.
  it('answers false and warms in the background while the cache is cold', async () => {
    const getImageAllowedSenders = vi.fn().mockResolvedValue({ success: true, data: ['boss@x.com'] });
    installElectronAPI({ emails: { getImageAllowedSenders } });

    expect(isSenderImagesAllowed('boss@x.com')).toBe(false); // cold → conservative
    expect(getImageAllowedSenders).toHaveBeenCalled(); // …but the warm was kicked off
    // The re-render after warming picks up the real answer.
    await vi.waitFor(() => expect(isSenderImagesAllowed('boss@x.com')).toBe(true));
  });

  it('normalises "Name <addr>" and casing so both forms match one entry', async () => {
    installElectronAPI({ emails: { getImageAllowedSenders: vi.fn().mockResolvedValue({ success: true, data: ['Boss@X.com'] }) } });
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed('boss@x.com')).toBe(true);
    expect(isSenderImagesAllowed('The Boss <BOSS@X.com>')).toBe(true);
    expect(isSenderImagesAllowed('  boss@x.com  ')).toBe(true);
    expect(isSenderImagesAllowed('other@x.com')).toBe(false);
  });

  it('treats a missing/blank address as not allowed', async () => {
    installElectronAPI({ emails: { getImageAllowedSenders: vi.fn().mockResolvedValue({ success: true, data: [] }) } });
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed(undefined)).toBe(false);
    expect(isSenderImagesAllowed('')).toBe(false);
    expect(isSenderImagesAllowed('   ')).toBe(false);
  });

  it('warms to an EMPTY set when the IPC fails or returns nothing', async () => {
    installElectronAPI({ emails: { getImageAllowedSenders: vi.fn().mockRejectedValue(new Error('no channel')) } });
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed('boss@x.com')).toBe(false);

    clearImageAllowedCache();
    installElectronAPI({ emails: { getImageAllowedSenders: vi.fn().mockResolvedValue({ success: false }) } });
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed('boss@x.com')).toBe(false);
  });

  it('remembers a sender write-through: cache first, persistence in the background', () => {
    const allowImagesForSender = vi.fn().mockResolvedValue(undefined);
    installElectronAPI({ emails: { allowImagesForSender } });
    rememberSenderImagesAllowed('The Boss <BOSS@X.com>');
    expect(isSenderImagesAllowed('boss@x.com')).toBe(true); // immediate, no await
    expect(allowImagesForSender).toHaveBeenCalledWith('boss@x.com'); // bare address only
  });

  it('ignores a remember call with no address, and survives a failing persist', () => {
    const allowImagesForSender = vi.fn().mockRejectedValue(new Error('nope'));
    installElectronAPI({ emails: { allowImagesForSender } });
    rememberSenderImagesAllowed('');
    expect(allowImagesForSender).not.toHaveBeenCalled();
    expect(() => rememberSenderImagesAllowed('a@x.com')).not.toThrow();
  });

  it('lets one DOMAIN entry cover every sender on it, subdomains included', async () => {
    // The reason domains exist here: a newsletter's envelope sender is a
    // per-campaign address, so a per-sender allowance never sticks.
    installElectronAPI({ emails: { getImageAllowedSenders: vi.fn().mockResolvedValue({ success: true, data: ['@Example.com'] }) } });
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed('bounce-987@example.com')).toBe(true);
    expect(isSenderImagesAllowed('News <news@mail.example.com>')).toBe(true);
    expect(isSenderImagesAllowed('news@notexample.com')).toBe(false);
    expect(isSenderImagesAllowed('news@example.com.evil.net')).toBe(false);
  });

  it('stores a typed domain as an "@domain" key and applies it immediately', () => {
    // Write-through: the body renderer reads the CACHE, so an entry that only
    // reached the DB would be listed in Security but honoured by nothing.
    const allowImagesForSender = vi.fn().mockResolvedValue(undefined);
    installElectronAPI({ emails: { allowImagesForSender } });
    expect(rememberImagesAllowed('Example.COM')).toEqual({ kind: 'domain', key: '@example.com', label: 'example.com' });
    expect(allowImagesForSender).toHaveBeenCalledWith('@example.com');
    expect(isSenderImagesAllowed('anyone@example.com')).toBe(true);
  });

  it('refuses input that is neither an address nor a domain, and persists nothing', () => {
    const allowImagesForSender = vi.fn().mockResolvedValue(undefined);
    installElectronAPI({ emails: { allowImagesForSender } });
    for (const junk of ['', '   ', 'com', '@co.uk', 'not a domain']) {
      expect(rememberImagesAllowed(junk)).toBeNull();
    }
    expect(allowImagesForSender).not.toHaveBeenCalled();
  });

  it('revoking drops the entry from the cache, not just the DB', async () => {
    // Otherwise a revoked allowance keeps loading images on every message
    // already open, until the next account switch.
    const disallowImagesForSender = vi.fn().mockResolvedValue(undefined);
    installElectronAPI({
      emails: {
        disallowImagesForSender,
        getImageAllowedSenders: vi.fn().mockResolvedValue({ success: true, data: ['@example.com'] }),
      },
    });
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed('a@example.com')).toBe(true);

    forgetImagesAllowed('@example.com');
    expect(isSenderImagesAllowed('a@example.com')).toBe(false);
    expect(disallowImagesForSender).toHaveBeenCalledWith('@example.com');
  });

  it('ignores a blank revoke and survives a failing persist / missing channel', () => {
    installElectronAPI({ emails: { disallowImagesForSender: vi.fn().mockRejectedValue(new Error('nope')) } });
    forgetImagesAllowed('   ');
    forgetImagesAllowed(undefined);
    expect((window as any).electronAPI.emails.disallowImagesForSender).not.toHaveBeenCalled();
    expect(() => forgetImagesAllowed('@x.com')).not.toThrow();

    installElectronAPI({ emails: {} }); // older preload with no channel
    expect(() => forgetImagesAllowed('@x.com')).not.toThrow();
  });

  it('clears the cache on account switch so the next read reloads', async () => {
    // The allowlist is PER ACCOUNT — leaking it across a switch would auto-load
    // images the other account never approved.
    const getImageAllowedSenders = vi.fn().mockResolvedValue({ success: true, data: ['boss@x.com'] });
    installElectronAPI({ emails: { getImageAllowedSenders } });
    await warmImageAllowedSenders();
    expect(isSenderImagesAllowed('boss@x.com')).toBe(true);

    clearImageAllowedCache();
    getImageAllowedSenders.mockResolvedValue({ success: true, data: [] });
    expect(isSenderImagesAllowed('boss@x.com')).toBe(false);
    await vi.waitFor(() => expect(getImageAllowedSenders).toHaveBeenCalledTimes(2));
    expect(isSenderImagesAllowed('boss@x.com')).toBe(false);
  });
});

describe('shouldAutoLoadRemoteImages', () => {
  // This is the ONE answer both renderers use — the classic card and the chat
  // view. It lived inside SandboxedEmailBody, so the chat view never asked and
  // kept the library's block-everything default: a reader on 'always' still got
  // the banner on half the app. Any drift here brings that split back.
  it('auto-loads everywhere on always, and nowhere on block', () => {
    writeSettings({ remoteImageMode: 'always' });
    expect(shouldAutoLoadRemoteImages('anyone@x.com')).toBe(true);
    // Even a message the AI never categorised: 'always' means always.
    expect(shouldAutoLoadRemoteImages('anyone@x.com', false)).toBe(true);

    writeSettings({ remoteImageMode: 'block' });
    expect(shouldAutoLoadRemoteImages('anyone@x.com', true)).toBe(false);
  });

  // 'safe' is the default mode, so getting this backwards would auto-load
  // tracking pixels for every new install.
  it('defers to the category in safe mode', () => {
    writeSettings({ remoteImageMode: 'safe' });
    expect(shouldAutoLoadRemoteImages('anyone@x.com', true)).toBe(true);
    expect(shouldAutoLoadRemoteImages('anyone@x.com', false)).toBe(false);
  });

  // An allowlisted sender is an explicit per-sender decision by the reader, so
  // it outranks the global mode — including 'block', which is the whole point
  // of the "load images from this sender" affordance.
  it('lets an allowlisted sender beat every mode', async () => {
    installElectronAPI({ emails: { getImageAllowedSenders: vi.fn().mockResolvedValue({ success: true, data: ['boss@x.com'] }) } });
    await warmImageAllowedSenders();

    for (const mode of ['block', 'safe', 'always'] as const) {
      writeSettings({ remoteImageMode: mode });
      expect(shouldAutoLoadRemoteImages('The Boss <BOSS@X.com>')).toBe(true);
    }

    writeSettings({ remoteImageMode: 'block' });
    expect(shouldAutoLoadRemoteImages('stranger@x.com')).toBe(false);
  });

  // A missing sender must not throw or accidentally match the allowlist — a
  // chat bubble can carry a message whose From never parsed.
  it('treats a missing sender as not allowlisted', () => {
    writeSettings({ remoteImageMode: 'block' });
    expect(shouldAutoLoadRemoteImages(undefined)).toBe(false);
    expect(shouldAutoLoadRemoteImages(null, true)).toBe(false);
  });
});

// ────────────────────────── sync limit settings ────────────────────────────

describe('sync limit settings', () => {
  // The defaults MUST match components/settings/types.ts defaultSettings —
  // otherwise a fresh install syncs at a fraction of the configured limit until
  // the user opens Settings and clicks Save.
  it('defaults to 1000 / 1000 / 500 on a fresh install', () => {
    expect(getMaxEmailsPerFolder()).toBe(1000);
    expect(getBodyDownloadLimit()).toBe(1000);
    expect(getMaxAIProcessingEmails()).toBe(500);
  });

  it('reads the stored values', () => {
    writeSettings({ maxEmailsPerFolder: 5000, bodyDownloadLimit: 200, maxAIProcessingEmails: 50 });
    expect(getMaxEmailsPerFolder()).toBe(5000);
    expect(getBodyDownloadLimit()).toBe(200);
    expect(getMaxAIProcessingEmails()).toBe(50);
  });

  it('falls back to the defaults on 0/absent values and corrupt settings', () => {
    writeSettings({ maxEmailsPerFolder: 0, bodyDownloadLimit: 0, maxAIProcessingEmails: 0 });
    expect(getMaxEmailsPerFolder()).toBe(1000);
    expect(getBodyDownloadLimit()).toBe(1000);
    expect(getMaxAIProcessingEmails()).toBe(500);

    writeSettings('{not json');
    expect(getMaxEmailsPerFolder()).toBe(1000);
    expect(getBodyDownloadLimit()).toBe(1000);
    expect(getMaxAIProcessingEmails()).toBe(500);
  });
});

// ───────────────────────────── secrets ─────────────────────────────────────

describe('stripSecrets / extractSecrets', () => {
  // Passwords and OAuth tokens must never be written to localStorage in
  // plaintext; these two are the seam that keeps them in the vault instead.
  it('removes password, accessToken and refreshToken, keeping everything else', () => {
    const cfg = { host: 'imap.x.com', username: 'a@x.com', password: 'p', accessToken: 'at', refreshToken: 'rt', port: 993 };
    expect(stripSecrets(cfg)).toEqual({ host: 'imap.x.com', username: 'a@x.com', port: 993 });
  });

  it('does not mutate the caller\'s config (the in-memory copy keeps its secrets)', () => {
    const cfg = { host: 'h', password: 'p' };
    stripSecrets(cfg);
    expect(cfg.password).toBe('p');
  });

  it('passes null/undefined straight through', () => {
    expect(stripSecrets(null)).toBeNull();
    expect(stripSecrets(undefined)).toBeUndefined();
  });

  it('extracts only the secret fields, and undefined when there are none', () => {
    expect(extractSecrets({ host: 'h', password: 'p', refreshToken: 'rt' })).toEqual({ password: 'p', refreshToken: 'rt' });
    expect(extractSecrets({ host: 'h' })).toBeUndefined();
    expect(extractSecrets(null)).toBeUndefined();
  });

  it('treats an empty-string secret as absent (no pointless vault write)', () => {
    expect(extractSecrets({ password: '', accessToken: '' })).toBeUndefined();
  });
});

describe('fetchVaultSecrets', () => {
  // Legacy accounts may have their secret filed under the host-less id or the
  // host-suffixed one, so a reconnect has to try both — otherwise the user is
  // asked to re-enter a password that IS stored.
  it('returns null when the vault bridge is unavailable', async () => {
    installElectronAPI({});
    await expect(fetchVaultSecrets(['acct-a'])).resolves.toBeNull();
  });

  it('returns the first candidate id that has secrets', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: {} }) // present but empty ⇒ keep looking
      .mockResolvedValueOnce({ success: true, data: { imap: { password: 'p' } } });
    installElectronAPI({ secureCreds: { get } });
    await expect(fetchVaultSecrets(['acct-a', 'acct-a--imap-x-com'])).resolves.toEqual({ imap: { password: 'p' } });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('skips nullish ids and never queries the same id twice', async () => {
    const get = vi.fn().mockResolvedValue({ success: false });
    installElectronAPI({ secureCreds: { get } });
    await fetchVaultSecrets([null, undefined, 'acct-a', 'acct-a', '']);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('acct-a');
  });

  it('moves on to the next candidate when one lookup throws', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValueOnce({ success: true, data: { smtp: { password: 'p' } } });
    installElectronAPI({ secureCreds: { get } });
    await expect(fetchVaultSecrets(['bad', 'good'])).resolves.toEqual({ smtp: { password: 'p' } });
  });

  it('returns null when no candidate holds anything', async () => {
    installElectronAPI({ secureCreds: { get: vi.fn().mockResolvedValue({ success: true, data: null }) } });
    await expect(fetchVaultSecrets(['a', 'b'])).resolves.toBeNull();
  });
});

describe('migrateCredentialsToVault', () => {
  it('does nothing when the vault bridge is unavailable', async () => {
    installElectronAPI({});
    await expect(migrateCredentialsToVault([account()])).resolves.toBeUndefined();
  });

  it('vaults each account\'s secrets, then strips plaintext from localStorage', async () => {
    const set = vi.fn().mockResolvedValue({ success: true });
    installElectronAPI({ secureCreds: { set } });
    const withSecret = account({
      imapConfig: { host: 'imap.x.com', username: 'a@x.com', password: 'imap-pw' },
      smtpConfig: { host: 'smtp.x.com', port: 465, secure: true, username: 'a@x.com', password: 'smtp-pw' },
    });

    await migrateCredentialsToVault([withSecret]);

    expect(set).toHaveBeenCalledWith(withSecret.id, { imap: { password: 'imap-pw' }, smtp: { password: 'smtp-pw' } });
    // localStorage now holds the STRIPPED snapshot.
    const stored = JSON.parse(localStorage.getItem('sarvinbox-accounts')!);
    expect(stored[0].imapConfig.password).toBeUndefined();
    expect(stored[0].smtpConfig.password).toBeUndefined();
  });

  it('skips accounts with nothing to vault', async () => {
    const set = vi.fn().mockResolvedValue({ success: true });
    installElectronAPI({ secureCreds: { set } });
    await migrateCredentialsToVault([account()]);
    expect(set).not.toHaveBeenCalled();
  });

  it('files a legacy single-account secret under the MATCHING registry id', async () => {
    // The matching account's id may predate host-keying; storing under the
    // derived id instead would hide the secret from rehydration.
    const set = vi.fn().mockResolvedValue({ success: true });
    installElectronAPI({ secureCreds: { set } });
    localStorage.setItem('sarvinbox-credentials', JSON.stringify({ host: 'imap.x.com', username: 'a@x.com', password: 'legacy-pw' }));
    const legacyIdAccount = account({ id: 'acct-a-x-com' }); // host-less legacy id

    await migrateCredentialsToVault([legacyIdAccount]);

    expect(set).toHaveBeenCalledWith('acct-a-x-com', { imap: { password: 'legacy-pw' }, smtp: undefined });
  });

  it('derives the id when no registry account matches the legacy credentials', async () => {
    const set = vi.fn().mockResolvedValue({ success: true });
    installElectronAPI({ secureCreds: { set } });
    localStorage.setItem('sarvinbox-credentials', JSON.stringify({ host: 'imap.other.com', username: 'z@y.com', password: 'pw' }));

    await migrateCredentialsToVault([]);

    expect(set).toHaveBeenCalledWith(accountIdFor('z@y.com', 'imap.other.com'), { imap: { password: 'pw' }, smtp: undefined });
  });

  it('LEAVES plaintext in place when any vault write failed (never strip on a half-migration)', async () => {
    // A disk failure must never leave localStorage stripped AND the vault empty —
    // that is unrecoverable credential loss.
    installElectronAPI({ secureCreds: { set: vi.fn().mockResolvedValue({ success: false }) } });
    localStorage.setItem('sarvinbox-accounts', JSON.stringify([{ id: 'x', imapConfig: { password: 'still-here' } }]));
    await migrateCredentialsToVault([account({ imapConfig: { host: 'h', username: 'u', password: 'pw' } })]);
    expect(localStorage.getItem('sarvinbox-accounts')).toContain('still-here');
  });

  it('never rejects, even when the whole migration blows up', async () => {
    // It runs unattended at startup; an unhandled rejection here would surface
    // as a broken launch rather than a retried migration next time.
    installElectronAPI({ secureCreds: { set: vi.fn() } });
    await expect(migrateCredentialsToVault(null as unknown as StoredAccount[])).resolves.toBeUndefined();
  });

  it('treats a THROWING vault write the same as a failure', async () => {
    installElectronAPI({ secureCreds: { set: vi.fn().mockRejectedValue(new Error('keychain locked')) } });
    localStorage.setItem('sarvinbox-accounts', JSON.stringify([{ id: 'x', imapConfig: { password: 'still-here' } }]));
    await migrateCredentialsToVault([account({ imapConfig: { host: 'h', username: 'u', password: 'pw' } })]);
    expect(localStorage.getItem('sarvinbox-accounts')).toContain('still-here');
  });
});

// ─────────────────────── legacy credential storage ─────────────────────────

describe('legacy credential localStorage helpers', () => {
  it('round-trips IMAP credentials with the secrets stripped on write', () => {
    saveCredentials({ host: 'imap.x.com', username: 'a@x.com', password: 'secret' });
    expect(localStorage.getItem('sarvinbox-credentials')).not.toContain('secret');
    expect(loadSavedCredentials()).toEqual({ host: 'imap.x.com', username: 'a@x.com' });
  });

  it('returns null when there are no stored / parseable credentials', () => {
    expect(loadSavedCredentials()).toBeNull();
    localStorage.setItem('sarvinbox-credentials', '{not json');
    expect(loadSavedCredentials()).toBeNull();
  });

  it('clears IMAP credentials', () => {
    saveCredentials({ host: 'h', username: 'u' });
    clearCredentials();
    expect(loadSavedCredentials()).toBeNull();
  });

  it('round-trips + clears SMTP credentials, also stripping secrets', () => {
    saveSmtpCredentials({ host: 'smtp.x.com', port: 465, secure: true, username: 'a@x.com', password: 'secret' });
    expect(localStorage.getItem('sarvinbox-smtp-credentials')).not.toContain('secret');
    expect(loadSavedSmtpCredentials()).toMatchObject({ host: 'smtp.x.com', port: 465 });
    clearSmtpCredentials();
    expect(loadSavedSmtpCredentials()).toBeNull();
  });

  it('returns null for corrupt SMTP credentials', () => {
    localStorage.setItem('sarvinbox-smtp-credentials', '{not json');
    expect(loadSavedSmtpCredentials()).toBeNull();
  });

  it('survives a localStorage that throws on every operation', () => {
    // A stripped/locked renderer (or a quota error) must never take the app down
    // on a credential read/write — every one of these is try/catch-wrapped.
    (globalThis as any).localStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(loadSavedCredentials()).toBeNull();
    expect(loadSavedSmtpCredentials()).toBeNull();
    expect(loadSmtpConfigured()).toBe(false);
    expect(loadAccounts()).toEqual([]);
    expect(loadActiveAccountId()).toBeNull();
    expect(() => saveCredentials({ host: 'h' })).not.toThrow();
    expect(() => saveSmtpCredentials({ host: 'h', port: 1, secure: true, username: 'u', password: '' })).not.toThrow();
    expect(() => saveSmtpConfigured(true)).not.toThrow();
    expect(() => saveSmtpConfigured(false)).not.toThrow();
    expect(() => clearCredentials()).not.toThrow();
    expect(() => clearSmtpCredentials()).not.toThrow();
    expect(() => saveAccounts([account()])).not.toThrow();
    expect(() => saveActiveAccountId('a')).not.toThrow();
    expect(() => saveActiveAccountId(null)).not.toThrow();
    expect(loadQuotaCache()).toEqual({});
    expect(() => saveQuotaCache({ a: { used: 1, limit: 2 } })).not.toThrow();
  });

  // The quota cache is what keeps the sidebar's storage row populated across an
  // account switch and a cold start. Garbage in it renders as "NaN of NaN", so
  // the read filters rather than trusts.
  it('round-trips the quota cache and drops corrupt entries', () => {
    saveQuotaCache({ gmail: { used: 5, limit: 10 }, sarv: null });
    expect(loadQuotaCache()).toEqual({ gmail: { used: 5, limit: 10 }, sarv: null });

    // null survives on purpose: it means "asked, no quota advertised", which is
    // what stops the placeholder row from reappearing on every refresh.
    localStorage.setItem('sarvinbox-quota-cache', JSON.stringify({
      good: { used: 1, limit: 2 },
      answeredEmpty: null,
      nanUsed: { used: 'x', limit: 2 },
      missingLimit: { used: 1 },
      notAnObject: 7,
    }));
    expect(loadQuotaCache()).toEqual({ good: { used: 1, limit: 2 }, answeredEmpty: null });
  });

  it('returns an empty cache for unparseable or non-object stored values', () => {
    localStorage.setItem('sarvinbox-quota-cache', '{not json');
    expect(loadQuotaCache()).toEqual({});
    localStorage.setItem('sarvinbox-quota-cache', '"a string"');
    expect(loadQuotaCache()).toEqual({});
    localStorage.removeItem('sarvinbox-quota-cache');
    expect(loadQuotaCache()).toEqual({});
  });

  it('round-trips the smtpConfigured flag, removing the key on false', () => {
    expect(loadSmtpConfigured()).toBe(false);
    saveSmtpConfigured(true);
    expect(loadSmtpConfigured()).toBe(true);
    saveSmtpConfigured(false);
    expect(localStorage.getItem('sarvinbox-smtp-configured')).toBeNull();
    expect(loadSmtpConfigured()).toBe(false);
  });
});

// ────────────────────────────── SMTP derivation ────────────────────────────

describe('deriveSmtpFromImap', () => {
  // Prefills the SMTP setup form. The password is deliberately NOT carried over
  // (an SMTP password can differ from the IMAP one).
  it('maps the known providers to their SMTP host', () => {
    expect(deriveSmtpFromImap({ host: 'imap.gmail.com', username: 'a@gmail.com' }).host).toBe('smtp.gmail.com');
    expect(deriveSmtpFromImap({ host: 'imap.googlemail.com', username: 'a@x' }).host).toBe('smtp.gmail.com');
    expect(deriveSmtpFromImap({ host: 'outlook.office365.com', username: 'a@x' }).host).toBe('smtp.office365.com');
    expect(deriveSmtpFromImap({ host: 'imap-mail.outlook.com', username: 'a@x' }).host).toBe('smtp.office365.com');
    expect(deriveSmtpFromImap({ host: 'imap.mail.yahoo.com', username: 'a@x' }).host).toBe('smtp.mail.yahoo.com');
    expect(deriveSmtpFromImap({ host: 'imap.mail.me.com', username: 'a@x' }).host).toBe('smtp.mail.me.com');
    expect(deriveSmtpFromImap({ host: 'imap.icloud.com', username: 'a@x' }).host).toBe('smtp.mail.me.com');
  });

  it('rewrites a generic imap.<domain> to smtp.<domain>', () => {
    expect(deriveSmtpFromImap({ host: 'imap.sarv.com', username: 'a@sarv.com' }).host).toBe('smtp.sarv.com');
    expect(deriveSmtpFromImap({ host: 'IMAP.Sarv.com', username: 'a@sarv.com' }).host).toBe('smtp.Sarv.com');
  });

  it('leaves a host with no imap. prefix as-is', () => {
    expect(deriveSmtpFromImap({ host: 'mail.sarv.com', username: 'a@x' }).host).toBe('mail.sarv.com');
    expect(deriveSmtpFromImap({ host: '', username: 'a@x' }).host).toBe('');
  });

  it('defaults to implicit TLS on 465 and never carries the password over', () => {
    const smtp = deriveSmtpFromImap({ host: 'imap.sarv.com', username: 'a@sarv.com' });
    expect(smtp).toMatchObject({ port: 465, secure: true, username: 'a@sarv.com', password: '', from: 'a@sarv.com' });
  });

  it('carries the auth method + OAuth provider through', () => {
    const smtp = deriveSmtpFromImap({ host: 'imap.gmail.com', username: 'a@gmail.com', authMethod: 'oauth2', oauthProvider: 'gmail' });
    expect(smtp.authMethod).toBe('oauth2');
    expect(smtp.oauthProvider).toBe('gmail');
  });
});

describe('effectiveSmtpConfig', () => {
  // The single source of the "Gmail account shows smtp.sarv.com" fix: an OAuth
  // account's sending config is DERIVED, never read from a stored password
  // config that another same-address account may have written onto it.
  it('always derives for an OAuth account, ignoring any stored SMTP', () => {
    const acct = account({
      imapConfig: { host: 'imap.gmail.com', username: 'a@gmail.com', authMethod: 'oauth2', oauthProvider: 'gmail' },
      smtpConfig: { host: 'smtp.sarv.com', port: 465, secure: true, username: 'a@gmail.com', password: 'x' },
      smtpConfigured: true,
    });
    expect(effectiveSmtpConfig(acct)).toMatchObject({ host: 'smtp.gmail.com', authMethod: 'oauth2', oauthProvider: 'gmail' });
  });

  it('uses the stored config for a verified password account', () => {
    const smtp: SMTPConfig = { host: 'smtp.sarv.com', port: 587, secure: false, username: 'a@x.com', password: '' };
    expect(effectiveSmtpConfig(account({ smtpConfig: smtp, smtpConfigured: true }))).toBe(smtp);
  });

  it('returns null when sending has not been verified, or there is no stored config', () => {
    expect(effectiveSmtpConfig(account({ smtpConfig: { host: 'h', port: 1, secure: true, username: 'u', password: '' }, smtpConfigured: false }))).toBeNull();
    expect(effectiveSmtpConfig(account({ smtpConfig: null, smtpConfigured: true }))).toBeNull();
  });

  it('returns null for an account with no usable IMAP identity', () => {
    expect(effectiveSmtpConfig(null)).toBeNull();
    expect(effectiveSmtpConfig(undefined)).toBeNull();
    expect(effectiveSmtpConfig(account({ imapConfig: {} }))).toBeNull();
    expect(effectiveSmtpConfig(account({ imapConfig: { host: 'imap.x.com' } }))).toBeNull();
  });
});

// ───────────────────────── account registry / ids ──────────────────────────

describe('accountIdFor', () => {
  // MUST stay byte-identical to core's accountIdFor — the id keys the account's
  // DB file AND its vault entry, so any drift opens an empty database.
  it('normalises the email and suffixes the host', () => {
    expect(accountIdFor('Advik.D@Sarv.com', 'imap.sarv.com')).toBe('acct-advik-d-sarv-com--imap-sarv-com');
  });

  it('omits the host suffix when no host is known', () => {
    expect(accountIdFor('a@x.com')).toBe('acct-a-x-com');
    expect(accountIdFor('a@x.com', '')).toBe('acct-a-x-com');
  });

  it('collapses runs of non-alphanumerics and trims leading/trailing dashes', () => {
    expect(accountIdFor('  a..b@x_y.com  ', '--imap--')).toBe('acct-a-b-x-y-com--imap');
  });

  it('falls back to "default" for an empty email', () => {
    expect(accountIdFor('')).toBe('acct-default');
  });

  it('is stable across casing/whitespace variants of the same identity', () => {
    expect(accountIdFor(' A@X.com ', 'IMAP.X.com')).toBe(accountIdFor('a@x.com', 'imap.x.com'));
  });
});

describe('account display helpers', () => {
  const gmail = account({ id: 'g', email: 'a@x.com', imapConfig: { host: 'imap.gmail.com' } });
  const sarv = account({ id: 's', email: 'A@X.com', imapConfig: { host: 'imap.sarv.com' } });
  const solo = account({ id: 'o', email: 'b@x.com', imapConfig: { host: 'imap.sarv.com' } });

  it('reads the IMAP host, defaulting to an empty string', () => {
    expect(accountHost(gmail)).toBe('imap.gmail.com');
    expect(accountHost(account({ imapConfig: {} }))).toBe('');
    expect(accountHost(null)).toBe('');
    expect(accountHost(undefined)).toBe('');
  });

  it('detects a duplicated address case-insensitively', () => {
    // "a@x.com" via Gmail AND via Sarv — the host is what tells them apart.
    expect(isAccountEmailDuplicated([gmail, sarv, solo], 'a@x.com')).toBe(true);
    expect(isAccountEmailDuplicated([gmail, sarv, solo], 'A@X.COM')).toBe(true);
    expect(isAccountEmailDuplicated([gmail, sarv, solo], 'b@x.com')).toBe(false);
    expect(isAccountEmailDuplicated([gmail, sarv, solo], undefined)).toBe(false);
  });

  it('appends the host to the label ONLY when the address is ambiguous', () => {
    expect(accountDisplayLabel([gmail, sarv, solo], 'g')).toBe('a@x.com (imap.gmail.com)');
    expect(accountDisplayLabel([gmail, sarv, solo], 'o')).toBe('b@x.com');
  });

  it('returns an empty label for an unknown account id', () => {
    expect(accountDisplayLabel([gmail], 'missing')).toBe('');
    expect(accountDisplayLabel([], undefined)).toBe('');
  });

  it('omits the host suffix when the duplicated account has no host to show', () => {
    const a = account({ id: '1', email: 'a@x.com', imapConfig: {} });
    const b = account({ id: '2', email: 'a@x.com', imapConfig: { host: 'imap.x.com' } });
    expect(accountDisplayLabel([a, b], '1')).toBe('a@x.com');
  });
});

describe('findAccountByEmailHost', () => {
  // A reconnect must REUSE the stored account (its id → its DB), while the same
  // address on a different host stays a separate account.
  const gmail = account({ id: 'g', email: 'A@X.com', imapConfig: { host: 'IMAP.Gmail.com' } });
  const sarv = account({ id: 's', email: 'a@x.com', imapConfig: { host: 'imap.sarv.com' } });

  it('matches on email + host, ignoring case on both', () => {
    expect(findAccountByEmailHost([gmail, sarv], 'a@x.com', 'imap.gmail.com')?.id).toBe('g');
    expect(findAccountByEmailHost([gmail, sarv], 'A@X.COM', 'IMAP.SARV.COM')?.id).toBe('s');
  });

  it('does NOT match the same address on a different host', () => {
    expect(findAccountByEmailHost([gmail, sarv], 'a@x.com', 'imap.other.com')).toBeUndefined();
  });

  it('matches a host-less legacy account when no host is supplied', () => {
    const legacy = account({ id: 'l', email: 'a@x.com', imapConfig: {} });
    expect(findAccountByEmailHost([legacy], 'a@x.com')?.id).toBe('l');
    expect(findAccountByEmailHost([legacy], 'a@x.com', 'imap.x.com')).toBeUndefined();
  });

  it('returns undefined for an unknown address or an empty registry', () => {
    expect(findAccountByEmailHost([gmail], 'nobody@x.com', 'imap.gmail.com')).toBeUndefined();
    expect(findAccountByEmailHost([], 'a@x.com', 'h')).toBeUndefined();
  });
});

describe('loadAccounts / saveAccounts', () => {
  it('round-trips the registry', () => {
    saveAccounts([account({ id: 'a1' })]);
    expect(loadAccounts().map((a) => a.id)).toEqual(['a1']);
  });

  it('returns [] for missing, corrupt, or non-array stored data', () => {
    expect(loadAccounts()).toEqual([]);
    localStorage.setItem('sarvinbox-accounts', '{not json');
    expect(loadAccounts()).toEqual([]);
    localStorage.setItem('sarvinbox-accounts', '{"not":"an array"}');
    expect(loadAccounts()).toEqual([]);
  });

  it('strips IMAP + SMTP secrets before writing to disk', () => {
    saveAccounts([
      account({
        imapConfig: { host: 'h', username: 'u', password: 'imap-pw' },
        smtpConfig: { host: 'h', port: 465, secure: true, username: 'u', password: 'smtp-pw' },
      }),
    ]);
    const raw = localStorage.getItem('sarvinbox-accounts')!;
    expect(raw).not.toContain('imap-pw');
    expect(raw).not.toContain('smtp-pw');
  });

  it('mirrors the stripped snapshot into the durable DB registry', () => {
    // localStorage is the fallback; the DB registry is what survives a wipe.
    const save = vi.fn();
    installElectronAPI({ accounts: { save } });
    saveAccounts([account({ imapConfig: { host: 'h', username: 'u', password: 'pw' } })]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0][0].imapConfig.password).toBeUndefined();
  });

  it('survives a missing accounts bridge and a throwing mirror', () => {
    installElectronAPI({ accounts: { save: vi.fn(() => { throw new Error('no channel'); }) } });
    expect(() => saveAccounts([account()])).not.toThrow();
    expect(loadAccounts()).toHaveLength(1); // the localStorage write still happened
  });
});

describe('active account pointer', () => {
  it('round-trips the id and mirrors it to the durable registry', () => {
    const setActivePointer = vi.fn();
    installElectronAPI({ accounts: { setActivePointer } });
    saveActiveAccountId('acct-a');
    expect(loadActiveAccountId()).toBe('acct-a');
    expect(setActivePointer).toHaveBeenCalledWith('acct-a');
  });

  it('removes the key when set to null', () => {
    saveActiveAccountId('acct-a');
    saveActiveAccountId(null);
    expect(loadActiveAccountId()).toBeNull();
  });

  it('returns null when nothing is stored', () => {
    expect(loadActiveAccountId()).toBeNull();
  });
});

describe('upsertAccount / removeAccount', () => {
  it('appends a new account and persists', () => {
    const next = upsertAccount([], account({ id: 'a1', color: undefined }));
    expect(next).toHaveLength(1);
    expect(next[0].color).toBeTruthy(); // normalised on the way in
    expect(loadAccounts()).toHaveLength(1);
  });

  it('replaces in place by id, PRESERVING the existing color and preference flags', () => {
    // A reconnect must not reshuffle the account's dot color or silently
    // re-enable a sync/notify toggle the user turned off.
    const existing = account({ id: 'a1', color: '#16a34a', notify: false, backgroundSync: false });
    const next = upsertAccount([existing, account({ id: 'a2', color: '#dc2626' })], {
      id: 'a1',
      email: 'new@x.com',
      imapConfig: { host: 'imap.x.com', username: 'new@x.com' },
      smtpConfig: null,
      smtpConfigured: false,
    });
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ id: 'a1', email: 'new@x.com', color: '#16a34a', notify: false, backgroundSync: false });
    expect(next[1].id).toBe('a2');
  });

  it('removes by id and persists, ignoring an unknown id', () => {
    const list = [account({ id: 'a1' }), account({ id: 'a2' })];
    expect(removeAccount(list, 'a1').map((a) => a.id)).toEqual(['a2']);
    expect(removeAccount(list, 'nope')).toHaveLength(2);
    expect(loadAccounts().map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('account colors', () => {
  it('uses the curated palette for the first accounts', () => {
    expect(accountColorForIndex(0)).toBe(ACCOUNT_COLORS[0]);
    expect(accountColorForIndex(ACCOUNT_COLORS.length - 1)).toBe(ACCOUNT_COLORS.at(-1));
  });

  it('GENERATES a color beyond the palette so any number of accounts stays distinct', () => {
    // No wrap/repeat: the 16th account must not reuse the 1st account's dot.
    const generated = accountColorForIndex(ACCOUNT_COLORS.length);
    expect(generated).toMatch(/^#[0-9a-f]{6}$/);
    expect(ACCOUNT_COLORS).not.toContain(generated);
  });

  it('keeps generated colors distinct from each other (golden-angle hue walk)', () => {
    const generated = Array.from({ length: 25 }, (_, i) => accountColorForIndex(ACCOUNT_COLORS.length + i));
    expect(new Set(generated).size).toBe(generated.length);
  });

  it('is deterministic for a given index', () => {
    expect(accountColorForIndex(30)).toBe(accountColorForIndex(30));
  });

  it('picks the LOWEST unused color, so a removed account\'s color is reused first', () => {
    expect(pickAccountColor([])).toBe(ACCOUNT_COLORS[0]);
    expect(pickAccountColor([account({ color: ACCOUNT_COLORS[0] })])).toBe(ACCOUNT_COLORS[1]);
    // Account 0's color was freed by a removal ⇒ reuse it rather than minting new.
    expect(pickAccountColor([account({ color: ACCOUNT_COLORS[1] })])).toBe(ACCOUNT_COLORS[0]);
  });

  it('ignores accounts with no color yet when picking', () => {
    expect(pickAccountColor([account({ color: undefined })])).toBe(ACCOUNT_COLORS[0]);
  });

  it('generates a fresh color once every palette entry is taken', () => {
    const all = ACCOUNT_COLORS.map((c) => account({ color: c }));
    const picked = pickAccountColor(all);
    expect(ACCOUNT_COLORS).not.toContain(picked);
    expect(picked).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('normalizeAccount', () => {
  it('backfills a color and defaults the preference flags to enabled', () => {
    // Legacy (pre-multi-account) rows have none of these; they must behave the
    // way they always did rather than silently switching sync/notify off.
    const n = normalizeAccount({
      id: 'a1',
      email: 'a@x.com',
      imapConfig: { host: 'h', username: 'u' },
      smtpConfig: null,
      smtpConfigured: false,
    });
    expect(n.color).toBe(ACCOUNT_COLORS[0]);
    expect(n).toMatchObject({ includeInUnified: true, backgroundSync: true, notify: true });
  });

  it('preserves explicitly-disabled flags and an assigned color', () => {
    const n = normalizeAccount(account({ color: '#123456', includeInUnified: false, backgroundSync: false, notify: false }));
    expect(n).toMatchObject({ color: '#123456', includeInUnified: false, backgroundSync: false, notify: false });
  });

  it('backfills identities to the account address and normalises aliases', () => {
    // Regression: a legacy account (no identities) must still be able to send as
    // itself; configured aliases must be canonicalised (own address first, deduped)
    // so the compose From picker and the alias editor see the same list.
    expect(normalizeAccount(account({ email: 'me@x.com', identities: undefined })).identities).toEqual(['me@x.com']);
    expect(normalizeAccount(account({ email: 'Me@x.com', identities: ['me@x.com', 'ALIAS@x.com', 'alias@x.com'] })).identities)
      .toEqual(['Me@x.com', 'ALIAS@x.com']);
  });

  it('avoids colliding with the colors already used by other accounts', () => {
    const n = normalizeAccount(account({ color: undefined }), [account({ color: ACCOUNT_COLORS[0] })]);
    expect(n.color).toBe(ACCOUNT_COLORS[1]);
  });

  it('SELF-HEALS a crossed SMTP config on an OAuth account', () => {
    // The reported bug: a smtp.sarv.com password config leaking onto a Gmail
    // account that shares the address. normalizeAccount runs on load and on
    // every upsert, so the wrong value is rewritten, not merely ignored.
    const n = normalizeAccount(
      account({
        imapConfig: { host: 'imap.gmail.com', username: 'a@gmail.com', authMethod: 'oauth2', oauthProvider: 'gmail' },
        smtpConfig: { host: 'smtp.sarv.com', port: 465, secure: true, username: 'a@gmail.com', password: 'leaked' },
        smtpConfigured: false,
      }),
    );
    expect(n.smtpConfig).toMatchObject({ host: 'smtp.gmail.com', authMethod: 'oauth2' });
    expect(n.smtpConfigured).toBe(true);
  });

  it('DROPS a leftover oauth2 SMTP config when the account is no longer oauth2', () => {
    // Otherwise SmtpConnector attempts a doomed token-less connect on every
    // IMAP connect; showing sending as un-set-up is the truth.
    const n = normalizeAccount(
      account({
        imapConfig: { host: 'imap.sarv.com', username: 'a@sarv.com', authMethod: 'password' },
        smtpConfig: { host: 'smtp.sarv.com', port: 465, secure: true, username: 'a@sarv.com', password: '', authMethod: 'oauth2' },
        smtpConfigured: true,
      }),
    );
    expect(n.smtpConfig).toBeNull();
    expect(n.smtpConfigured).toBe(false);
  });

  it('leaves a normal password account\'s SMTP config alone', () => {
    const smtp: SMTPConfig = { host: 'smtp.x.com', port: 587, secure: false, username: 'u', password: '' };
    const n = normalizeAccount(account({ smtpConfig: smtp, smtpConfigured: true }));
    expect(n.smtpConfig).toBe(smtp);
    expect(n.smtpConfigured).toBe(true);
  });

  it('does not crash on an OAuth account whose IMAP identity is incomplete', () => {
    const n = normalizeAccount(account({ imapConfig: { authMethod: 'oauth2' }, smtpConfig: null }));
    expect(n.smtpConfig).toBeNull();
  });
});

describe('migrateAccounts', () => {
  it('returns an empty registry when there is nothing to migrate', () => {
    expect(migrateAccounts()).toEqual({ accounts: [], activeAccountId: null });
  });

  it('normalises + persists an existing registry, keeping a valid active id', () => {
    localStorage.setItem('sarvinbox-accounts', JSON.stringify([{ id: 'a1', email: 'a@x.com', imapConfig: { host: 'h' } }]));
    saveActiveAccountId('a1');
    const { accounts, activeAccountId } = migrateAccounts();
    expect(activeAccountId).toBe('a1');
    expect(accounts[0].color).toBeTruthy();
    expect(accounts[0].notify).toBe(true);
  });

  it('falls back to the first account when the stored active id is stale', () => {
    localStorage.setItem('sarvinbox-accounts', JSON.stringify([{ id: 'a1' }, { id: 'a2' }]));
    saveActiveAccountId('deleted');
    expect(migrateAccounts().activeAccountId).toBe('a1');
  });

  it('assigns DISTINCT colors when backfilling several colorless accounts', () => {
    // The reduce threads the accumulated list into normalizeAccount precisely so
    // two backfilled accounts can't get the same dot.
    localStorage.setItem('sarvinbox-accounts', JSON.stringify([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]));
    const { accounts } = migrateAccounts();
    expect(new Set(accounts.map((a) => a.color)).size).toBe(3);
  });

  it('writes the migrated registry back WITHOUT stripping secrets (the vault has not run yet)', () => {
    // Stripping at module load would drop the secrets from disk before they are
    // safely vaulted — unrecoverable credential loss.
    localStorage.setItem(
      'sarvinbox-accounts',
      JSON.stringify([{ id: 'a1', email: 'a@x.com', imapConfig: { host: 'h', username: 'u', password: 'keep-me' } }]),
    );
    migrateAccounts();
    expect(localStorage.getItem('sarvinbox-accounts')).toContain('keep-me');
  });

  it('promotes the legacy single account into the registry and activates it', () => {
    localStorage.setItem('sarvinbox-credentials', JSON.stringify({ host: 'imap.sarv.com', username: 'a@sarv.com' }));
    localStorage.setItem('sarvinbox-smtp-configured', 'true');
    const { accounts, activeAccountId } = migrateAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(accountIdFor('a@sarv.com', 'imap.sarv.com'));
    expect(accounts[0].email).toBe('a@sarv.com');
    expect(accounts[0].smtpConfigured).toBe(true);
    expect(activeAccountId).toBe(accounts[0].id);
    expect(loadActiveAccountId()).toBe(accounts[0].id); // persisted
  });

  it('ignores legacy credentials that have no username', () => {
    localStorage.setItem('sarvinbox-credentials', JSON.stringify({ host: 'imap.sarv.com' }));
    expect(migrateAccounts()).toEqual({ accounts: [], activeAccountId: null });
  });
});

describe('canonicalizeAccountIds', () => {
  // Rewrites legacy `acct-<email>` ids to `acct-<email>--<host>` and asks main to
  // move the id-keyed DB/vault first. Must be idempotent and must NEVER lose an
  // account when the rekey fails.
  it('returns null when there is nothing to canonicalize', async () => {
    await expect(canonicalizeAccountIds()).resolves.toBeNull();

    saveAccounts([account({ id: accountIdFor('a@x.com', 'imap.x.com') })]);
    await expect(canonicalizeAccountIds()).resolves.toBeNull(); // already canonical ⇒ no-op
  });

  it('rekeys a legacy id and moves the active pointer with it', async () => {
    const rekey = vi.fn().mockResolvedValue({ success: true });
    installElectronAPI({ accounts: { rekey } });
    saveAccounts([account({ id: 'acct-a-x-com', email: 'a@x.com', imapConfig: { host: 'imap.x.com', username: 'a@x.com' } })]);
    saveActiveAccountId('acct-a-x-com');

    const result = await canonicalizeAccountIds();

    const canonical = accountIdFor('a@x.com', 'imap.x.com');
    expect(rekey).toHaveBeenCalledWith('acct-a-x-com', canonical);
    expect(result?.accounts[0].id).toBe(canonical);
    expect(result?.activeAccountId).toBe(canonical);
    expect(loadAccounts()[0].id).toBe(canonical); // persisted for the next launch
  });

  it('KEEPS the legacy id when the rekey fails, so nobody is locked out', async () => {
    // First account's rekey fails, second succeeds.
    const rekey = vi.fn().mockResolvedValueOnce({ success: false, error: 'db busy' }).mockResolvedValue({ success: true });
    installElectronAPI({ accounts: { rekey } });
    saveAccounts([
      account({ id: 'acct-a-x-com', email: 'a@x.com', imapConfig: { host: 'imap.x.com', username: 'a@x.com' } }),
      account({ id: 'acct-b-x-com', email: 'b@x.com', imapConfig: { host: 'imap.x.com', username: 'b@x.com' } }),
    ]);

    const result = await canonicalizeAccountIds();

    // The second account still canonicalized, so the batch reports a change.
    expect(result?.accounts.map((a) => a.id)).toEqual(['acct-a-x-com', accountIdFor('b@x.com', 'imap.x.com')]);
  });

  it('treats a THROWING rekey the same as a failure', async () => {
    installElectronAPI({ accounts: { rekey: vi.fn().mockRejectedValue(new Error('boom')) } });
    saveAccounts([account({ id: 'acct-a-x-com', email: 'a@x.com', imapConfig: { host: 'imap.x.com', username: 'a@x.com' } })]);
    await expect(canonicalizeAccountIds()).resolves.toBeNull(); // nothing changed
    expect(loadAccounts()[0].id).toBe('acct-a-x-com');
  });

  it('leaves an account with an UNKNOWN host untouched (email+host is the target)', async () => {
    const rekey = vi.fn();
    installElectronAPI({ accounts: { rekey } });
    saveAccounts([account({ id: 'acct-a-x-com', email: 'a@x.com', imapConfig: {} })]);
    await expect(canonicalizeAccountIds()).resolves.toBeNull();
    expect(rekey).not.toHaveBeenCalled();
  });

  it('falls back to the account email when imapConfig has no username', async () => {
    const rekey = vi.fn().mockResolvedValue({ success: true });
    installElectronAPI({ accounts: { rekey } });
    saveAccounts([account({ id: 'legacy', email: 'a@x.com', imapConfig: { host: 'imap.x.com' } })]);
    await canonicalizeAccountIds();
    expect(rekey).toHaveBeenCalledWith('legacy', accountIdFor('a@x.com', 'imap.x.com'));
  });
});

// ─────────────────────────── view + inbox settings ─────────────────────────

describe('view mode', () => {
  it('defaults to no-split and round-trips a valid mode', () => {
    expect(loadSavedViewMode()).toBe('no-split');
    saveViewMode('vertical');
    expect(loadSavedViewMode()).toBe('vertical');
    saveViewMode('horizontal');
    expect(loadSavedViewMode()).toBe('horizontal');
  });

  it('ignores an unrecognised stored mode rather than rendering an unknown layout', () => {
    localStorage.setItem('sarvinbox-view-mode', 'diagonal');
    expect(loadSavedViewMode()).toBe('no-split');
  });

  it('survives a throwing localStorage on read and write', () => {
    (globalThis as any).localStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(loadSavedViewMode()).toBe('no-split');
    expect(() => saveViewMode('vertical')).not.toThrow();
  });
});

describe('loadInboxSettings', () => {
  it('defaults to priority_first with its default sections', () => {
    expect(loadInboxSettings()).toEqual({
      inboxType: 'priority_first',
      showImportanceMarkers: true,
      inboxSections: DEFAULT_SECTIONS.priority_first,
    });
  });

  it('derives the default sections for a stored inbox type that has none saved', () => {
    writeSettings({ inboxType: 'unread_first' });
    expect(loadInboxSettings().inboxSections).toEqual(DEFAULT_SECTIONS.unread_first);
  });

  it('prefers the user\'s CUSTOMISED sections over the type defaults', () => {
    const custom = [{ id: 'c1', filter: 'starred', maxItems: 5, hideWhenEmpty: true }];
    writeSettings({ inboxType: 'priority_first', inboxSections: custom });
    expect(loadInboxSettings().inboxSections).toEqual(custom);
  });

  it('uses NO sections for the flat "default" inbox type', () => {
    writeSettings({ inboxType: 'default' });
    expect(loadInboxSettings().inboxSections).toEqual([]);
  });

  it('respects an explicit showImportanceMarkers:false', () => {
    writeSettings({ showImportanceMarkers: false });
    expect(loadInboxSettings().showImportanceMarkers).toBe(false);
    writeSettings({ showImportanceMarkers: 'yes' }); // non-boolean ⇒ default
    expect(loadInboxSettings().showImportanceMarkers).toBe(true);
  });

  it('returns [] for an inbox type with no default layout', () => {
    writeSettings({ inboxType: 'made_up' });
    expect(loadInboxSettings().inboxSections).toEqual([]);
  });

  it('falls back to the defaults on corrupt settings', () => {
    writeSettings('{not json');
    expect(loadInboxSettings().inboxType).toBe('priority_first');
  });
});

// ────────────────────── AI categorization listeners ────────────────────────

describe('setupAICategorizationListeners', () => {
  type Handlers = Record<string, (payload?: any) => void>;

  const setup = () => {
    const handlers: Handlers = {};
    const capture = (name: string) => vi.fn((cb: (p?: any) => void) => { handlers[name] = cb; });
    const store = {
      setState: vi.fn(),
      getState: vi.fn(() => state),
    };
    const state: Record<string, any> = {
      emails: [],
      threadEmails: [],
      searchResults: [],
      folders: [],
      selectedFolderId: null,
      viewingAICategory: null,
      _reloadCurrentView: vi.fn(),
      loadFolders: vi.fn(),
      removeDraftFromViews: vi.fn(),
    };
    installElectronAPI({
      aiCategorization: {
        onProgress: capture('progress'),
        onComplete: capture('complete'),
        onError: capture('error'),
        onLog: capture('log'),
      },
      agent: {
        onEmailProcessed: capture('emailProcessed'),
        onPipelineAIStatus: capture('pipelineStatus'),
        onDraftReady: capture('draftReady'),
      },
      drafts: { onRemoved: capture('draftsRemoved') },
    });
    setupAICategorizationListeners(store);
    return { handlers, store, state };
  };

  it('does nothing without the aiCategorization bridge (no crash on a bare window)', () => {
    installElectronAPI({});
    expect(() => setupAICategorizationListeners({ setState: vi.fn(), getState: vi.fn() })).not.toThrow();
    delete (globalThis as any).window;
    expect(() => setupAICategorizationListeners({ setState: vi.fn(), getState: vi.fn() })).not.toThrow();
  });

  it('clears the badge cache on progress so new tags become visible', () => {
    const { handlers, store } = setup();
    handlers.progress({ processed: 3, total: 10 });
    expect(clearCategoryBadgeCache).toHaveBeenCalled();
    expect(store.setState).toHaveBeenCalledWith(expect.objectContaining({ aiProcessingProgress: { processed: 3, total: 10 } }));
  });

  it('on completion clears the flags, reloads the view, and marks AI healthy when the run was ok', () => {
    // A run that finished without a terminal failure proves the provider works —
    // leaving the stale "AI inactive" banner up is the bug this prevents.
    const { handlers, store, state } = setup();
    handlers.complete({ ok: true });
    expect(store.setState).toHaveBeenCalledWith(expect.objectContaining({ aiProcessing: false, aiProcessingProgress: null }));
    expect(reportAIHealthy).toHaveBeenCalled();
    expect(state._reloadCurrentView).toHaveBeenCalled();
  });

  it('does not mark AI healthy for a completion that was not ok', () => {
    const { handlers } = setup();
    handlers.complete({ ok: false });
    expect(reportAIHealthy).not.toHaveBeenCalled();
  });

  it('surfaces the AI-inactive banner ONLY for a terminal error', () => {
    // Transient failures are auto-restarted by main; banner-ing them would train
    // the user to ignore the banner.
    const { handlers } = setup();
    handlers.error({ terminal: false, message: 'timeout' });
    expect(reportAIUnhealthy).not.toHaveBeenCalled();

    handlers.error({ terminal: true, reason: 'invalid key', status: 401 });
    expect(reportAIUnhealthy).toHaveBeenCalledWith('invalid key', 401);
  });

  it('falls back through reason → message → a generic string for a terminal error', () => {
    const { handlers } = setup();
    handlers.error({ terminal: true, message: 'no credits' });
    expect(reportAIUnhealthy).toHaveBeenCalledWith('no credits', undefined);
    handlers.error({ terminal: true });
    expect(reportAIUnhealthy).toHaveBeenCalledWith('AI is unavailable.', undefined);
  });

  it('applies a live per-email categorization to the row in place, then debounces the count refresh', async () => {
    vi.useFakeTimers();
    try {
      const { handlers, store, state } = setup();
      handlers.emailProcessed({ emailId: 'e1', categories: ['work'] });
      handlers.emailProcessed({ emailId: 'e2' }); // no categories ⇒ empty list

      expect(applyEmailCategories).toHaveBeenCalledWith('e1', ['work']);
      expect(applyEmailCategories).toHaveBeenCalledWith('e2', []);
      store.setState.mockClear();

      vi.advanceTimersByTime(600);
      // Coalesced: a burst of categorizations refreshes the counts ONCE.
      expect(store.setState).toHaveBeenCalledTimes(1);
      expect(state._reloadCurrentView).not.toHaveBeenCalled(); // not viewing a category tab
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds the list on a live categorization only while a category tab is active', () => {
    vi.useFakeTimers();
    try {
      const { handlers, state } = setup();
      state.viewingAICategory = 'work';
      handlers.emailProcessed({ emailId: 'e1', categories: ['work'] });
      vi.advanceTimersByTime(600);
      expect(state._reloadCurrentView).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a live categorization event with no email id', () => {
    const { handlers } = setup();
    handlers.emailProcessed({});
    expect(applyEmailCategories).not.toHaveBeenCalled();
  });

  it('clears the AI banner when the background pipeline reports AI is available', () => {
    const { handlers } = setup();
    handlers.pipelineStatus({ available: true });
    expect(reportAIHealthy).toHaveBeenCalled();
    expect(syncAIProviderToMain).not.toHaveBeenCalled();
  });

  it('SELF-HEALS by re-pushing the provider when the pipeline lost a configured one', () => {
    // A main-process restart wipes the pipeline's in-memory config and the
    // already-mounted renderer never re-pushes — this is that silent-failure gap.
    vi.mocked(getDefaultProvider).mockReturnValue({ id: 'anthropic' } as unknown as never);
    const { handlers } = setup();
    handlers.pipelineStatus({ available: false });
    expect(syncAIProviderToMain).toHaveBeenCalled();
    expect(reportAIUnhealthy).not.toHaveBeenCalled();
  });

  it('surfaces the actionable banner when there is genuinely no provider to re-push', () => {
    const { handlers } = setup();
    handlers.pipelineStatus({ available: false, reason: 'no key' });
    expect(reportAIUnhealthy).toHaveBeenCalledWith('no key');
    handlers.pipelineStatus({ available: false });
    expect(reportAIUnhealthy).toHaveBeenCalledWith('No AI provider connected — AI features are paused.');
  });

  it('refreshes the list on a background draft only when the Drafts folder is open', () => {
    const { handlers, state } = setup();
    state.folders = [{ id: 'f1', path: 'INBOX' }];
    state.selectedFolderId = 'f1';
    handlers.draftReady();
    expect(state.loadFolders).toHaveBeenCalled(); // sidebar count always refreshes
    expect(state._reloadCurrentView).not.toHaveBeenCalled();

    state.folders = [{ id: 'f2', path: 'INBOX.Drafts' }];
    state.selectedFolderId = 'f2';
    handlers.draftReady();
    expect(state._reloadCurrentView).toHaveBeenCalled();
  });

  it('recognises the Drafts folder by SPECIAL-USE as well as by path', () => {
    const { handlers, state } = setup();
    state.folders = [{ id: 'f3', path: 'Brouillons', specialUse: '\\Drafts' }];
    state.selectedFolderId = 'f3';
    handlers.draftReady();
    expect(state._reloadCurrentView).toHaveBeenCalled();
  });

  it('drops removed drafts from every open view, by message-id AND by thread', () => {
    // The stale draft must not linger in the Drafts list / thread until a refresh.
    const { handlers, state } = setup();
    state.emails = [{ id: 'r1', messageId: '<m1>', threadId: 't1', tags: '|Drafts|draft|' }];
    state.threadEmails = [{ id: 'r2', messageId: '<other>', threadId: 't1', tags: '|Drafts|' }];
    state.searchResults = [{ id: 'r3', messageId: '<other2>', threadId: 't1', tags: '|INBOX|read|' }];

    handlers.draftsRemoved({ threadId: 't1', messageIds: ['<m1>'] });

    expect(state.removeDraftFromViews).toHaveBeenCalledWith('r1'); // message-id hit
    expect(state.removeDraftFromViews).toHaveBeenCalledWith('r2'); // same thread + draft row
    expect(state.removeDraftFromViews).not.toHaveBeenCalledWith('r3'); // same thread, NOT a draft
    expect(state.loadFolders).toHaveBeenCalled();
  });

  it('handles a drafts-removed event with no message ids', () => {
    const { handlers, state } = setup();
    state.emails = [{ id: 'r1', messageId: '<m1>', threadId: 't1', tags: '|[Gmail]/Drafts|' }];
    handlers.draftsRemoved({ threadId: 't1' });
    expect(state.removeDraftFromViews).toHaveBeenCalledWith('r1');
  });

  it('mirrors main-process categorization logs at the matching console level', () => {
    // The categorization service runs in main, so without this the devtools
    // console is empty and AI failures are invisible.
    const { handlers } = setup();
    handlers.log({ level: 'error', message: 'bad json' });
    expect(consoleSpies.error).toHaveBeenCalledWith('[main:cat]', 'bad json');
    handlers.log({ level: 'warn', message: 'retrying' });
    expect(consoleSpies.warn).toHaveBeenCalledWith('[main:cat]', 'retrying');
    handlers.log({ level: 'info', message: 'done' });
    expect(consoleSpies.log).toHaveBeenCalledWith('[main:cat]', 'done');
  });

  it('tolerates a bridge that only exposes the required aiCategorization channels', () => {
    // `agent`, `drafts` and `onLog` are all optional-chained; an older preload
    // must not break listener setup.
    installElectronAPI({
      aiCategorization: { onProgress: vi.fn(), onComplete: vi.fn(), onError: vi.fn() },
    });
    expect(() => setupAICategorizationListeners({ setState: vi.fn(), getState: vi.fn() })).not.toThrow();
  });
});

describe('computeSectionFetchLimit', () => {
  it('returns the preview size when the section has never been paginated', () => {
    // Regression: a fresh section (offset 0/undefined) must load exactly its
    // preview window — not 0 (empty section) and not some larger default.
    expect(computeSectionFetchLimit(undefined, 25)).toBe(25);
    expect(computeSectionFetchLimit(0, 25)).toBe(25);
  });

  it('preserves the paginated depth when it is below the reload cap', () => {
    // Regression: a background sync must NOT snap a user who paged to 60 back
    // to page 1 — we re-fetch up to their current depth.
    expect(computeSectionFetchLimit(60, 25)).toBe(60);
  });

  it('caps the re-fetch at SECTION_RELOAD_MAX_ITEMS for a deeply-paginated section', () => {
    // Regression: without the cap, a section paged to 500+ makes EVERY sync tick
    // re-fetch + re-buildThreads its whole grown set — the beachball. Cap it.
    expect(computeSectionFetchLimit(500, 25)).toBe(SECTION_RELOAD_MAX_ITEMS);
    expect(computeSectionFetchLimit(5000, 25)).toBe(SECTION_RELOAD_MAX_ITEMS);
  });

  it('never returns below the preview size, even if maxItems is set smaller', () => {
    // Regression: a misconfigured tiny cap must not shrink the visible preview —
    // the preview size is the floor.
    expect(computeSectionFetchLimit(500, 50, 25)).toBe(50);
    expect(computeSectionFetchLimit(10, 50, 25)).toBe(50);
  });

  it('falls back to 25 when the preview size is non-positive', () => {
    // Regression: a 0/negative maxItems from bad settings must not fetch 0 rows
    // (an empty section) — default to 25.
    expect(computeSectionFetchLimit(undefined, 0)).toBe(25);
    expect(computeSectionFetchLimit(undefined, -5)).toBe(25);
  });
});

describe('sectionDataUnchanged / sectionDataSignature', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'e1', updatedAt: 100, date: 1000, tags: '|inbox|', flags: [], subject: 'Hi', cleanBody: 'preview', ...over,
  });
  const snap = (emails: any[], over: Record<string, unknown> = {}) => ({
    A: { emails, total: emails.length, hasMore: false, loading: false, ...over },
  });

  it('reports UNCHANGED for two identical snapshots', () => {
    // Regression: a no-op background sync tick (nothing new arrived) must NOT
    // trigger a re-render — this is the whole point of the guard.
    expect(sectionDataUnchanged(snap([row()]), snap([row()]))).toBe(true);
  });

  it('reports CHANGED when a row is marked read (flags gain \\Seen)', () => {
    // Regression: marking a mail read must still re-render (drop the bold) —
    // the guard must not swallow a read-state flip.
    expect(sectionDataUnchanged(snap([row()]), snap([row({ flags: ['\\Seen'], updatedAt: 101 })]))).toBe(false);
  });

  it('reports CHANGED when a row is starred/categorized (tags change)', () => {
    // Regression: a star or new AI category tag must re-render its badge.
    expect(sectionDataUnchanged(snap([row()]), snap([row({ tags: '|inbox||starred|' })]))).toBe(false);
  });

  it('reports CHANGED when a body downloads (cleanBody snippet changes)', () => {
    // Regression: the exact silent bug the project fears — a downloaded body's
    // preview text must appear, so a snippet change can never be skipped.
    expect(sectionDataUnchanged(snap([row({ cleanBody: '' })]), snap([row({ cleanBody: 'now has text' })]))).toBe(false);
  });

  it('reports CHANGED when a new row arrives or a row is removed', () => {
    // Regression: new mail must appear and deleted mail must disappear.
    expect(sectionDataUnchanged(snap([row()]), snap([row(), row({ id: 'e2' })]))).toBe(false);
    expect(sectionDataUnchanged(snap([row(), row({ id: 'e2' })]), snap([row()]))).toBe(false);
  });

  it('reports CHANGED when rows are reordered', () => {
    // Regression: a re-sort (e.g. a thread bumped by a new reply) must re-render.
    const a = row({ id: 'e1' });
    const b = row({ id: 'e2' });
    expect(sectionDataUnchanged(snap([a, b]), snap([b, a]))).toBe(false);
  });

  it('reports CHANGED when the header total or hasMore changes', () => {
    // Regression: the "1-25 of N" header count and the "show more" affordance
    // must refresh even if the visible rows are unchanged.
    expect(sectionDataUnchanged(snap([row()], { total: 10 }), snap([row()], { total: 11 }))).toBe(false);
    expect(sectionDataUnchanged(snap([row()], { hasMore: false }), snap([row()], { hasMore: true }))).toBe(false);
  });

  it('reports CHANGED when a section is loading', () => {
    // Regression: a section entering its loading state must render its spinner.
    expect(sectionDataUnchanged(snap([row()], { loading: false }), snap([row()], { loading: true }))).toBe(false);
  });

  it('is order-independent across section keys but sensitive to per-section content', () => {
    // Regression: section object key order must not matter (stable signature),
    // but a change confined to ONE section must still be detected.
    const two = (bTags: string) => ({
      A: { emails: [row()], total: 1, hasMore: false, loading: false },
      B: { emails: [row({ id: 'e9', tags: bTags })], total: 1, hasMore: false, loading: false },
    });
    const reordered = { B: two('|inbox|').B, A: two('|inbox|').A };
    expect(sectionDataUnchanged(two('|inbox|'), reordered)).toBe(true);
    expect(sectionDataUnchanged(two('|inbox|'), two('|inbox||starred|'))).toBe(false);
  });

  it('treats an empty snapshot as different from a populated one', () => {
    // Regression: the very first real load (empty -> rows) must always render.
    expect(sectionDataUnchanged({}, snap([row()]))).toBe(false);
    expect(sectionDataUnchanged({}, {})).toBe(true);
  });

  it('produces a deterministic, JSON-escaped signature (no separator collision)', () => {
    // Regression: a field value containing our old separator chars must not be
    // able to forge a boundary and make two different snapshots collide.
    const sneaky = sectionDataSignature(snap([row({ subject: 'a","b' })]));
    const plain = sectionDataSignature(snap([row({ subject: 'ab' })]));
    expect(sneaky).not.toBe(plain);
    // Deterministic: same input twice -> identical string.
    expect(sectionDataSignature(snap([row()]))).toBe(sectionDataSignature(snap([row()])));
  });
});

describe('isFolderInView', () => {
  const folders = [
    { id: 'f-inbox', path: 'INBOX' },
    { id: 'f-sent', path: 'Sent' },
  ];

  // Breaks: arrivals in the open folder stop refreshing the list.
  it('matches the folder the user is looking at', () => {
    expect(isFolderInView(folders, 'f-inbox', 'INBOX')).toBe(true);
  });

  // Breaks: mail landing in Trash/Spam during a sync yanks the open list about.
  it('does not match a different folder', () => {
    expect(isFolderInView(folders, 'f-inbox', 'Sent')).toBe(false);
  });

  // THE REGRESSION this helper exists for. During an initial sync (or after a
  // rebuilt cache) the sync creates folder rows as it discovers them, so the
  // renderer's snapshot has NOT caught up. The old check looked the ARRIVING
  // folder up by path and compared ids — undefined for an unknown folder, so
  // every arrival was dropped and the list sat empty behind a non-zero sidebar
  // count until the user hit refresh. Resolving the SELECTED folder instead
  // cannot go stale that way: it is where selectedFolderId came from.
  it('still matches when the snapshot has not caught up with new folders', () => {
    // 'Sarv Inbox/Promotions' was created by the sync moments ago and is absent
    // from `folders` — the open INBOX must still refresh on its own arrivals.
    expect(isFolderInView(folders, 'f-inbox', 'INBOX')).toBe(true);
    expect(isFolderInView(folders, 'f-inbox', 'Sarv Inbox/Promotions')).toBe(false);
  });

  // Breaks: a virtual folder / no selection is read as "everything is visible"
  // and every arrival re-renders the list.
  it.each([
    ['no selection', null],
    ['an empty selection', ''],
  ])('returns false for %s', (_case, selectedId) => {
    expect(isFolderInView(folders, selectedId as string | null, 'INBOX')).toBe(false);
  });

  // Breaks: a selection pointing at a folder that no longer exists (the row was
  // recreated with a new id) must not match by accident.
  it('returns false when the selected id is not in the snapshot', () => {
    expect(isFolderInView(folders, 'f-gone', 'INBOX')).toBe(false);
  });

  // Breaks: the very first flush, before folders have loaded at all, throws and
  // takes the whole realtime flush down with it.
  it.each([
    ['undefined folders', undefined],
    ['null folders', null],
    ['an empty list', []],
  ])('tolerates %s', (_case, list) => {
    expect(isFolderInView(list as never, 'f-inbox', 'INBOX')).toBe(false);
  });

  // Breaks: an arrival with no folder path matching the selected folder.
  it('returns false without a folder path', () => {
    expect(isFolderInView(folders, 'f-inbox', undefined)).toBe(false);
  });
});

describe('findFolderPathById', () => {
  const folders = [
    { id: 'f-inbox', path: 'INBOX' },
    { id: 'f-sent', path: '[Gmail]/Sent Mail' },
  ];

  // Breaks: the progressive-fill refresh aims at the wrong folder, so the list
  // on screen never reloads while the sync fills the DB.
  it('resolves the selected folder to its path', () => {
    expect(findFolderPathById(folders, 'f-sent')).toBe('[Gmail]/Sent Mail');
  });

  // Breaks: a virtual view ("All Email", "Starred") has no selected folder id —
  // returning something truthy here would send the refresh at a folder branch
  // instead of the virtual one.
  it.each([
    ['no id', null],
    ['an empty id', ''],
    ['an id that is not in the snapshot', 'f-gone'],
  ])('returns null for %s', (_case, id) => {
    expect(findFolderPathById(folders, id as string | null)).toBeNull();
  });

  // Breaks: the first progress tick, before folders have loaded, throws and
  // takes the sync-progress listener down with it.
  it.each([
    ['undefined folders', undefined],
    ['null folders', null],
    ['an empty list', []],
  ])('tolerates %s', (_case, list) => {
    expect(findFolderPathById(list as never, 'f-inbox')).toBeNull();
  });
});

describe('decideSyncProgressRefresh', () => {
  const gate = (lastProcessed: number, lastRefreshAt: number) => ({ lastProcessed, lastRefreshAt });

  // THE REGRESSION this rule exists for: mail used to appear only when the whole
  // sync resolved. The first tick that stored anything must show it immediately,
  // not wait out a throttle window.
  it('refreshes on the first tick that has stored mail', () => {
    expect(decideSyncProgressRefresh({ messagesProcessed: 50 }, gate(0, 0), 10_000)).toEqual({
      refresh: true,
      gate: gate(50, 10_000),
    });
  });

  // Breaks: a batch commit every ~50 messages means ~500 ticks on a 25k first
  // sync — refreshing on each one re-queries and re-renders continuously, and
  // the "progressive fill" becomes a treadmill.
  it('throttles a second refresh inside the window', () => {
    const now = 10_000;
    const held = gate(50, now - (SYNC_PROGRESS_REFRESH_MS - 1));

    // The gate is returned UNCHANGED: swallowing the count here would make the
    // next tick past the window look like standing still and drop it too.
    expect(decideSyncProgressRefresh({ messagesProcessed: 100 }, held, now)).toEqual({
      refresh: false,
      gate: held,
    });
  });

  // Breaks: the throttle never opens again and only the first batch is ever shown.
  it('refreshes again once the window has elapsed', () => {
    const now = 10_000;
    expect(
      decideSyncProgressRefresh({ messagesProcessed: 100 }, gate(50, now - SYNC_PROGRESS_REFRESH_MS), now),
    ).toEqual({ refresh: true, gate: gate(100, now) });
  });

  // Breaks: a flags-only pass, or a folder already up to date, ticks progress
  // without storing a row — reloading the list there is pure cost for the same
  // rows, on the main thread, during the busiest moment of the app's life.
  it('skips a tick that processed nothing new', () => {
    expect(decideSyncProgressRefresh({ messagesProcessed: 50 }, gate(50, 0), 10_000)).toEqual({
      refresh: false,
      gate: gate(50, 0),
    });
  });

  // Breaks: the engine resets its cumulative count to 0 at the start of every
  // sync. The reset itself has stored nothing, so it must not spend a reload —
  // but the gate MUST adopt the lower count, or the next sync's batches would
  // be measured against the previous sync's total and every one of them read as
  // "no progress" until it exceeded it.
  it('adopts a count reset without refreshing for it', () => {
    expect(decideSyncProgressRefresh({ messagesProcessed: 0 }, gate(24_900, 0), 10_000)).toEqual({
      refresh: false,
      gate: gate(0, 0),
    });
  });

  // Breaks: the wasted reload on every renderer load. The engine's first tick of
  // a fresh sync reports 0, and a sentinel below zero would read that as
  // progress and re-query the list before a single row had been stored.
  it('does not refresh for a first tick that has stored nothing', () => {
    expect(decideSyncProgressRefresh({ messagesProcessed: 0 }, gate(0, 0), 10_000).refresh).toBe(false);
  });

  // Breaks: a malformed status (no progress field, a null from an older main
  // process) throws inside the IPC listener and kills every later tick.
  it.each([
    ['a null status', null],
    ['an undefined status', undefined],
    ['a status with no count', {}],
    ['a non-numeric count', { messagesProcessed: 'lots' }],
    ['NaN', { messagesProcessed: Number.NaN }],
  ])('refuses to refresh on %s, and leaves the gate alone', (_case, status) => {
    const held = gate(50, 1_000);
    expect(decideSyncProgressRefresh(status as never, held, 10_000)).toEqual({ refresh: false, gate: held });
  });
});
