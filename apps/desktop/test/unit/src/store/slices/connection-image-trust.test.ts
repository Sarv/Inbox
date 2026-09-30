import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { account, installLocalStorage, loadConnectionSlice, teardownStoreEnv } from './connection-slice-harness';

// The remote-image trust sources (allowlist, trusted senders, people emailed)
// are per account. What breaks if this file goes red: after an account switch
// the first message opened is decided on cold caches (its banner stays for an
// allowed sender until the reader navigates away and back), or — worse — reads
// that name no account keep answering with the account that was left.

const trustAPI = (over: Record<string, any> = {}) => ({
  emails: {
    getQuota: vi.fn(async () => ({ success: true, data: null })),
    getImageAllowedSenders: vi.fn(async (accountId?: string) => ({ success: true, data: accountId === 'acct-sarv' ? ['boss@sarv.test'] : [] })),
    getEmailedAddresses: vi.fn(async () => ({ success: true, data: [] })),
    allowImagesForSender: vi.fn(async () => ({ success: true })),
  },
  spam: {
    listTrustedSenders: vi.fn(async () => ({ success: true, data: [] })),
    trustSender: vi.fn(async () => ({ success: true })),
  },
  ai: { getCategoryDefinitions: vi.fn(async () => ({ success: true, data: [] })) },
  accounts: {
    setActive: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue({ success: true }),
  },
  imap: {
    isConnected: vi.fn().mockResolvedValue({ success: true, data: true }),
    removeSyncProgressListener: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
  },
  smtp: { disconnect: vi.fn().mockResolvedValue(undefined) },
  secureCreds: { delete: vi.fn().mockResolvedValue(undefined) },
  ...over,
});

/** A second mailbox's IMAP settings (test values; the probe is skipped). */
const SECOND = { host: 'imap.second.test', port: 993, secure: true, username: 'me@second.test', password: 'test-only' };

