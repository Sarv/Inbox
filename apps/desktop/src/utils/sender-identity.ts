// Renderer-side cache of sender identities (BIMI standing, favicon, confirmed
// contact photo), keyed by address.
//
// The main process owns the lookups and the durable cache; this is the
// per-session memory that lets a message render its avatar synchronously. A
// miss asks main once — main answers from ITS cache and queues a lookup for
// anything stale — and `identity:updated` refreshes every entry on that
// domain when the lookup lands. A policy change (Settings → General) clears
// everything, so a logo the user just turned off does not linger.
import { useEffect, useState } from 'react';

import type { BimiStanding } from './sender-avatar';

export interface SenderIdentity {
  address: string;
  domain: string | null;
  bimi: {
    status: BimiStanding;
    logo: string | null;
    organization: string | null;
    issuer: string | null;
    detail: string;
    dmarcPolicy: string | null;
    expires: number | null;
  } | null;
  favicon: string | null;
  faviconStatus: 'found' | 'none' | 'error' | null;
  contactPhoto: string | null;
  pending: boolean;
}

/** Dispatched by the settings sync after the policy reached main. */
export const IDENTITY_POLICY_CHANGED_EVENT = 'sarvinbox:identity-policy-changed';

const cache = new Map<string, SenderIdentity>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let subscribed = false;

const notify = () => listeners.forEach((l) => l());

const key = (address: string | null | undefined): string => (address || '').trim().toLowerCase();

async function load(address: string): Promise<void> {
  const running = inflight.get(address);
  if (running) return running;
  const task = (async () => {
    try {
      const res = await identityApi()?.getSender?.(address);
      if (res?.success && res.data) {
        cache.set(address, res.data as SenderIdentity);
        notify();
      }
    } catch {
      // Best-effort: initials render either way.
    } finally {
      inflight.delete(address);
    }
  })();
  inflight.set(address, task);
  return task;
}

/** The preload bridge, or undefined where there is none (tests, a page rendered before preload ran). */
type IdentityApi = NonNullable<Window['electronAPI']>['identity'];
function identityApi(): IdentityApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as { electronAPI?: { identity?: IdentityApi } }).electronAPI?.identity;
}

function subscribeOnce(): void {
  if (subscribed || typeof window === 'undefined') return;
  subscribed = true;
  try {
    identityApi()?.onUpdated?.(({ domain }) => {
      for (const [address, id] of cache) {
        if (id.domain === domain) void load(address);
      }
    });
    window.addEventListener(IDENTITY_POLICY_CHANGED_EVENT, () => clearSenderIdentityCache());
  } catch {
    // No bridge: nothing to subscribe to; initials render regardless.
  }
}

/** Forget everything; every mounted card re-asks main. */
export function clearSenderIdentityCache(): void {
  cache.clear();
  notify(); // every mounted hook sees a miss and asks again
}

/** Synchronous read of what is cached — for code outside React. */
export function getCachedSenderIdentity(address: string | null | undefined): SenderIdentity | null {
  return cache.get(key(address)) ?? null;
}

/**
 * React binding: the identity for an address, null until it is known. Kicks
 * the load on first use and re-renders when it (or the policy) changes.
 */
export function useSenderIdentity(address: string | null | undefined): SenderIdentity | null {
  const k = key(address);
  const [, tick] = useState(0);
  useEffect(() => {
    subscribeOnce();
    const l = () => {
      tick((n) => n + 1);
      // A cleared cache means "ask again" for whatever is on screen.
      if (k && !cache.has(k)) void load(k);
    };
    listeners.add(l);
    if (k && !cache.has(k)) void load(k);
    return () => { listeners.delete(l); };
  }, [k]);
  return k ? cache.get(k) ?? null : null;
}
