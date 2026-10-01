import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirm = vi.hoisted(() => vi.fn());
vi.mock('../../../../../src/store/confirm-service', () => ({ requestConfirm: confirm }));

type BulkResponse = {
  success: boolean;
  error?: string;
  data?: { processedIds: string[]; failedIds: string[]; queuedIds?: string[] };
};

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
  let state: any;
  const get = () => state;
  const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const actions = createEmailActionsSlice(set, get, {} as any);
  state = {
    ...actions,
    emails: [], threadEmails: [], searchResults: [], sectionData: {},
    folders: [{ id: 'inbox', path: 'INBOX' }],
    activeAccountId: 'account-a', viewAccountId: null, threadAccountId: null,
    selectedFolderId: null, selectedVirtualFolder: 'virtual-unified',
    viewingAICategory: null, viewingSection: null, viewingSnoozed: false,
    selectedEmailId: null, highlightedEmailId: null,
    searchQuery: '', activeInboxFilter: null, emailsPage: 0, emailsTotal: 25,
    loadFolders: vi.fn(async () => {}), refreshCategoryCounts: vi.fn(async () => {}),
    refreshUnreadSummary: vi.fn(async () => {}), goToEmailPage: vi.fn(async () => {}),
    ...seed,
  };
  return { actions: actions as any, get, set, bulkAction, alert };
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
