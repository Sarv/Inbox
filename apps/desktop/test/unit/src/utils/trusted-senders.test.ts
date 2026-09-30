import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setActiveCacheAccount } from '../../../../src/utils/account-scoped-cache';
import {
  isTrustedSender,
  isTrustedSenderIn,
  reloadTrustedSenders,
  resetTrustedSenders,
  trustedSendersCache,
  trustSender,
  untrustSender,
} from '../../../../src/utils/trusted-senders';

/**
 * The renderer's copy of the trusted-sender list. The shield reads it
 * synchronously while a message renders, so it must hold the ACTIVE account's
 * list — and only that account's. A list left over from the previous account
 * would lift the warning off a sender this account never trusted.
 */

let lists: Record<string, Array<{ email: string; createdAt: number }>>;
let active: string;

beforeEach(() => {
  lists = { a: [{ email: 'alerts@axis.bank.in', createdAt: 1 }], b: [] };
  active = 'a';
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      spam: {
        listTrustedSenders: vi.fn(async () => ({ success: true, data: lists[active] })),
        trustSender: vi.fn(async (address: string) => {
          lists[active] = [{ email: address, createdAt: 2 }, ...lists[active]];
          return { success: true };
        }),
        untrustSender: vi.fn(async (address: string) => {
          lists[active] = lists[active].filter((s) => s.email !== address);
          return { success: true };
        }),
      },
    },
  };
});

afterEach(() => resetTrustedSenders());

