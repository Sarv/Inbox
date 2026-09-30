import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: which account's database a "Load images"
// click, and the renderer's trust caches, read and write. The reading pane can
// show a message of a NON-active account (the unified view); the allowlist is
// keyed by sender address, which exists in every mailbox, so a lenient
// fall-back-to-active would file account B's choice in account A — images then
// auto-load in an account the reader never approved, and never in the one they
// did. The handlers resolve through the strict resolver; the resolver's own
// account semantics are pinned in account-target.test.ts.

const h = vi.hoisted(() => {
  const storageFor = (name: string) => ({
    name,
    allowSenderImages: vi.fn(async () => undefined),
    disallowSenderImages: vi.fn(async () => undefined),
    getImageAllowedSenders: vi.fn(async () => [`boss@${name}.test`]),
    getEmailedAddresses: vi.fn(async () => [`pal@${name}.test`]),
  });
  return {
    handlers: new Map<string, (...a: unknown[]) => unknown>(),
    /** The user's own addresses, as the account registry reports them. */
    ownAddresses: [] as string[],
    active: storageFor('active'),
    accounts: new Map<string, ReturnType<typeof storageFor>>(),
    storageFor,
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(name, fn) },
}));
vi.mock('../../../../electron/services/account-target', () => ({
  // Strict when named (an unknown account throws — it is never the active
  // one), active when not: the contract the handlers rely on.
  requireNamedOrActiveStorage: vi.fn(async (accountId?: string) => {
    if (!accountId) return h.active;
    const storage = h.accounts.get(accountId);
    if (!storage) throw new Error(`Account ${accountId} is not available`);
    return storage;
  }),
}));

vi.mock('../../../../electron/services/accounts-registry', () => ({
  resolveAccountIdentity: vi.fn(() => ({ email: h.ownAddresses[0] ?? '', name: '', aliases: h.ownAddresses })),
}));

import { registerImageTrustHandlers } from '../../../../electron/ipc/image-trust-handlers';

const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args);

beforeEach(() => {
  h.handlers.clear();
  h.ownAddresses = [];
  h.active = h.storageFor('active');
  h.accounts = new Map([['acct-b', h.storageFor('b')]]);
  registerImageTrustHandlers();
});

describe('images:* IPC — per-account routing', () => {
  // Breaks: "Load images" on a unified-view message of account B is saved in
  // the active account A instead.
  it("writes an allowance to the NAMED account's database, not the active one", async () => {
    await expect(call('images:allowSender', 'boss@x.test', 'acct-b')).resolves.toEqual({ success: true });
    expect(h.accounts.get('acct-b')!.allowSenderImages).toHaveBeenCalledWith('boss@x.test');
    expect(h.active.allowSenderImages).not.toHaveBeenCalled();
  });

  // Breaks: an allowance for a removed/unknown account lands in whichever
  // account is active. It must fail, visibly, so the renderer rolls back.
  it('fails for an unknown account instead of falling back to the active one', async () => {
    const res = await call('images:allowSender', 'boss@x.test', 'acct-gone') as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('acct-gone');
    expect(h.active.allowSenderImages).not.toHaveBeenCalled();
  });

  // Breaks: the single-account path (no id) stops working after the change.
  it('keeps using the active account when no id is given', async () => {
    await call('images:allowSender', 'boss@x.test');
    expect(h.active.allowSenderImages).toHaveBeenCalledWith('boss@x.test');
    await expect(call('images:getAllowedSenders')).resolves.toEqual({ success: true, data: ['boss@active.test'] });
    await expect(call('images:getEmailedAddresses')).resolves.toEqual({ success: true, data: ['pal@active.test'] });
  });

  // Breaks: the renderer's per-account caches load another account's lists.
  it("reads each list from the named account's database", async () => {
    await expect(call('images:getAllowedSenders', 'acct-b')).resolves.toEqual({ success: true, data: ['boss@b.test'] });
    await expect(call('images:getEmailedAddresses', 'acct-b')).resolves.toEqual({ success: true, data: ['pal@b.test'] });
    await call('images:disallowSender', '@b.test', 'acct-b');
    expect(h.accounts.get('acct-b')!.disallowSenderImages).toHaveBeenCalledWith('@b.test');
  });

  // Breaks: a note to self (or a reply-all that copied another of the user's
  // addresses) makes the user's OWN address "emailed", and a forged
  // "From: you@…" — the one address every attacker knows — loads its pixels
  // under 'trusted' remote images.
  it("never lists the user's own addresses, from any account, as people they emailed", async () => {
    h.ownAddresses = ['me@active.test', 'Me@B.test'];
    h.active.getEmailedAddresses.mockResolvedValueOnce(['pal@active.test', 'me@active.test', 'me@b.test']);
    await expect(call('images:getEmailedAddresses')).resolves.toEqual({ success: true, data: ['pal@active.test'] });
  });

  // Transient failure: a storage error comes back as success:false (never a
  // throw across IPC and never an empty success), so the renderer keeps its
  // cache cold and retries rather than caching "nobody is allowed".
  it('reports a storage failure as success:false on every channel', async () => {
    h.active.getImageAllowedSenders.mockRejectedValueOnce(new Error('Storage not initialized'));
    h.active.getEmailedAddresses.mockRejectedValueOnce(new Error('Storage not initialized'));
    h.active.disallowSenderImages.mockRejectedValueOnce(new Error('disk full'));
    await expect(call('images:getAllowedSenders')).resolves.toEqual({ success: false, error: 'Storage not initialized' });
    await expect(call('images:getEmailedAddresses')).resolves.toEqual({ success: false, error: 'Storage not initialized' });
    await expect(call('images:disallowSender', 'a@x.test')).resolves.toEqual({ success: false, error: 'disk full' });
    await expect(call('images:getEmailedAddresses', 'acct-gone')).resolves.toMatchObject({ success: false });

    // A write that fails on the ACTIVE account, with a non-Error rejection.
    h.active.allowSenderImages.mockRejectedValueOnce('locked');
    await expect(call('images:allowSender', 'a@x.test')).resolves.toEqual({ success: false, error: 'locked' });
  });
});
