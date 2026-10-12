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
 * The same goes for HOW it is sent. A self-signed server needs certificate
 * checks off ("allow self-signed"), and a server without encryption needs
 * connection security 'none'. Either one hands the password to anyone on the
 * network path, and both used to come in with the config. So each entry also
 * records the relaxations the user chose when typing that password, and main
 * sends it over a connection at least that strict: a config may tighten them,
 * never loosen them (a looser one is refused with "re-enter your password").
 * When a stricter connection works, the relaxations it did without are
 * switched off for good. OAuth needs none of this: core always verifies an
 * OAuth connection and never sends a token unencrypted.
 *
 * Entries saved before either binding existed lack those fields. They are bound
 * on first use, from what main's account registry recorded for that account
 * when this process started — before the window could write to it — and never
 * from the connect asking. With no record: the host is the one first asked for
 * (as since host binding shipped), and the transport is the strict one.
 */
import {
  accountIdFor,
  createLogger,
  limitTransport,
  STRICT_TRANSPORT,
  transportOptInBeyond,
  transportOptInsOf,
  type TransportOptIns,
  type TransportResolvable,
} from '@sarvinbox/core';

import { readRegistryAccounts, type RegistryAccount } from './accounts-registry';
import {
  bindAccountSecretHost,
  bindAccountSecretTransport,
  getAccountSecrets,
  narrowAccountSecretTransport,
  type VaultCredential,
  type VaultTransportField,
} from './secure-credential-store';

const logger = createLogger('vault-credentials');

export type VaultCredentialKind = 'imap' | 'smtp';

/** A saved password main may send to the host asked for, and how. */
export interface VaultPasswordFound {
  status: 'found';
  password: string;
  /** The relaxations saved with it — the most a connection using it may have. */
  transport: TransportOptIns;
  /** The vault id it was found under. */
  id: string;
}

export type VaultPasswordResult =
  | VaultPasswordFound
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
 * The account registry as it stood when this process started, by id. The
 * window writes the registry (accounts:save), so a binding taken from the live
 * registry would be one a compromised window chose — for any saved password
 * the app had not happened to use yet (another account's sending password, an
 * account without background sync). `undefined` = not captured, or the
 * registry could not be read then: legacy entries are then left unused.
 */
let registryAtStartup: Map<string, RegistryAccount> | undefined;

/**
 * Snapshot the registry for binding legacy vault entries. Call once at
 * startup, after the registry is seeded and BEFORE any IPC handler or window
 * exists.
 */
export function captureRegistryForLegacyBinding(): void {
  try {
    registryAtStartup = new Map(readRegistryAccounts().map((a) => [a.id, a]));
  } catch (error) {
    registryAtStartup = undefined;
    logger.warn(`[Vault] account registry unreadable at startup; saved passwords from older versions stay unused until the next start: ${(error as Error).message}`);
  }
}

