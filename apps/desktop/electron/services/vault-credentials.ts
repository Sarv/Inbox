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
 * from the connect asking. With no record of the transport, it is the strict
 * one. With no record of the host: see `legacyHostDecision`, which never takes
 * the host from the connect on its own word. Only passwords ever go through here;
 * an OAuth token's destination is checked against its provider's own servers by
 * `assertOAuthMailHost`, and an entry holding only a token is never returned.
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
import { getDomain } from 'tldts';

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
  /**
   * A password from before host binding is saved, but nothing says which server it
   * is for, so it is not used. Settled, like a mismatch: waiting cannot change it,
   * and the user has to re-enter it.
   */
  | { status: 'unknown-server' }
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
  warnedOnce.clear();
  try {
    registryAtStartup = new Map(readRegistryAccounts().map((a) => [a.id, a]));
  } catch (error) {
    registryAtStartup = undefined;
    logger.warn(`[Vault] account registry unreadable at startup; saved passwords from older versions stay unused until the next start: ${(error as Error).message}`);
  }
}

/**
 * Refusals a lookup repeats on every poll. A connect at startup re-reads the vault
 * every 150 ms while it waits for the keychain, so a plain warning here came out
 * dozens of times per id per attempt. Cleared with each startup snapshot.
 */
const warnedOnce = new Set<string>();

