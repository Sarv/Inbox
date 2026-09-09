import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConnectionSlice, teardownStoreEnv } from './connection-slice-harness';

// The duplicate auto-connect on startup. Mount, window focus, network-online and
// the reconnect ladder all reach for the same connection, and React StrictMode
// double-invokes the mount effect in development on top of that — so `connect()`
// ran twice for one account on every cold start. The two attempts fought (one
// tore down the socket the other was opening: "Already connected or connecting"
// → "Unexpected close") and every side effect in the path — vault write,
// credential save, registry upsert, background sync — happened twice.

/** A promise plus its resolver, so a test can hold a connect open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const imapConfig = (username: string) => ({
  host: 'imap.example.com',
  port: 993,
  username,
  password: 'secret',
  tls: true,
});

/** electronAPI with a connect the test controls, plus the calls doConnect makes. */
function makeApi(connect: (config: unknown, acctId: string) => Promise<unknown>) {
  return {
    imap: {
      connect: vi.fn(connect),
      removeSyncProgressListener: vi.fn(),
      onSyncProgress: vi.fn(),
    },
    secureCreds: { set: vi.fn(async () => undefined), get: vi.fn(async () => null) },
  };
}

/** The store fields doConnect reaches for after a successful connect. */
const storeStubs = () => ({
  loadFolders: vi.fn(async () => undefined),
  syncEmails: vi.fn(async () => undefined),
  setSyncStatus: vi.fn(),
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  teardownStoreEnv();
  vi.restoreAllMocks();
});

describe('connect() single-flight', () => {
  // Regression: THE bug. Two overlapping connects for one account must dial once.
  it('dials once when the same account is connected twice concurrently', async () => {
    const gate = deferred<{ success: boolean }>();
    const api = makeApi(() => gate.promise);
    const { state } = await loadConnectionSlice(storeStubs(), api);

    const first = state.connect(imapConfig('a@example.com'));
    const second = state.connect(imapConfig('a@example.com'));

    expect(api.imap.connect).toHaveBeenCalledTimes(1);

    gate.resolve({ success: true });
    await Promise.all([first, second]);

    // Every side effect in the path ran once, not twice.
    expect(api.imap.connect).toHaveBeenCalledTimes(1);
    expect(api.secureCreds.set).toHaveBeenCalledTimes(1);
    expect(state.loadFolders).toHaveBeenCalledTimes(1);
    expect(state.connected).toBe(true);
  });

  // Regression: coalescing keyed by identity. If it keyed on nothing, a second
  // account connecting while the first is still dialling would silently be
  // dropped and that mailbox would never come online.
  it('dials twice when two different accounts connect concurrently', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<{ success: boolean }>>>();
    const api = makeApi((_config, acctId) => {
      const gate = deferred<{ success: boolean }>();
      gates.set(acctId, gate);
      return gate.promise;
    });
    const { state } = await loadConnectionSlice(storeStubs(), api);

    const first = state.connect(imapConfig('a@example.com'));
    const second = state.connect(imapConfig('b@example.com'));

    expect(api.imap.connect).toHaveBeenCalledTimes(2);
    expect(gates.size).toBe(2);

    gates.forEach((gate) => gate.resolve({ success: true }));
    await Promise.all([first, second]);
    expect(state.accounts).toHaveLength(2);
  });

  // Regression: the in-flight entry must be released when the attempt settles.
  // A leaked entry would mean the account can never reconnect for the life of
  // the app — the failure mode the guard itself would introduce.
  it('allows a later connect once the first one has finished', async () => {
    const api = makeApi(async () => ({ success: true }));
    const { state } = await loadConnectionSlice(storeStubs(), api);

    await state.connect(imapConfig('a@example.com'));
    await state.connect(imapConfig('a@example.com'));

    expect(api.imap.connect).toHaveBeenCalledTimes(2);
  });

  // Regression: a FAILED connect must also release the entry, and the joiner
  // must see the same failure — otherwise a first failure would either wedge the
  // account permanently or report success to the second caller.
  it('rejects both callers and still releases the entry when the connect fails', async () => {
    const api = makeApi(async () => { throw new Error('connect refused'); });
    const { state } = await loadConnectionSlice(storeStubs(), api);

    const first = state.connect(imapConfig('a@example.com'));
    const second = state.connect(imapConfig('a@example.com'));

    await expect(first).rejects.toThrow('connect refused');
    await expect(second).rejects.toThrow('connect refused');
    expect(api.imap.connect).toHaveBeenCalledTimes(1);

    // The account is not wedged: a retry after the failure dials again.
    api.imap.connect.mockImplementation(async () => ({ success: true }));
    await state.connect(imapConfig('a@example.com'));
    expect(api.imap.connect).toHaveBeenCalledTimes(2);
  });

  // Regression: the key is the account's REGISTRY id when it has one. Connecting
  // an existing account under its stored id and its host-derived id must still
  // coalesce, or a reconnect racing a mount would dial twice for one mailbox.
  it('coalesces a reconnect of an account already in the registry', async () => {
    const gate = deferred<{ success: boolean }>();
    const api = makeApi(() => gate.promise);
    const existing = {
      id: 'legacy-id',
      email: 'a@example.com',
      imapConfig: imapConfig('a@example.com'),
      smtpConfig: null,
      smtpConfigured: false,
    };
    const { state } = await loadConnectionSlice(
      { ...storeStubs(), accounts: [existing], activeAccountId: 'legacy-id' },
      api,
    );

    const first = state.connect(imapConfig('a@example.com'));
    const second = state.connect(imapConfig('a@example.com'));

    expect(api.imap.connect).toHaveBeenCalledTimes(1);
    expect(api.imap.connect.mock.calls[0][1]).toBe('legacy-id');

    gate.resolve({ success: true });
    await Promise.all([first, second]);
    expect(state.accounts).toHaveLength(1);
  });
});