/** The startup record for `id`: null = no record; undefined = no snapshot. */
function startupRecord(id: string): RegistryAccount | null | undefined {
  return registryAtStartup ? (registryAtStartup.get(id) ?? null) : undefined;
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
 * The host an unbound entry should be bound to: the startup registry's record
 * for that account and kind. `null` = no record (bind to the requested host);
 * `undefined` = no startup snapshot (do not bind at all).
 */
function legacyHostFor(id: string, kind: VaultCredentialKind): string | null | undefined {
  const acct = startupRecord(id);
  if (acct === undefined) return undefined;
  const host = (kind === 'imap' ? acct?.imapConfig?.host : acct?.smtpConfig?.host) as string | undefined;
  return host ? normalizeHost(host) : null;
}

const TRANSPORT_FIELDS: readonly VaultTransportField[] = ['allowInsecureTLS', 'allowPlaintext'];

/**
 * The relaxations an entry saved before transport binding should be bound to:
 * what the startup registry's config for that account and kind asks for, or
 * none at all when it has no such config. `undefined` = no startup snapshot
 * (neither use nor bind the entry).
 */
function legacyTransportFor(id: string, kind: VaultCredentialKind): TransportOptIns | undefined {
  const acct = startupRecord(id);
  if (acct === undefined) {
    logger.warn(`[Vault] no startup snapshot of the account registry; not using the saved ${kind} password for ${id}`);
    return undefined;
  }
  const config = (kind === 'imap' ? acct?.imapConfig : acct?.smtpConfig) as TransportResolvable | null | undefined;
  return config ? transportOptInsOf(config) : STRICT_TRANSPORT;
}

/** The relaxations saved with `entry`, binding a legacy entry on first use. */
async function savedTransport(id: string, kind: VaultCredentialKind, entry: VaultCredential): Promise<TransportOptIns | undefined> {
  if (TRANSPORT_FIELDS.every((k) => typeof entry[k] === 'boolean')) {
    return { allowInsecureTLS: entry.allowInsecureTLS === true, allowPlaintext: entry.allowPlaintext === true };
  }
  const legacy = legacyTransportFor(id, kind);
  if (!legacy) return undefined;
  const bound: TransportOptIns = {
    allowInsecureTLS: typeof entry.allowInsecureTLS === 'boolean' ? entry.allowInsecureTLS : legacy.allowInsecureTLS,
    allowPlaintext: typeof entry.allowPlaintext === 'boolean' ? entry.allowPlaintext : legacy.allowPlaintext,
  };
  await bindAccountSecretTransport(id, kind, bound);
  logger.info(`[Vault] bound how the saved ${kind} password for ${id} is sent: self-signed ${bound.allowInsecureTLS ? 'allowed' : 'refused'}, unencrypted ${bound.allowPlaintext ? 'allowed' : 'refused'}`);
  return bound;
}

/**
 * The saved `kind` password for one of `ids`, but only if it was saved for
 * `host`, with the relaxations saved alongside it. Never throws for a missing
 * entry; the vault itself being unreadable still throws (as
 * `getAccountSecrets` does) so a caller can't mistake a locked keychain for
 * "no password".
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
      if (normalizeHost(entry.host) !== wanted) {
        mismatch ??= entry.host;
        continue;
      }
    } else {
      const recorded = legacyHostFor(id, kind);
      if (recorded === undefined) continue;
      if (recorded !== null && recorded !== wanted) {
        mismatch ??= recorded;
        continue;
      }
      await bindAccountSecretHost(id, kind, wanted);
      logger.info(`[Vault] bound the saved ${kind} password for ${id} to ${wanted}${recorded ? ' (from the account registry)' : ' (first use)'}`);
    }
    const transport = await savedTransport(id, kind, entry);
    if (!transport) continue;
    return { status: 'found', password: entry.password, transport, id };
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

/** User-facing reason a connect could not use the saved password the way it asked to. */
export function transportMismatchMessage(kind: VaultCredentialKind, host: string, beyond: 'insecure-tls' | 'plaintext'): string {
  const what = kind === 'imap' ? 'mailbox' : 'sending';
  return beyond === 'insecure-tls'
    ? `Your saved ${what} password was saved for a connection that checks ${host}'s certificate. Re-enter your password to connect without checking it.`
    : `Your saved ${what} password was saved for an encrypted connection to ${host}. Re-enter your password to connect without encryption.`;
}

/**
 * `config` with the saved password in it, sent no more loosely than it was
 * saved for — or, when the config asks for a relaxation the password was not
 * saved with, the message telling the user to re-enter it. Never dial on a
 * refusal: retrying can't change it.
 */
export function withSavedPassword<C extends TransportResolvable & { host: string; password?: string }>(
  config: C,
  kind: VaultCredentialKind,
  saved: VaultPasswordFound,
): { config: C } | { refusal: string } {
  const beyond = transportOptInBeyond(transportOptInsOf(config), saved.transport);
  if (beyond) return { refusal: transportMismatchMessage(kind, config.host, beyond) };
  return { config: limitTransport({ ...config, password: saved.password }, saved.transport) };
}

/**
 * After a connection with the saved password succeeded, switch off the
 * relaxations it was saved with but did not use: a verified (or encrypted)
 * connection to that server just worked, so nothing needs them, and the user's
 * stricter choice now holds even if a later config asks to loosen it again.
 * Best-effort — a failed write only means the relaxation stays.
 */
export async function narrowSavedTransport(
  kind: VaultCredentialKind,
  saved: VaultPasswordFound,
  used: TransportResolvable,
): Promise<void> {
  const usedOptIns = transportOptInsOf(used);
  const unused = TRANSPORT_FIELDS.filter((k) => saved.transport[k] && !usedOptIns[k]);
  if (!unused.length) return;
  try {
    await narrowAccountSecretTransport(saved.id, kind, saved.password, unused);
    logger.info(`[Vault] the saved ${kind} password for ${saved.id} connected without ${unused.join(' and ')}; switched it off`);
  } catch (error) {
    logger.warn(`[Vault] could not switch off ${unused.join(' and ')} for ${saved.id}: ${(error as Error).message}`);
  }
}