function warnOnce(message: string): void {
  if (warnedOnce.has(message)) return;
  warnedOnce.add(message);
  logger.warn(message);
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
 * Every id a password saved for this account may sit under: its registry id, and
 * the variants older versions derived from its address and server. The same set
 * `vaultIdCandidates` looks under, seen from the account's side.
 */
function legacyVaultIdsOf(acct: RegistryAccount): Set<string> {
  const imapConfig = acct.imapConfig as { host?: string; username?: string } | null | undefined;
  const smtpConfig = acct.smtpConfig as { host?: string; username?: string } | null | undefined;
  const ids = new Set([acct.id]);
  for (const username of [acct.email, imapConfig?.username, smtpConfig?.username]) {
    if (!username) continue;
    ids.add(accountIdFor(username));
    if (imapConfig?.host) ids.add(accountIdFor(username, imapConfig.host));
    if (smtpConfig?.host) ids.add(accountIdFor(username, smtpConfig.host));
  }
  return ids;
}

/** The startup registry's accounts a password under `id` may belong to; undefined = no snapshot. */
function startupOwners(id: string): RegistryAccount[] | undefined {
  return registryAtStartup && [...registryAtStartup.values()].filter((a) => legacyVaultIdsOf(a).has(id));
}

/** An account's recorded config for one kind of credential. */
function configOf(acct: RegistryAccount, kind: VaultCredentialKind): (TransportResolvable & { host?: string }) | null | undefined {
  return (kind === 'imap' ? acct.imapConfig : acct.smtpConfig) as (TransportResolvable & { host?: string }) | null | undefined;
}

/**
 * The site two of one account's mail servers have to share. Not core's `siteOf`,
 * which reads `duckdns.org` or `github.io` as one site, right for what it decides but
 * not here: this says "the same provider", and everyone under those suffixes is a
 * different customer. So private suffixes count, and `me.duckdns.org` is its own site.
 * A host with no registrable domain (an IP, `localhost`, a bare `co.uk`) only matches itself.
 */
const providerSiteOf = (host: string): string => getDomain(host, { allowPrivateDomains: true }) ?? host;

/** Whether an unbound entry may be used for, and bound to, the host asked for. */
type LegacyHostDecision =
  | { outcome: 'bind'; because: string }
  /** It belongs to `boundHost`, which the startup registry records for it. */
  | { outcome: 'other-server'; boundHost: string }
  /** The startup registry was read, and does not say this host is its server. */
  | { outcome: 'unknown-server' }
  /** The registry could not be read at startup, so nothing can be said yet. */
  | { outcome: 'no-snapshot' };

/**
 * May an entry saved before host binding go to `wanted`? Answered only from the
 * registry as it stood at startup, because the connect asking comes from the
 * renderer, which hosts untrusted mail. If the connect's word were enough, a
 * compromised renderer could get an unbound password sent to its own server by
 * being the first to ask for it. That is most reachable for a password nothing
 * else will ever bind: an old account's entry left behind in the vault.
 *
 *   - The startup registry records this account's server for this kind: that host.
 *   - It records only the account's OTHER server (a sending password on an account
 *     whose sending settings were never recorded): a host on the same site as that
 *     one. smtp.x.com goes with imap.x.com. A server elsewhere (a relay, or a pair
 *     like imap.icloud.com and smtp.mail.me.com) is refused with "re-enter your
 *     password", which is the only cost, and binds it for good.
 *   - No account at startup accounts for this entry: nobody the user knows of is
 *     waiting on it, so it stays unused and unbound, and re-entering it fixes it.
 *   - The registry could not be read at startup: unused until a start when it can
 *     be. That is unknown, not "no record", so the user is not asked to do anything.
 */
function legacyHostDecision(id: string, kind: VaultCredentialKind, wanted: string): LegacyHostDecision {
  const owners = startupOwners(id);
  if (!owners) return { outcome: 'no-snapshot' };
  const hostsOf = (which: VaultCredentialKind): string[] => owners
    .map((a) => normalizeHost(configOf(a, which)?.host))
    .filter((h) => !!h);

  const recorded = hostsOf(kind);
  if (recorded.length) {
    return recorded.includes(wanted) ? { outcome: 'bind', because: 'from the account registry' } : { outcome: 'other-server', boundHost: recorded[0] };
  }
  const sameSite = hostsOf(kind === 'imap' ? 'smtp' : 'imap').find((h) => providerSiteOf(h) === providerSiteOf(wanted));
  return sameSite ? { outcome: 'bind', because: `same site as ${sameSite} in the account registry` } : { outcome: 'unknown-server' };
}

const TRANSPORT_FIELDS: readonly VaultTransportField[] = ['allowInsecureTLS', 'allowPlaintext'];

/**
 * The relaxations an entry saved before transport binding should be bound to: what
 * the startup registry records for that kind, on the account whose server is `host`
 * (the same owner the host rule found, so an entry under an id derived from an
 * address is not read as having no record), or none at all when no such config
 * exists. `undefined` = no startup snapshot (neither use nor bind the entry).
 */
function legacyTransportFor(id: string, kind: VaultCredentialKind, host: string): TransportOptIns | undefined {
  const owners = startupOwners(id);
  if (!owners) {
    warnOnce(`[Vault] no startup snapshot of the account registry; not using the saved ${kind} password for ${id}`);
    return undefined;
  }
  const config = owners.map((a) => configOf(a, kind)).find((c) => normalizeHost(c?.host) === host);
  return config ? transportOptInsOf(config) : STRICT_TRANSPORT;
}

/** The relaxations saved with `entry`, binding a legacy entry on first use. */
async function savedTransport(id: string, kind: VaultCredentialKind, entry: VaultCredential, host: string): Promise<TransportOptIns | undefined> {
  if (TRANSPORT_FIELDS.every((k) => typeof entry[k] === 'boolean')) {
    return { allowInsecureTLS: entry.allowInsecureTLS === true, allowPlaintext: entry.allowPlaintext === true };
  }
  const legacy = legacyTransportFor(id, kind, host);
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
  let unknownServer = false;
  for (const id of ids) {
    const entry = (await getAccountSecrets(id))?.[kind];
    if (!entry?.password) continue;
    if (entry.host) {
      if (normalizeHost(entry.host) !== wanted) {
        mismatch ??= entry.host;
        continue;
      }
    } else {
      const decision = legacyHostDecision(id, kind, wanted);
      if (decision.outcome === 'other-server') {
        mismatch ??= decision.boundHost;
        continue;
      }
      if (decision.outcome === 'no-snapshot') {
        warnOnce(`[Vault] not using the saved ${kind} password under ${id}: the account registry could not be read at startup`);
        continue;
      }
      if (decision.outcome === 'unknown-server') {
        unknownServer = true;
        warnOnce(`[Vault] not using the saved ${kind} password under ${id} for "${wanted}": the account registry does not say which server it is for`);
        continue;
      }
      await bindAccountSecretHost(id, kind, wanted);
      logger.info(`[Vault] bound the saved ${kind} password for ${id} to ${wanted} (${decision.because})`);
    }
    const transport = await savedTransport(id, kind, entry, wanted);
    if (!transport) continue;
    return { status: 'found', password: entry.password, transport, id };
  }
  if (mismatch) {
    logger.warn(`[Vault] refused the saved ${kind} password for host "${wanted}" — it was saved for "${mismatch}"`);
    return { status: 'host-mismatch', boundHost: mismatch };
  }
  return unknownServer ? { status: 'unknown-server' } : { status: 'none' };
}

/** User-facing reason a connect could not use the saved password. */
export function hostMismatchMessage(kind: VaultCredentialKind, host: string, boundHost: string): string {
  const what = kind === 'imap' ? 'mailbox' : 'sending';
  return `Your saved ${what} password is for ${boundHost}. Re-enter your password to connect to ${host}.`;
}

/** User-facing reason a connect could not use a saved password nothing says the server of. */
export function unknownServerMessage(kind: VaultCredentialKind, host: string): string {
  const what = kind === 'imap' ? 'mailbox' : 'sending';
  return `Sarv Inbox has no record of which server your saved ${what} password is for, so it was not sent to ${host}. Re-enter your password to connect.`;
}

/** The re-enter message for a settled refusal, or null when `result` is not one. */
export function vaultRefusalMessage(kind: VaultCredentialKind, host: string, result: VaultPasswordResult): string | null {
  if (result.status === 'host-mismatch') return hostMismatchMessage(kind, host, result.boundHost);
  if (result.status === 'unknown-server') return unknownServerMessage(kind, host);
  return null;
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
