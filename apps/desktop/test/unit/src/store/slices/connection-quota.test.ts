import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { account, installLocalStorage, loadConnectionSlice, teardownStoreEnv } from './connection-slice-harness';

// The storage bar is per-account, but `quota` is ONE store field. Two ways it
// showed the wrong mailbox's usage — the Gmail "18 GB of 150 GB" staying put
// after switching to a Sarv account:
//   1. selectAccount never cleared or reloaded it, and the only refreshers
//      (a fresh connect, a full syncEmails) don't run on a switch that adopts an
//      already-live connection — so the stale bar could survive all day.
//   2. loadQuota applied whatever came back, so a slow reply for the account
//      being LEFT could overwrite the one being entered.

// Mirrors QUOTA_CACHE_KEY in ../helpers (private there, as every other key is).
const QUOTA_CACHE_KEY = 'sarvinbox-quota-cache';

const quotaAPI = (per: Record<string, { used: number; limit: number } | null>, hooks: any = {}) => ({
  emails: {
    getQuota: vi.fn(async (accountId?: string) => {
      await hooks.beforeResolve?.(accountId);
      return { success: true, data: accountId ? (per[accountId] ?? null) : null };
    }),
  },
  accounts: { setActive: vi.fn().mockResolvedValue(undefined) },
  imap: {
    isConnected: vi.fn().mockResolvedValue({ success: true, data: true }),
    removeSyncProgressListener: vi.fn(),
  },
  ...hooks.api,
});

/** selectAccount fans out into the rest of the store; stub those edges. */
const stubViewActions = (state: any) => {
  state.loadFolders = vi.fn().mockResolvedValue(undefined);
  state.loadLabels = vi.fn().mockResolvedValue(undefined);
  state.startIdle = vi.fn().mockResolvedValue(undefined);
  state.syncSingleFolder = vi.fn().mockResolvedValue(undefined);
  state.connect = vi.fn().mockResolvedValue(undefined);
};

const GMAIL = { used: 18_000_000_000, limit: 150_000_000_000 };
const SARV = { used: 400_000_000, limit: 5_000_000_000 };

beforeEach(installLocalStorage);
afterEach(() => {
  teardownStoreEnv();
  vi.restoreAllMocks();
});

describe('loadQuota', () => {
  it('asks for the ACTIVE account when given no id', async () => {
    // Sending no id let main resolve "whatever is active there", which drifts
    // from the renderer's idea of active during a switch.
    const api = quotaAPI({ 'acct-gmail': GMAIL });
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-gmail' }, api);

    await state.loadQuota();

    expect(api.emails.getQuota).toHaveBeenCalledWith('acct-gmail');
    expect(state.quota).toEqual(GMAIL);
  });

  it('asks for the id it was given, not the active one', async () => {
    const api = quotaAPI({ 'acct-sarv': SARV });
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-sarv' }, api);

    await state.loadQuota('acct-sarv');

    expect(api.emails.getQuota).toHaveBeenCalledWith('acct-sarv');
    expect(state.quota).toEqual(SARV);
  });

  it('DROPS a reply whose account is no longer active', async () => {
    // The race: the user switches away while Gmail's QUOTA is still in flight.
    // Without the guard, Gmail's 150 GB lands under the Sarv account.
    const switched: { state: any } = { state: null };
    const api = quotaAPI(
      { 'acct-gmail': GMAIL },
      { beforeResolve: async () => { switched.state.activeAccountId = 'acct-sarv'; } },
    );
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-gmail', quota: SARV }, api);
    switched.state = state;

    await state.loadQuota('acct-gmail');

    expect(state.quota).toEqual(SARV); // untouched
  });

  it('clears a stale bar when the server reports no quota', async () => {
    // A server that doesn't advertise QUOTA must blank the bar, not inherit the
    // previous account's numbers.
    const api = quotaAPI({});
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-sarv', quota: GMAIL }, api);

    await state.loadQuota('acct-sarv');

    expect(state.quota).toBeNull();
  });

  it('swallows a failed lookup and leaves the bar alone', async () => {
    // Quota is informational — a throwing IPC must never surface as an error.
    const api = quotaAPI({}, { api: { emails: { getQuota: vi.fn().mockRejectedValue(new Error('no conn')) } } });
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-sarv', quota: SARV }, api);

    await expect(state.loadQuota('acct-sarv')).resolves.toBeUndefined();
    expect(state.quota).toEqual(SARV);
  });

  it('keeps the bar when the lookup reports failure', async () => {
    // success:false is "couldn't ask" (no connection), not "no quota" — the
    // difference between blanking a good bar and leaving it be.
    const api = quotaAPI({}, { api: { emails: { getQuota: vi.fn().mockResolvedValue({ success: false, error: 'x' }) } } });
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-sarv', quota: SARV }, api);

    await state.loadQuota('acct-sarv');

    expect(state.quota).toEqual(SARV);
  });

  it('asks without an id when no account is active yet', async () => {
    // Startup: the store has no active account. Must not send the string
    // "null"/"undefined" as an id, and must not trip the same-account guard.
    const api = quotaAPI({});
    const { state } = await loadConnectionSlice({ activeAccountId: null }, api);

    await state.loadQuota();

    expect(api.emails.getQuota).toHaveBeenCalledWith(undefined);
    expect(state.quota).toBeNull();
  });

  it('survives a preload without getQuota', async () => {
    // Older preload / partial mock: the optional call must not throw.
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-sarv' }, { emails: {} });

    await expect(state.loadQuota()).resolves.toBeUndefined();
    expect(state.quota).toBeNull();
  });
});