const stubViewActions = (state: any) => {
  state.loadFolders = vi.fn().mockResolvedValue(undefined);
  state.loadLabels = vi.fn().mockResolvedValue(undefined);
  state.startIdle = vi.fn().mockResolvedValue(undefined);
  state.syncSingleFolder = vi.fn().mockResolvedValue(undefined);
  state.connect = vi.fn().mockResolvedValue(undefined);
  state.loadQuota = vi.fn().mockResolvedValue(undefined);
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(installLocalStorage);
afterEach(async () => {
  const { setActiveCacheAccount } = await import('../../../../../src/utils/account-scoped-cache');
  setActiveCacheAccount(null);
  teardownStoreEnv();
  vi.restoreAllMocks();
});

describe('selectAccount — image trust follows the account', () => {
  // Breaks: eager warming on switch — every trust source of the account being
  // entered loads at once, by id, and reads with no account now mean it.
  it('repoints the trust caches at the new account and loads its lists at once', async () => {
    const api = trustAPI();
    const { state } = await loadConnectionSlice(
      { accounts: [account('acct-gmail'), account('acct-sarv')], activeAccountId: 'acct-gmail' },
      api,
    );
    stubViewActions(state);
    const { activeCacheAccount } = await import('../../../../../src/utils/account-scoped-cache');
    const { isSenderImagesAllowed } = await import('../../../../../src/utils/remote-images');

    await state.selectAccount('acct-sarv');
    await settle();

    expect(activeCacheAccount()).toBe('acct-sarv');
    expect(api.emails.getImageAllowedSenders).toHaveBeenCalledWith('acct-sarv');
    expect(api.emails.getEmailedAddresses).toHaveBeenCalledWith('acct-sarv');
    expect(api.spam.listTrustedSenders).toHaveBeenCalledWith('acct-sarv');
    // Warm BEFORE any message asked: the first read is already the real answer.
    expect(isSenderImagesAllowed('boss@sarv.test')).toBe(true);
  });

  // A switch whose main-process call fails still repoints the renderer, so a
  // read never answers from the account the reader just left.
  it('repoints even when the main process could not be told', async () => {
    const api = trustAPI({ accounts: { setActive: vi.fn().mockRejectedValue(new Error('ipc gone')) } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { state } = await loadConnectionSlice(
      { accounts: [account('acct-gmail'), account('acct-sarv')], activeAccountId: 'acct-gmail' },
      api,
    );
    stubViewActions(state);
    const { activeCacheAccount } = await import('../../../../../src/utils/account-scoped-cache');

    await state.selectAccount('acct-sarv');
    expect(activeCacheAccount()).toBe('acct-sarv');
  });

  // Re-clicking the active account is not a switch: nothing reloads.
  it('does nothing when the account is already active', async () => {
    const api = trustAPI();
    const { state } = await loadConnectionSlice(
      { accounts: [account('acct-gmail')], activeAccountId: 'acct-gmail' },
      api,
    );
    stubViewActions(state);
    await state.selectAccount('acct-gmail');
    await settle();
    expect(api.emails.getImageAllowedSenders).not.toHaveBeenCalled();
  });
});

describe('addAccount / removing the last account — image trust follows', () => {
  // Breaks (the blocker): addAccount made the new account active in the store
  // and in main, but the trust caches stayed on the previous account — so the
  // new account's mail was judged against the old account's allowlist, trusted
  // senders and correspondents, and "Load images" / "Trust this sender" on it
  // were written into the OLD account's database.
  it('points the trust caches at the added account, so its writes land there', async () => {
    const api = trustAPI();
    const { state } = await loadConnectionSlice({ accounts: [account('acct-a')], activeAccountId: 'acct-a', quotaByAccount: {} }, api);
    stubViewActions(state);
    const { activeCacheAccount, setActiveCacheAccount } = await import('../../../../../src/utils/account-scoped-cache');
    const { rememberImagesAllowed } = await import('../../../../../src/utils/remote-images');
    const { trustSender } = await import('../../../../../src/utils/trusted-senders');
    setActiveCacheAccount('acct-a'); // where startup pointed them

    await state.addAccount(SECOND, { alreadyVerified: true });
    const added = state.activeAccountId;
    expect(added).not.toBe('acct-a');
    expect(activeCacheAccount()).toBe(added);

    rememberImagesAllowed('pal@x.test');
    expect(api.emails.allowImagesForSender).toHaveBeenCalledWith('pal@x.test', added);
    await trustSender('bank@x.test');
    expect(api.spam.trustSender).toHaveBeenCalledWith('bank@x.test', added);
    await settle();
    expect(api.emails.getImageAllowedSenders).toHaveBeenCalledWith(added); // its lists load at once
  });

  // Partial run: a connect that fails after a passing probe rolls the store
  // back to the previous account — and the trust caches with it, or the
  // restored account would read (and write) the half-added one's lists.
  it('follows the rollback of a failed add back to the previous account', async () => {
    const api = trustAPI();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { state } = await loadConnectionSlice({ accounts: [account('acct-a')], activeAccountId: 'acct-a', quotaByAccount: {} }, api);
    stubViewActions(state);
    state.connect = vi.fn().mockRejectedValue(new Error('AUTHENTICATIONFAILED'));
    const { activeCacheAccount, setActiveCacheAccount } = await import('../../../../../src/utils/account-scoped-cache');
    setActiveCacheAccount('acct-a');

    await expect(state.addAccount(SECOND, { alreadyVerified: true })).rejects.toThrow('AUTHENTICATIONFAILED');
    expect(state.activeAccountId).toBe('acct-a');
    expect(activeCacheAccount()).toBe('acct-a');
  });

  // Breaks: removing the last account left the caches on the deleted id, so
  // the next account added read and wrote a database that no longer exists
  // (every load failing its strict account check, every write refused). The
  // removed account's lists go too.
  it('points the caches at no account when the last one is removed, and forgets its lists', async () => {
    const api = trustAPI({
      emails: {
        getImageAllowedSenders: vi.fn(async () => ({ success: true, data: ['boss@a.test'] })),
        getEmailedAddresses: vi.fn(async () => ({ success: true, data: [] })),
        getQuota: vi.fn(async () => ({ success: true, data: null })),
      },
    });
    const { state } = await loadConnectionSlice({ accounts: [account('acct-a')], activeAccountId: 'acct-a', quotaByAccount: {} }, api);
    stubViewActions(state);
    const { activeCacheAccount, setActiveCacheAccount } = await import('../../../../../src/utils/account-scoped-cache');
    const { imageAllowlist } = await import('../../../../../src/utils/remote-images');
    setActiveCacheAccount('acct-a');
    await imageAllowlist.reload('acct-a');
    expect(imageAllowlist.isLoaded('acct-a')).toBe(true);

    await state.removeAccountById('acct-a');
    expect(state.activeAccountId).toBeNull();
    expect(activeCacheAccount()).toBeNull();
    expect(imageAllowlist.isLoaded('acct-a')).toBe(false);
  });

  // A write that does not touch the active account does not repoint anything.
  it('leaves the caches alone when a write does not change the active account', async () => {
    const api = trustAPI();
    const { state } = await loadConnectionSlice({ accounts: [account('acct-a'), account('acct-b')], activeAccountId: 'acct-a', quotaByAccount: {} }, api);
    stubViewActions(state);
    const { activeCacheAccount, setActiveCacheAccount } = await import('../../../../../src/utils/account-scoped-cache');
    setActiveCacheAccount('acct-a');

    await state.removeAccountById('acct-b');
    expect(activeCacheAccount()).toBe('acct-a');
    expect(api.emails.getImageAllowedSenders).not.toHaveBeenCalled();
  });
});
