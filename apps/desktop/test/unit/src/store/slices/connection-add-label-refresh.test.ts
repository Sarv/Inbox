import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConnectionSlice, teardownStoreEnv } from './connection-slice-harness';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); teardownStoreEnv(); vi.restoreAllMocks(); });

describe('account activation auxiliary label refresh', () => {
  // Regression: an auxiliary label failure reported successful activation as a
  // failed connection, although the mailbox and initial background sync were live.
  it('keeps a new account connected when loading labels fails', async () => {
    const api = {
      imap: { probeCredentials: vi.fn(async () => ({ success: true })), connect: vi.fn(async () => ({ success: true })),
        removeSyncProgressListener: vi.fn(), onSyncProgress: vi.fn() },
      accounts: { setActive: vi.fn(async () => ({ success: true })) },
      secureCreds: { set: vi.fn(async () => ({ success: true })), get: vi.fn(async () => ({ success: true, data: null })) },
    };
    const { state } = await loadConnectionSlice({
      loadFolders: vi.fn(async () => {}), syncEmails: vi.fn(async () => {}),
      loadLabels: vi.fn(async () => { throw new Error('Label catalog temporarily unavailable'); }),
    }, api);
    const config = { username: 'mail@example.com', host: 'imap.example.com', port: 993, secure: true, password: 'secret' };

    await expect(state.addAccount(config)).resolves.toBeUndefined();
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0].email).toBe('mail@example.com');
    expect(state.activeAccountId).toBe(state.accounts[0].id);
    expect(state.connected).toBe(true);
    expect(state.syncEmails).toHaveBeenCalledOnce();
    expect(state.loadLabels).toHaveBeenCalledOnce();
  });

  // Regression: preserving a connected mailbox must not hide an actual auth failure.
  it('still rejects a failed credential probe before creating an account', async () => {
    const api = { imap: { probeCredentials: vi.fn(async () => ({ success: false, error: 'Credentials rejected' })) } };
    const { state } = await loadConnectionSlice({ loadLabels: vi.fn(async () => {}) }, api);
    await expect(state.addAccount({ username: 'mail@example.com', host: 'imap.example.com' })).rejects.toThrow('Credentials rejected');
    expect(state.accounts).toHaveLength(0);
    expect(state.loadLabels).not.toHaveBeenCalled();
  });
});

describe('mail connection onboarding completion', () => {
  // Regression: connecting email mid-wizard must not hide the optional AI and
  // antivirus steps; ordinary reconnects retain the established completion gate.
  it.each([true, false])('marks completion only outside the pending wizard (pending=%s)', async (pending) => {
    const api = {
      imap: { connect: vi.fn(async () => ({ success: true })), removeSyncProgressListener: vi.fn(), onSyncProgress: vi.fn() },
      secureCreds: { set: vi.fn(async () => ({ success: true })), get: vi.fn(async () => ({ success: true, data: null })) },
    };
    const { state } = await loadConnectionSlice({ loadFolders: vi.fn(async () => {}), syncEmails: vi.fn(async () => {}) }, api, {
      seed: () => { if (pending) localStorage.setItem('sarvinbox-onboarding-pending', 'true'); },
    });
    await state.connect({ username: 'mail@example.com', host: 'imap.example.com', port: 993, secure: true, password: 'secret' });
    expect(localStorage.getItem('sarvinbox-onboarding-complete')).toBe(pending ? null : 'true');
    expect(state.connected).toBe(true);
  });
});