describe('loadQuota — cache + in-flight flag', () => {
  it('persists the figure per account and records a null answer', async () => {
    // The cache is what lets a switch paint immediately. A NULL answer is stored
    // too — "this server has no quota" is knowledge, and it's what keeps the
    // placeholder from reappearing at every refresh.
    const api = quotaAPI({ 'acct-gmail': GMAIL });
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-gmail' }, api);

    await state.loadQuota('acct-gmail');
    expect(state.quotaByAccount['acct-gmail']).toEqual(GMAIL);
    expect(JSON.parse(localStorage.getItem(QUOTA_CACHE_KEY)!)['acct-gmail']).toEqual(GMAIL);

    state.activeAccountId = 'acct-sarv';
    await state.loadQuota('acct-sarv');
    expect('acct-sarv' in state.quotaByAccount).toBe(true);
    expect(state.quotaByAccount['acct-sarv']).toBeNull();
  });

  it('raises quotaLoading for the duration and lowers it after', async () => {
    // The flag is the row's licence to hold its place; left stuck true it would
    // keep a placeholder on screen forever.
    let inFlight: boolean | undefined;
    const api = quotaAPI({ 'acct-gmail': GMAIL }, { beforeResolve: () => { inFlight = state.quotaLoading; } });
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-gmail' }, api);

    await state.loadQuota('acct-gmail');

    expect(inFlight).toBe(true);
    expect(state.quotaLoading).toBe(false);
  });

  it('lowers quotaLoading even when the lookup throws', async () => {
    const api = quotaAPI({}, { api: { emails: { getQuota: vi.fn().mockRejectedValue(new Error('no conn')) } } });
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-sarv' }, api);

    await state.loadQuota('acct-sarv');

    expect(state.quotaLoading).toBe(false);
  });

  it('leaves quotaLoading to the newer load when the account changed mid-flight', async () => {
    // The stale reply must not clear a flag that now belongs to the switch's own
    // lookup — doing so would drop the new account's placeholder for a frame.
    const holder: { state: any } = { state: null };
    const api = quotaAPI(
      { 'acct-gmail': GMAIL },
      { beforeResolve: async () => { holder.state.activeAccountId = 'acct-sarv'; } },
    );
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-gmail' }, api);
    holder.state = state;

    await state.loadQuota('acct-gmail');

    expect(state.quotaLoading).toBe(true);
  });

  it('opens with the last-known figure already on screen', async () => {
    // Cold start: the bar reads the cache on module load, so the sidebar isn't
    // blank until the first QUOTA round-trip completes.
    installLocalStorage();
    localStorage.setItem('sarvinbox-accounts', JSON.stringify([{ id: 'acct-gmail', email: 'a@b.c', imapConfig: {} }]));
    localStorage.setItem('sarvinbox-active-account', 'acct-gmail');
    localStorage.setItem(QUOTA_CACHE_KEY, JSON.stringify({ 'acct-gmail': GMAIL }));

    vi.resetModules();
    (globalThis as any).window = { electronAPI: quotaAPI({}) };
    const mod = await import('../../../../../src/store/slices/connection-slice');
    const slice: any = mod.createConnectionSlice(() => {}, (() => ({})) as any, {} as any);

    expect(slice.quota).toEqual(GMAIL);
    expect(slice.quotaByAccount['acct-gmail']).toEqual(GMAIL);
    expect(slice.quotaLoading).toBe(false);
  });

  it('opens with an empty bar when the cache holds no figure for the active account', async () => {
    // A cache entry for a DIFFERENT account must not be borrowed — that is the
    // same wrong-account bug, just at startup instead of on a switch.
    installLocalStorage();
    localStorage.setItem('sarvinbox-accounts', JSON.stringify([{ id: 'acct-gmail', email: 'a@b.c', imapConfig: {} }]));
    localStorage.setItem('sarvinbox-active-account', 'acct-gmail');
    localStorage.setItem(QUOTA_CACHE_KEY, JSON.stringify({ 'acct-sarv': SARV }));

    vi.resetModules();
    (globalThis as any).window = { electronAPI: quotaAPI({}) };
    const mod = await import('../../../../../src/store/slices/connection-slice');
    const slice: any = mod.createConnectionSlice(() => {}, (() => ({})) as any, {} as any);

    expect(slice.quota).toBeNull();
    expect(slice.quotaByAccount).toEqual({ 'acct-sarv': SARV });
  });
});

