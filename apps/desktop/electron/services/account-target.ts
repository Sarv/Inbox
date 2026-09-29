import {
  getAllAccountRuntimes,
  getSyncEngine,
  requireStorage,
  getStorageFor,
  getSyncEngineFor,
  getCurrentAccountId,
} from '../shared';

import { readRegistryAccounts } from './accounts-registry';
import { ensureAccountRuntime } from './accounts-runtime';

type AccountStorage = ReturnType<typeof requireStorage>;
type AccountSyncEngine = ReturnType<typeof getSyncEngine>;

/**
 * Is `accountId` one of the configured accounts? Read with the THROWING
 * registry reader: an unreadable registry and an empty one are the same value
 * and opposite facts, so "could not find out" must surface as an error, never
 * as "not registered" (nor as "registered").
 */
function isRegisteredAccount(accountId: string): boolean {
  return readRegistryAccounts().some((account) => account.id === accountId);
}

/**
 * The storage + sync engine of one SPECIFIC, non-active account: its open
 * runtime, or one opened now. Null when the account cannot be resolved (unknown,
 * held for maintenance, primary not established yet). The one lookup both
 * resolvers below share, so the lenient and the strict answer can never
 * disagree about which database an account id names.
 *
 * `strict` opens a runtime only for an account the registry lists.
 * `ensureAccountRuntime` creates a new, migrated, EMPTY database (plus a sync
 * engine and a registered runtime) for any id it is handed — so a removed
 * account's id arriving late (a background request queued before the account
 * was deleted) would recreate a blank mailbox under the dead id, which then
 * joins every all-accounts loop. A registry that cannot be read throws.
 */
async function lookupAccountRuntime(
  accountId: string,
  { strict = false }: { strict?: boolean } = {},
): Promise<{ storage: AccountStorage; syncEngine: AccountSyncEngine } | null> {
  let storage = getStorageFor(accountId);
  let syncEngine = getSyncEngineFor(accountId);
  if (!storage) {
    if (strict && !isRegisteredAccount(accountId)) return null;
    const rt = await ensureAccountRuntime(accountId);
    storage = rt?.storage ?? null;
    syncEngine = rt?.syncEngine ?? null;
  }
  return storage ? { storage, syncEngine } : null;
}

/**
 * Resolve the storage + sync engine for an operation, honoring a per-row
 * `accountId` when acting on a message from the unified "All Inboxes" view (whose
 * rows can belong to non-active accounts). Falls back to the active account when
 * no accountId is given (the normal single-account path). Ensures the target
 * account's runtime exists first, so we never silently hit the wrong DB — the
 * root cause of the mark-read "Email not found" loop across accounts.
 *
 * LENIENT: an account that cannot be resolved also falls back to the active
 * one. Anything that WRITES data keyed by ids that exist in every account (a
 * thread id is derived from headers, so the same one lives in each account's
 * database) must use {@link requireAccountStorage} instead.
 *
 * Lives here rather than in the IPC module because the `sarv-attachment://`
 * protocol handler needs the same resolution and must not import the IPC layer.
 */
export async function resolveAccountTarget(
  accountId?: string,
): Promise<{ storage: AccountStorage; syncEngine: AccountSyncEngine }> {
  if (accountId && accountId !== getCurrentAccountId()) {
    const found = await lookupAccountRuntime(accountId);
    if (found) return found;
  }
  return { storage: requireStorage(), syncEngine: getSyncEngine() };
}

/**
 * STRICT: the storage of exactly `accountId`, or a throw — NEVER another
 * account's, and never a database created for an id that is not configured.
 *
 *   * the active account → its storage (`requireStorage`);
 *   * another account → its open runtime, or — only when the registry lists
 *     it — one opened now;
 *   * anything else (an unknown or removed account, maintenance, no id) →
 *     throws; an unreadable registry throws too.
 *
 * The lenient {@link resolveAccountTarget} falls back to the active account,
 * which is right for a click on a row and wrong for a cache keyed by thread id:
 * the same thread id exists in every account's database, so a fallback would
 * silently read account A's cached split for account B's thread, or write B's
 * result into A's database. A failed lookup has to be an error the caller sees.
 */
export async function requireAccountStorage(accountId: string): Promise<AccountStorage> {
  if (typeof accountId !== 'string' || accountId === '') {
    throw new Error('requireAccountStorage: an account id is required');
  }
  if (accountId === getCurrentAccountId()) return requireStorage();
  const found = await lookupAccountRuntime(accountId, { strict: true });
  if (!found) throw new Error(`Account ${accountId} is not available`);
  return found.storage;
}

/**
 * Every OPEN account's storage — the active one first, each storage once (the
 * pre-account default slot and the primary's runtime can share one).
 * `accountId` is null for the default slot, which has no id yet; each caller
 * labels it for its own purpose.
 *
 * OPEN runtimes only: a configured account whose runtime is not open this
 * session is NOT listed. Anything that must reach every CONFIGURED account
 * (Settings → Clear Cache) iterates `readRegistryAccounts()` and resolves each
 * one through {@link requireAccountStorage} instead.
 */
export function openAccountStorages(): Array<{ accountId: string | null; storage: AccountStorage }> {
  const seen = new Set<AccountStorage>();
  const out: Array<{ accountId: string | null; storage: AccountStorage }> = [];
  try {
    const active = requireStorage();
    out.push({ accountId: getCurrentAccountId() ?? null, storage: active });
    seen.add(active);
  } catch { /* no active storage yet */ }
  for (const [accountId, rt] of getAllAccountRuntimes()) {
    if (rt.storage && !seen.has(rt.storage)) {
      out.push({ accountId, storage: rt.storage });
      seen.add(rt.storage);
    }
  }
  return out;
}
