/**
 * Mailbox passwords stay in main, and go only to the server they were saved for.
 *
 * The renderer hosts untrusted email HTML and extension panels, so it is never
 * handed a stored password (there is no IPC that returns one, except the Touch
 * ID–gated reveal). Main injects the password itself when it connects. But the
 * connect config — host included — still comes from the renderer, so injection
 * alone would let a compromised renderer ask main to log in to ITS server with
 * the user's real password. Each vault entry therefore carries the host it was
 * saved for, and a password is only ever injected for that exact host.
 *
 * Entries saved before binding existed have no host. They are bound on first
 * use: to the host main's account registry records for that account when it has
 * one, otherwise to the first host asked for (in practice the app's own startup
 * connect from the saved config).
 */
import { accountIdFor, createLogger } from '@sarvinbox/core';

import { readRegistryAccounts, type RegistryAccount } from './accounts-registry';
import { bindAccountSecretHost, getAccountSecrets } from './secure-credential-store';

const logger = createLogger('vault-credentials');

export type VaultCredentialKind = 'imap' | 'smtp';

export type VaultPasswordResult =
  | { status: 'found'; password: string }
  /** A password is saved, but for a different server than the one asked for. */
  | { status: 'host-mismatch'; boundHost: string }
  | { status: 'none' };

/** Lower-cased, trimmed, one trailing root dot removed. */
function normalizeHost(host: string | undefined | null): string {
  const h = (host ?? '').trim().toLowerCase();
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

function registryAccount(id: string): RegistryAccount | undefined {
  // The LOUD read: an unreadable registry must not look like "no record" and
  // let an unbound password be bound to whatever host was asked for.
  return readRegistryAccounts().find((a) => a.id === id);
}

/**
 * Every vault id an account's secret may live under. Legacy accounts were
 * vaulted under the registry id, the host-derived id or the email-only id, so
 * all are tried — safe, because a hit is only used for its bound host.
 */
export function vaultIdCandidates(accountId: string | undefined | null, username: string, host?: string): string[] {
  const ids: (string | undefined | null)[] = [accountId];
  if (accountId) {
    try {
      const acct = registryAccount(accountId);
      if (acct) ids.push(accountIdFor(acct.email, acct.imapConfig?.host));
    } catch (error) {
      logger.warn(`[Vault] account registry unreadable while resolving ids for ${accountId}: ${(error as Error).message}`);
    }
  }
  ids.push(accountIdFor(username, host), accountIdFor(username));
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/**
 * The host an unbound entry should be bound to: the registry's record for that
 * account and kind. `null` = no record (bind to the requested host);
 * `undefined` = the registry could not be read (do not bind at all).
 */
function legacyHostFor(id: string, kind: VaultCredentialKind): string | null | undefined {
  try {
    const acct = registryAccount(id);
    const host = (kind === 'imap' ? acct?.imapConfig?.host : acct?.smtpConfig?.host) as string | undefined;
    return host ? normalizeHost(host) : null;
  } catch (error) {
    logger.warn(`[Vault] account registry unreadable; not binding the saved ${kind} password for ${id}: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * The saved `kind` password for one of `ids`, but only if it was saved for
 * `host`. Never throws for a missing entry; the vault itself being unreadable
 * still throws (as `getAccountSecrets` does) so a caller can't mistake a locked
 * keychain for "no password".
 */
export async function resolveVaultPassword(
  ids: string[],
  kind: VaultCredentialKind,
  host: string | undefined,
): Promise<VaultPasswordResult> {
  const wanted = normalizeHost(host);
  if (!wanted) return { status: 'none' };
  let mismatch: string | undefined;
  for (const id of ids) {
    const entry = (await getAccountSecrets(id))?.[kind];
    if (!entry?.password) continue;
    if (entry.host) {
      if (normalizeHost(entry.host) === wanted) return { status: 'found', password: entry.password };
      mismatch ??= entry.host;
      continue;
    }
    const recorded = legacyHostFor(id, kind);
    if (recorded === undefined) continue;
    if (recorded !== null && recorded !== wanted) {
      mismatch ??= recorded;
      continue;
    }
    await bindAccountSecretHost(id, kind, wanted);
    logger.info(`[Vault] bound the saved ${kind} password for ${id} to ${wanted}${recorded ? ' (from the account registry)' : ' (first use)'}`);
    return { status: 'found', password: entry.password };
  }
  if (mismatch) {
    logger.warn(`[Vault] refused the saved ${kind} password for host "${wanted}" — it was saved for "${mismatch}"`);
    return { status: 'host-mismatch', boundHost: mismatch };
  }
  return { status: 'none' };
}

/** User-facing reason a connect could not use the saved password. */
export function hostMismatchMessage(kind: VaultCredentialKind, host: string, boundHost: string): string {
  const what = kind === 'imap' ? 'mailbox' : 'sending';
  return `Your saved ${what} password is for ${boundHost}. Re-enter your password to connect to ${host}.`;
}
