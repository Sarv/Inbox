import { createLogger, getEventBus } from '@sarvinbox/core';

import { getMainWindow } from '../shared';

import { openAccountStorages } from './account-target';
import { listRegistryAccounts, resolveAccountEmail } from './accounts-registry';

const logger = createLogger('contact-classification');
const refreshed = new WeakMap<object, { at: number; identities: string }>();
const REFRESH_INTERVAL_MS = 30_000;
let eventUnsubscribers: Array<() => void> = [];
let eventRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/** One bounded refresh per arrival burst, even while Contacts is closed. */
export function startContactClassificationRefresh(): void {
  if (eventUnsubscribers.length) return;
  const schedule = () => {
    if (eventRefreshTimer) return;
    eventRefreshTimer = setTimeout(() => {
      eventRefreshTimer = null;
      refreshContactClassifications(undefined, true);
    }, REFRESH_INTERVAL_MS);
    eventRefreshTimer.unref?.();
  };
  const bus = getEventBus();
  eventUnsubscribers = [bus.on('email:synced' as any, schedule), bus.on('email:body-ready' as any, schedule)];
}

export function stopContactClassificationRefresh(): void {
  for (const unsubscribe of eventUnsubscribers) unsubscribe();
  eventUnsubscribers = [];
  if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
  eventRefreshTimer = null;
}

/** The shared directory must recognise every connected business identity. */
export function contactClassificationIdentities(fallback?: string): string[] {
  const identities = new Set(listRegistryAccounts().map((account) => account.email).filter(Boolean));
  for (const { storage } of openAccountStorages()) {
    try {
      const email = resolveAccountEmail(storage);
      if (email) identities.add(email);
    } catch { /* one unavailable identity must not abort another account's scan */ }
  }
  // The caller's profile is only a fallback when no account identity exists.
  if (!identities.size && fallback) identities.add(fallback);
  return [...identities].sort();
}

/** Refresh local evidence without an AI provider or a connection to the server. */
export function refreshContactClassifications(fallback?: string, force = false): number {
  const identities = contactClassificationIdentities(fallback);
  const key = JSON.stringify(identities);
  const now = Date.now();
  const accounts = openAccountStorages();
  if (!force && accounts.every(({ storage }) => {
    const previous = refreshed.get(storage);
    return previous?.identities === key && now - previous.at < REFRESH_INTERVAL_MS;
  })) return 0;
  const evidence = new Map<string, Record<string, boolean>>();
  // Read every account BEFORE committing to the shared directory. Otherwise a
  // mailbox with no mail for this contact can erase another account's evidence.
  try {
    for (const { storage } of accounts) {
      const local = (storage as any).getRepositories().agent.getContactClassificationEvidence(identities) as Map<string, Record<string, boolean>>;
      for (const [email, signals] of local) {
        const combined = evidence.get(email) ?? {};
        for (const [signal, present] of Object.entries(signals)) combined[signal] ||= present;
        evidence.set(email, combined);
      }
    }
  } catch (error) {
    logger.warn('Could not read complete contact relationship evidence:', (error as Error).message);
    return 0;
  }
  let changed = 0;
  for (const { storage } of accounts) {
    try {
      const count = (storage as any).getRepositories().agent.autoClassifyContacts(identities, evidence);
      changed += count;
      refreshed.set(storage, { at: now, identities: key });
    } catch (error) {
      logger.warn('Could not refresh contact relationships:', (error as Error).message);
    }
  }
  if (changed > 0) {
    try {
      const window = getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send('contacts:updated');
    } catch { /* the window may have closed after the database update */ }
  }
  return changed;
}
