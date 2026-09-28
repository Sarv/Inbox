// Renderer-side cache of the senders the user trusts ("Trust this sender").
//
// The security level is computed synchronously while a message renders (see
// email-security.ts), so the list it consults must already be in memory — the
// same reason the link rules (security-rules.ts) and the image allowlist
// (store/helpers.ts) are cached. Per account: the account-switch paths call
// {@link resetTrustedSenders}, and the next render re-loads for the new one.
//
// What trust DOES is decided elsewhere, once each: the ingest path stores an
// authenticated trusted message as not-spam and never files it, and the shield
// sets the name and score checks aside for it. This file only answers "is this
// address trusted?" and carries the user's clicks to the main process.

import { bareSenderAddress } from '@sarvinbox/core/image-allowlist';
import { useEffect, useState } from 'react';

export interface TrustedSender {
  email: string;
  createdAt: number;
}

let senders: TrustedSender[] = [];
let addresses = new Set<string>();
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const rebuild = () => {
  addresses = new Set(senders.map((s) => s.email.toLowerCase()));
  listeners.forEach((l) => l());
};

/** Is this sender trusted? Synchronous; false until the first load lands. */
export const isTrustedSender = (address?: string | null): boolean => {
  const addr = bareSenderAddress(address);
  return !!addr && addresses.has(addr);
};

export const getTrustedSenders = (): TrustedSender[] => senders;

/** Fetch from the active account's DB. Coalesces concurrent callers into one request. */
export const reloadTrustedSenders = (): Promise<void> => {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await window.electronAPI.spam?.listTrustedSenders?.();
      if (res?.success && Array.isArray(res.data)) senders = res.data;
    } catch { /* best-effort: keep whatever we had */ }
    loaded = true;
    rebuild();
    inflight = null;
  })();
  return inflight;
};

/** Kick the initial load exactly once; safe to call from any render. */
export const ensureTrustedSendersLoaded = (): void => {
  if (!loaded && !inflight) void reloadTrustedSenders();
};

/**
 * Forget the list — on account switch, since it is per account. Mounted views
 * re-load it straight away, so nothing is left showing the previous account's.
 */
export const resetTrustedSenders = (): void => {
  senders = [];
  loaded = false;
  rebuild();
  if (listeners.size > 0) void reloadTrustedSenders();
};

/**
 * "Trust this sender". Applied optimistically so the banner the user just
 * clicked clears on the spot. Only the sender: the message itself is cleared by
 * the caller through the ordinary Not spam path. Returns the main process's
 * answer so the caller can report a failure.
 */
export const trustSender = async (
  address: string | null | undefined,
  accountId?: string,
): Promise<{ success: boolean; error?: string }> => {
  const addr = bareSenderAddress(address);
  if (!addr) return { success: false, error: 'No sender address to trust' };
  if (!addresses.has(addr)) {
    senders = [{ email: addr, createdAt: Math.floor(Date.now() / 1000) }, ...senders];
    rebuild();
  }
  try {
    const res = await window.electronAPI.spam.trustSender(addr, accountId);
    return { success: !!res?.success, error: res?.error };
  } catch (error) {
    return { success: false, error: (error as Error)?.message ?? String(error) };
  } finally {
    await reloadTrustedSenders();
  }
};

/** Withdraw trust (the Security page's remove). */
export const untrustSender = async (address: string): Promise<void> => {
  const addr = bareSenderAddress(address);
  senders = senders.filter((s) => s.email.toLowerCase() !== addr);
  rebuild();
  try {
    await window.electronAPI.spam.untrustSender(address);
  } finally {
    await reloadTrustedSenders();
  }
};

/** React binding: re-renders when the list changes. Triggers the initial load. */
export function useTrustedSenders(): { senders: TrustedSender[]; isTrusted: (address?: string | null) => boolean } {
  const [, tick] = useState(0);
  useEffect(() => {
    ensureTrustedSendersLoaded();
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return { senders, isTrusted: isTrustedSender };
}