describe('trusted-senders (renderer cache)', () => {
  it('answers from the loaded list, matching "Name <addr>" and case', async () => {
    await reloadTrustedSenders();
    expect(isTrustedSender('alerts@axis.bank.in')).toBe(true);
    expect(isTrustedSender('Axis Bank <ALERTS@axis.bank.in>')).toBe(true);
    expect(isTrustedSender('offers@axis.bank.in')).toBe(false);
    expect(isTrustedSender(null)).toBe(false);
  });

  // Multi-account regression: switching accounts must drop the old list.
  it('forgets the previous account\'s list on reset', async () => {
    await reloadTrustedSenders();
    expect(isTrustedSender('alerts@axis.bank.in')).toBe(true);
    active = 'b';
    resetTrustedSenders();
    expect(isTrustedSender('alerts@axis.bank.in')).toBe(false);
    await reloadTrustedSenders();
    expect(isTrustedSender('alerts@axis.bank.in')).toBe(false);
  });

  it('trusts and untrusts through the main process, and reflects both', async () => {
    await reloadTrustedSenders();
    expect(await trustSender('Bank <new@bank.example>')).toEqual({ success: true, error: undefined });
    expect(window.electronAPI.spam.trustSender).toHaveBeenCalledWith('new@bank.example', undefined);
    expect(isTrustedSender('new@bank.example')).toBe(true);

    await untrustSender('new@bank.example');
    expect(isTrustedSender('new@bank.example')).toBe(false);
  });

  // A blank address is refused before any IPC — nothing to trust.
  it('refuses a blank address', async () => {
    expect(await trustSender('  ')).toEqual({ success: false, error: 'No sender address to trust' });
    expect(window.electronAPI.spam.trustSender).not.toHaveBeenCalled();
  });

  // Transient failure: a thrown IPC comes back as a failure the banner can
  // show, and the list re-reads the truth (the sender was NOT stored).
  it('reports a thrown IPC as a failure and re-reads the truth', async () => {
    (window.electronAPI.spam.trustSender as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ipc gone'));
    const res = await trustSender('new@bank.example');
    expect(res).toEqual({ success: false, error: 'ipc gone' });
    expect(isTrustedSender('new@bank.example')).toBe(false);
  });
});

describe('trusted-senders — per account', () => {
  let byAccount: Record<string, Array<{ email: string; createdAt: number }>>;

  beforeEach(() => {
    byAccount = { 'acct-a': [{ email: 'alerts@axis.bank.in', createdAt: 1 }], 'acct-b': [] };
    (globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        spam: {
          listTrustedSenders: vi.fn(async (accountId?: string) => ({ success: true, data: byAccount[accountId ?? 'acct-a'] ?? [] })),
          trustSender: vi.fn(async (address: string, accountId?: string) => {
            byAccount[accountId ?? 'acct-a'] = [{ email: address, createdAt: 2 }, ...(byAccount[accountId ?? 'acct-a'] ?? [])];
            return { success: true };
          }),
          untrustSender: vi.fn(async () => ({ success: true })),
        },
      },
    };
    setActiveCacheAccount('acct-a');
  });

  afterEach(() => setActiveCacheAccount(null));

  // Multi-account: the unified view shows account B's message while A is
  // active. Its sender's trust is B's list — A's trust must not vouch for it
  // (remote images "From trusted senders" read this), and trusting it from B's
  // message must land in B, not in the active account.
  it("answers and writes per account, never through the active account's list", async () => {
    await trustedSendersCache.reload('acct-a');
    await trustedSendersCache.reload('acct-b');
    expect(isTrustedSender('alerts@axis.bank.in')).toBe(true); // active = A
    expect(isTrustedSenderIn('acct-b', 'alerts@axis.bank.in')).toBe(false);

    await trustSender('Pal <pal@b.test>', 'acct-b');
    expect(window.electronAPI.spam.trustSender).toHaveBeenCalledWith('pal@b.test', 'acct-b');
    expect(isTrustedSenderIn('acct-b', 'pal@b.test')).toBe(true);
    expect(isTrustedSender('pal@b.test')).toBe(false);
  });

  // A call that names no account acts on the active account BY ID, so a
  // trust clicked just before an account switch cannot land in the new one.
  it('names the active account explicitly when the caller names none', async () => {
    await trustSender('new@bank.example');
    expect(window.electronAPI.spam.trustSender).toHaveBeenCalledWith('new@bank.example', 'acct-a');
  });

  // Breaks: a trust main refused keeps lifting the warning (and loading the
  // sender's images) for the session although it was never stored.
  it('rolls back a trust main refused, and reports why', async () => {
    await trustedSendersCache.reload('acct-b');
    (window.electronAPI.spam.trustSender as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'db busy' });
    await expect(trustSender('pal@b.test', 'acct-b')).resolves.toEqual({ success: false, error: 'db busy' });
    expect(isTrustedSenderIn('acct-b', 'pal@b.test')).toBe(false);
  });

  // Breaks: removing a trust (Security page) with a blank address calls main
  // with garbage, or a removal main refused vanishes from the list anyway.
  it('ignores a blank removal, and rolls back one main refused', async () => {
    await trustedSendersCache.reload('acct-a');
    await untrustSender('   ');
    expect(window.electronAPI.spam.untrustSender).not.toHaveBeenCalled();

    (window.electronAPI.spam.untrustSender as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false });
    await untrustSender('alerts@axis.bank.in');
    expect(window.electronAPI.spam.untrustSender).toHaveBeenCalledWith('alerts@axis.bank.in', 'acct-a');
    expect(isTrustedSenderIn('acct-a', 'alerts@axis.bank.in')).toBe(true);
  });

  // Breaks: reporting a sender as spam untrusts them in main, but the renderer
  // kept its copy — their other mail stayed "trusted" (the shield's pass,
  // 'trusted' remote images) until a restart. The report re-reads the list.
  it("re-reads one account's list on request, keeping it on a failure", async () => {
    await trustedSendersCache.reload('acct-b');
    byAccount['acct-b'] = [{ email: 'spammy@b.test', createdAt: 3 }];
    await reloadTrustedSenders('acct-b');
    expect(isTrustedSenderIn('acct-b', 'spammy@b.test')).toBe(true);
    byAccount['acct-b'] = [];
    await reloadTrustedSenders('acct-b');
    expect(isTrustedSenderIn('acct-b', 'spammy@b.test')).toBe(false);

    // A list main answers without success (no reason given) is not "empty":
    // the copy it had stays until a read succeeds.
    byAccount['acct-b'] = [{ email: 'kept@b.test', createdAt: 4 }];
    await reloadTrustedSenders('acct-b');
    (window.electronAPI.spam.listTrustedSenders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false });
    await reloadTrustedSenders('acct-b');
    expect(isTrustedSenderIn('acct-b', 'kept@b.test')).toBe(true);
  });

  // Transient failure: a list that could not be read is "not known yet" (the
  // shield and the image rule stay conservative) and is re-read — it is never
  // cached as "you trust nobody".
  it('keeps a failed load unknown and loads it on the retry', async () => {
    vi.useFakeTimers();
    try {
      (window.electronAPI.spam.listTrustedSenders as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Storage not initialized'));
      expect(isTrustedSender('alerts@axis.bank.in')).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(trustedSendersCache.isLoaded('acct-a')).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(isTrustedSender('alerts@axis.bank.in')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
