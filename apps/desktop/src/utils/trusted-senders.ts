// Renderer-side cache of the senders the user trusts ("Trust this sender").
//
// The security level is computed synchronously while a message renders (see
// email-security.ts), and so is the remote-image decision (remote-images.ts),
// so the list they consult must already be in memory — the same reason the
// link rules (security-rules.ts) and the image allowlist are cached. PER
// ACCOUNT (account-scoped-cache.ts): the unified view shows another account's
// message in the reading pane, and that account's list is the one that counts
// for it. A read with no account means the active one; the account-switch
// paths repoint "active" (see setImageTrustAccount in remote-images.ts).
//
// What trust DOES is decided elsewhere, once each: the ingest path stores an
// authenticated trusted message as not-spam and never files it, the shield
// sets the name and score checks aside for it, and remote images load for it
// while the reader has "From trusted senders" on. This file only answers "is this address trusted?" and
// carries the user's clicks to the main process.

import { bareSenderAddress } from '@sarvinbox/core/image-allowlist';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { createAccountScopedCache, resolveCacheAccount } from './account-scoped-cache';

export interface TrustedSender {
  email: string;
  createdAt: number;
}

/** Every account's trusted senders — observable (subscribe / getVersion). */
export const trustedSendersCache = createAccountScopedCache<TrustedSender>({
  name: 'trusted-senders',
  load: async (accountId) => {
    const res = await window.electronAPI.spam.listTrustedSenders(accountId);
    if (!res?.success || !Array.isArray(res.data)) throw new Error(res?.error || 'listTrustedSenders failed');
    return res.data;
  },
  keyOf: (sender) => bareSenderAddress(sender.email),
});

/** Is this sender trusted in the ACTIVE account? Synchronous; false until the first load lands. */
export const isTrustedSender = (address?: string | null): boolean => isTrustedSenderIn(undefined, address);

/** Is this sender trusted in `accountId` (undefined = the active account)? */
export const isTrustedSenderIn = (accountId: string | null | undefined, address?: string | null): boolean => {
  const addr = bareSenderAddress(address);
  return !!addr && trustedSendersCache.has(accountId, addr);
};

/** Fetch one account's list (none = the active one). Coalesces concurrent
 *  callers into one request; never rejects — a failure keeps the list shown. */
export const reloadTrustedSenders = (accountId?: string | null): Promise<void> => trustedSendersCache.reload(accountId);

/**
 * Forget every account's list. Mounted views re-render (the cache notifies) and
 * re-load what they show, so nothing is left showing a stale list.
 */
export const resetTrustedSenders = (): void => trustedSendersCache.clear();

/**
 * "Trust this sender", in the message's own account. Applied optimistically so
 * the banner the user just clicked clears on the spot, and rolled back if the
 * main process refuses it. Only the sender: the message itself is cleared by
 * the caller through the ordinary Not spam path. Returns the main process's
 * answer so the caller can report a failure.
 */
export const trustSender = async (
  address: string | null | undefined,
  accountId?: string,
): Promise<{ success: boolean; error?: string }> => {
  const addr = bareSenderAddress(address);
  if (!addr) return { success: false, error: 'No sender address to trust' };
  const account = resolveCacheAccount(accountId);
  let error: string | undefined;
  try {
    const stored = await trustedSendersCache.write(
      account,
      { add: { email: addr, createdAt: Math.floor(Date.now() / 1000) } },
      async () => {
        try {
          const res = await window.electronAPI.spam.trustSender(addr, account);
          error = res?.error;
          return !!res?.success;
        } catch (e) {
          error = (e as Error)?.message ?? String(e);
          return false;
        }
      },
    );
    return { success: stored, error };
  } finally {
    await trustedSendersCache.reload(account);
  }
};

/** Withdraw trust (the Security page's remove), in the active account unless named. */
export const untrustSender = async (address: string, accountId?: string): Promise<void> => {
  const addr = bareSenderAddress(address);
  if (!addr) return;
  const account = resolveCacheAccount(accountId);
  try {
    await trustedSendersCache.write(account, { remove: addr }, async () => {
      const res = await window.electronAPI.spam.untrustSender(address, account);
      return !!res?.success;
    });
  } finally {
    await trustedSendersCache.reload(account);
  }
};

/**
 * React binding for one account's list (none = the active one): re-renders
 * when it changes, and triggers its first load. `isTrusted` answers for THAT
 * account — a message's own, so the shield, the warning banner and the
 * remote-image decision agree about who is trusted for it.
 */
export function useTrustedSenders(accountId?: string | null): {
  senders: readonly TrustedSender[];
  isTrusted: (address?: string | null) => boolean;
} {
  useSyncExternalStore(trustedSendersCache.subscribe, trustedSendersCache.getVersion, trustedSendersCache.getVersion);
  useEffect(() => { trustedSendersCache.ensure(accountId); }, [accountId]);
  const isTrusted = useCallback((address?: string | null) => isTrustedSenderIn(accountId, address), [accountId]);
  return { senders: trustedSendersCache.items(accountId), isTrusted };
}