describe('selectAccount — quota follows the account', () => {
  it('clears the old bar and loads the new account’s usage', async () => {
    // THE reported bug: switch Gmail -> Sarv and the bar still read
    // "18 GB of 150 GB". The adopt-a-live-connection branch returns early, so
    // this must happen before it.
    const api = quotaAPI({ 'acct-gmail': GMAIL, 'acct-sarv': SARV });
    const { state } = await loadConnectionSlice(
      {
        accounts: [account('acct-gmail'), account('acct-sarv')],
        activeAccountId: 'acct-gmail',
        quota: GMAIL,
      },
      api,
    );
    stubViewActions(state);

    await state.selectAccount('acct-sarv');

    expect(api.emails.getQuota).toHaveBeenCalledWith('acct-sarv');
    expect(state.quota).toEqual(SARV);
  });

  it('paints the target account’s CACHED figure before the server answers', async () => {
    // This is the answer to "why did it vanish and come back?" — with a cached
    // figure the row never goes empty: it swaps straight from Gmail's numbers to
    // Sarv's last-known ones, then refreshes in place.
    const seen: Array<{ used: number; limit: number } | null> = [];
    const api = quotaAPI({ 'acct-sarv': SARV }, { beforeResolve: () => { seen.push(holder.state.quota); } });
    const holder: { state: any } = { state: null };
    const { state } = await loadConnectionSlice(
      {
        accounts: [account('acct-gmail'), account('acct-sarv')],
        activeAccountId: 'acct-gmail',
        quota: GMAIL,
        quotaByAccount: { 'acct-gmail': GMAIL, 'acct-sarv': { used: 300_000_000, limit: 5_000_000_000 } },
      },
      api,
    );
    holder.state = state;
    stubViewActions(state);

    await state.selectAccount('acct-sarv');

    // At lookup time the bar already showed Sarv's cached figure — never Gmail's,
    // never nothing.
    expect(seen[0]).toEqual({ used: 300_000_000, limit: 5_000_000_000 });
    expect(state.quota).toEqual(SARV); // then refreshed in place
  });

  it('marks the switch as loading so a first-time account keeps the row', async () => {
    // No cached figure for the target: the row holds its place as a placeholder
    // (quota null + loading true) instead of unmounting and reflowing.
    const seen: Array<{ quota: unknown; loading: boolean }> = [];
    const api = quotaAPI({ 'acct-sarv': SARV }, { beforeResolve: () => { seen.push({ quota: holder.state.quota, loading: holder.state.quotaLoading }); } });
    const holder: { state: any } = { state: null };
    const { state } = await loadConnectionSlice(
      {
        accounts: [account('acct-gmail'), account('acct-sarv')],
        activeAccountId: 'acct-gmail',
        quota: GMAIL,
        quotaByAccount: { 'acct-gmail': GMAIL },
      },
      api,
    );
    holder.state = state;
    stubViewActions(state);

    await state.selectAccount('acct-sarv');

    expect(seen[0]).toEqual({ quota: null, loading: true });
    expect(state.quota).toEqual(SARV);
  });

  it('leaves the bar blank rather than stale when the new account has no quota', async () => {
    // Sarv's server may not advertise QUOTA at all; a blank bar is honest,
    // Gmail's numbers under Sarv are not.
    const api = quotaAPI({ 'acct-gmail': GMAIL });
    const { state } = await loadConnectionSlice(
      {
        accounts: [account('acct-gmail'), account('acct-sarv')],
        activeAccountId: 'acct-gmail',
        quota: GMAIL,
      },
      api,
    );
    stubViewActions(state);

    await state.selectAccount('acct-sarv');

    expect(state.quota).toBeNull();
  });

  it('still refreshes when the switch has to reconnect', async () => {
    // The other branch: no live connection to adopt. The load is kicked before
    // the branch, so it must have happened here too.
    const api = quotaAPI(
      { 'acct-sarv': SARV },
      { api: { imap: { isConnected: vi.fn().mockResolvedValue({ success: true, data: false }) } } },
    );
    const { state } = await loadConnectionSlice(
      {
        accounts: [account('acct-gmail'), account('acct-sarv')],
        activeAccountId: 'acct-gmail',
        quota: GMAIL,
      },
      api,
    );
    stubViewActions(state);

    await state.selectAccount('acct-sarv');

    expect(api.emails.getQuota).toHaveBeenCalledWith('acct-sarv');
    expect(state.connect).toHaveBeenCalled();
  });

  it('does nothing when the account is already active', async () => {
    // Re-clicking the current account must not blank its own bar.
    const api = quotaAPI({ 'acct-gmail': GMAIL });
    const { state } = await loadConnectionSlice(
      { accounts: [account('acct-gmail')], activeAccountId: 'acct-gmail', quota: GMAIL },
      api,
    );
    stubViewActions(state);

    await state.selectAccount('acct-gmail');

    expect(api.emails.getQuota).not.toHaveBeenCalled();
    expect(state.quota).toEqual(GMAIL);
  });
});
