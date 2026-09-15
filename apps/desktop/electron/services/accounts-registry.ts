/**
 * Accounts registry — the durable, main-owned list of configured mail accounts
 * and which one is active. Lives in the `account_registry` table of the core DB
 * (`sarvinbox-core.db`, see core-db.ts), so it survives a localStorage wipe that
 * used to silently drop accounts (Gmail vanished though its DB + tokens survived).
 *
 * The renderer HYDRATES from `accounts:list` on startup and MIRRORS every change
 * back via `accounts:save`; main also SEEDS it from the durable secret stores on
 * startup so an account is recoverable even with no localStorage at all.
 *
 * SECRETS NEVER LAND IN THIS TABLE. IMAP/SMTP passwords + OAuth tokens live in
 * the credential vault / oauth-token store (now also core-DB blobs). Account
 * configs are secret-stripped defensively before every write.
 */
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';

import { accountIdFor, oauthImapPreset, createLogger } from '@sarvinbox/core';
import { app } from 'electron';


import { getAccountIdForStorage } from '../shared';

import { loadPrimaryAccountId } from './accounts-runtime';
import { getCoreDb, getMeta, setMeta, coreDbExists, hasBlob } from './core-db';
import { loadImapAccount } from './imap-account-store';
import { loadAccounts as loadOAuthAccounts } from './oauth-token-store';

// Re-exported so existing importers (accounts-handlers, main) keep one import
// site. These now live in core-db (shared across all core-DB-backed stores).
export {
  getAllAppSettings,
  setAppSetting,
  deleteAppSetting,
  isMigrationDone,
  markMigrationDone,
} from './core-db';

const logger = createLogger('accounts-registry');

const ACTIVE_META_KEY = 'active_account_id';

/**
 * The persisted (non-secret) shape of an account — mirrors the renderer's
 * `StoredAccount`. `imapConfig`/`smtpConfig` are stored as JSON so no field is
 * lost across the round-trip; a few fields are also denormalized into columns.
 */
export interface RegistryAccount {
  id: string;
  email: string;
  name?: string;
  imapConfig: Record<string, any> | null;
  smtpConfig: Record<string, any> | null;
  smtpConfigured: boolean;
  color?: string;
  includeInUnified?: boolean;
  backgroundSync?: boolean;
  notify?: boolean;
}

// Secret fields that must NEVER be written to the registry (they live in the
// vault / oauth-token-store). Kept in sync with the renderer's SECRET_KEYS.
const SECRET_KEYS = ['password', 'accessToken', 'refreshToken'] as const;

/** A shallow copy of a config object with every secret field removed. */
function stripSecrets(config: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!config) return null;
  const clean: Record<string, any> = { ...config };
  for (const k of SECRET_KEYS) delete clean[k];
  return clean;
}

function rowToAccount(row: any): RegistryAccount {
  const parse = (s: string | null): Record<string, any> | null => {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
  };
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? undefined,
    imapConfig: parse(row.imap_config),
    smtpConfig: parse(row.smtp_config),
    smtpConfigured: !!row.smtp_configured,
    color: row.color ?? undefined,
    includeInUnified: row.include_in_unified == null ? undefined : !!row.include_in_unified,
    backgroundSync: row.background_sync == null ? undefined : !!row.background_sync,
    notify: row.notify == null ? undefined : !!row.notify,
  };
}

/**
 * All accounts in the registry, THROWING if the registry cannot be read.
 *
 * Use this — never the swallowing `listRegistryAccounts` — anywhere the answer
 * decides what to DELETE. An unreadable registry and an empty one are the same
 * value (`[]`) but opposite facts: "there are no accounts" licenses a cleanup,
 * "I could not find out" must stop it. Conflating them once deleted two live
 * mailbox DBs, because a native-module load failure made every account look
 * like it had been removed.
 */
export function readRegistryAccounts(): RegistryAccount[] {
  const rows = getCoreDb().prepare('SELECT * FROM account_registry ORDER BY created_at ASC').all();
  return rows.map(rowToAccount);
}

/** All accounts in the registry (secrets already excluded). `[]` if the read
 *  fails — only safe for callers that merely DISPLAY or hydrate. */
export function listRegistryAccounts(): RegistryAccount[] {
  try {
    return readRegistryAccounts();
  } catch (e) {
    logger.error('[Registry] list failed:', e);
    return [];
  }
}

/** Insert or update ONE account (by id). Secrets are stripped before writing. */
export function upsertRegistryAccount(a: RegistryAccount): void {
  if (!a?.id || !a.email) return;
  const imap = stripSecrets(a.imapConfig);
  const smtp = stripSecrets(a.smtpConfig);
  const now = Date.now();
  getCoreDb()
    .prepare(
      `INSERT INTO account_registry
         (id, email, name, imap_config, smtp_config, smtp_configured, auth_method,
          oauth_provider, color, include_in_unified, background_sync, notify, created_at, updated_at)
       VALUES
         (@id, @email, @name, @imap_config, @smtp_config, @smtp_configured, @auth_method,
          @oauth_provider, @color, @include_in_unified, @background_sync, @notify, @now, @now)
       ON CONFLICT(id) DO UPDATE SET
         email=@email, name=@name, imap_config=@imap_config, smtp_config=@smtp_config,
         smtp_configured=@smtp_configured, auth_method=@auth_method, oauth_provider=@oauth_provider,
         color=@color, include_in_unified=@include_in_unified, background_sync=@background_sync,
         notify=@notify, updated_at=@now`,
    )
    .run({
      id: a.id,
      email: a.email,
      name: a.name ?? null,
      imap_config: imap ? JSON.stringify(imap) : null,
      smtp_config: smtp ? JSON.stringify(smtp) : null,
      smtp_configured: a.smtpConfigured ? 1 : 0,
      auth_method: (imap?.authMethod as string) ?? null,
      oauth_provider: (imap?.oauthProvider as string) ?? null,
      color: a.color ?? null,
      include_in_unified: a.includeInUnified === false ? 0 : 1,
      background_sync: a.backgroundSync === false ? 0 : 1,
      notify: a.notify === false ? 0 : 1,
      now,
    });
}

/**
 * Upsert a whole list of accounts (a snapshot mirror from the renderer). This
 * NEVER deletes rows the snapshot omits — a transiently-empty renderer registry
 * (the very bug this fixes) must not be able to wipe the durable list. Explicit
 * removal goes through `removeRegistryAccount`.
 */
export function upsertRegistryAccounts(accounts: RegistryAccount[]): void {
  if (!Array.isArray(accounts) || accounts.length === 0) return;
  const tx = getCoreDb().transaction((list: RegistryAccount[]) => {
    for (const a of list) upsertRegistryAccount(a);
  });
  try { tx(accounts); } catch (e) { logger.error('[Registry] bulk upsert failed:', e); }
}

/** Permanently remove one account row (on account deletion). Idempotent. */
export function removeRegistryAccount(id: string): void {
  if (!id) return;
  try {
    getCoreDb().prepare('DELETE FROM account_registry WHERE id = ?').run(id);
    if (getRegistryActiveAccountId() === id) setRegistryActiveAccountId(null);
  } catch (e) {
    logger.error('[Registry] remove failed:', e);
  }
}

export function getRegistryActiveAccountId(): string | null {
  return getMeta(ACTIVE_META_KEY);
}

export function setRegistryActiveAccountId(id: string | null): void {
  setMeta(ACTIVE_META_KEY, id);
}

export interface AccountIdentity { email: string; name: string; aliases: string[] }

/**
 * Resolve the user's OWN identity — their address, display name, and every
 * known alias — for a given per-account `storage`. THE single source of truth
 * for "who are we", used by every pipeline path (init, post-sync,
 * categorization, drafting) so they can never disagree.
 *
 * Order, authoritative first:
 *   1. The registry account that owns this `storage` — its IMAP username /
 *      OAuth email, i.e. the actual login = the user's real address.
 *   2. The active registry account, when the storage can't be mapped (the
 *      legacy single-account default slot maps to no id).
 *   3. A sole registry account (single-account install).
 *   4. The legacy per-DB `accounts` table (pre-registry installs).
 *
 * It deliberately does NOT fall back to an arbitrary Sent message's
 * `from_address`: that used to pick up vendor / no-reply senders (e.g.
 * "no-reply@kekamail.com") and poison self-detection and sender memory. An
 * EMPTY identity is safe — the "is this addressed to me" heuristics simply skip
 * — whereas a WRONG identity is actively corrupting, so we return '' rather
 * than guess.
 */
export function resolveAccountIdentity(storage?: unknown): AccountIdentity {
  const accounts = listRegistryAccounts();
  const registryAliases = accounts.map((a) => a.email).filter(Boolean).map((e) => e.toLowerCase());

  const owning = (): RegistryAccount | undefined => {
    const id = getAccountIdForStorage((storage as any) ?? null) ?? getRegistryActiveAccountId();
    if (id) { const m = accounts.find((a) => a.id === id); if (m) return m; }
    if (accounts.length === 1) return accounts[0];
    return undefined;
  };

  const acct = owning();
  if (acct?.email) {
    return {
      email: acct.email,
      name: acct.name || '',
      aliases: registryAliases.length ? registryAliases : [acct.email.toLowerCase()],
    };
  }

  // Legacy fallback: the per-DB `accounts` table (older single-account installs
  // that predate the registry).
  try {
    const rows = (storage as any)?.db?.prepare?.('SELECT email, name FROM accounts')?.all?.() as
      | Array<{ email?: string; name?: string }>
      | undefined;
    if (rows?.length) {
      return {
        email: rows[0].email || '',
        name: rows[0].name || '',
        aliases: rows.map((r) => r.email).filter(Boolean).map((e) => (e as string).toLowerCase()),
      };
    }
  } catch { /* table absent or empty — fall through */ }

  return { email: '', name: '', aliases: registryAliases };
}

/** Convenience: just the user's own address for `storage`. See resolveAccountIdentity. */
export function resolveAccountEmail(storage?: unknown): string {
  return resolveAccountIdentity(storage).email;
}

/**
 * Seed the registry from the durable MAIN-side stores so accounts survive even a
 * total localStorage loss. Only fills in accounts the registry is MISSING (by
 * id) — it never overwrites a renderer-mirrored entry. Sources:
 *
 *   - oauth-token store   → OAuth accounts (provider + email); IMAP host/port
 *                           come from OAUTH_IMAP_PRESETS (main-importable).
 *   - imap-account store  → the last-good password/OAuth config, full fidelity.
 *   - primary pointer     → the active pointer, if the registry has none yet.
 *
 * Idempotent + best-effort: any source failing is logged and skipped.
 */
export async function seedAccountRegistryFromDurableStores(): Promise<void> {
  try {
    const existing = new Set(listRegistryAccounts().map((a) => a.id));

    // 1. Full-fidelity last-good IMAP config (host/port/auth all present).
    try {
      const imap = await loadImapAccount();
      if (imap?.host && imap.username) {
        const id = accountIdFor(imap.username, imap.host);
        if (!existing.has(id)) {
          upsertRegistryAccount({
            id,
            email: imap.username,
            imapConfig: stripSecrets(imap),
            smtpConfig: null,
            smtpConfigured: false,
          });
          existing.add(id);
          logger.info('[Registry] seeded account from imap-account store:', id);
        }
      }
    } catch (e) {
      logger.warn('[Registry] imap-account seed skipped:', (e as Error)?.message);
    }

    // 2. OAuth accounts — reconstruct IMAP config from the provider preset.
    try {
      const oauth = await loadOAuthAccounts();
      for (const oa of oauth) {
        const preset = oauthImapPreset(oa.provider);
        if (!preset) continue; // e.g. 'sarv' sign-in — not a mailbox
        const id = accountIdFor(oa.email, preset.host);
        if (existing.has(id)) continue;
        upsertRegistryAccount({
          id,
          email: oa.email,
          name: oa.displayName,
          imapConfig: {
            host: preset.host,
            port: preset.port,
            secure: preset.secure,
            username: oa.email,
            authMethod: 'oauth2',
            oauthProvider: oa.provider,
          },
          smtpConfig: null,
          smtpConfigured: false,
        });
        existing.add(id);
        logger.info(`[Registry] seeded OAuth account from oauth store: ${id} (${oa.provider})`);
      }
    } catch (e) {
      logger.warn('[Registry] oauth store seed skipped:', (e as Error)?.message);
    }

    // 3. Active pointer — only if the registry hasn't recorded one yet.
    if (!getRegistryActiveAccountId()) {
      const primary = loadPrimaryAccountId();
      if (primary && existing.has(primary)) setRegistryActiveAccountId(primary);
    }
  } catch (e) {
    logger.error('[Registry] seed failed:', e);
  }
}

/** True once the core DB (which holds the registry) exists on disk. */
export function accountRegistryExists(): boolean {
  return coreDbExists();
}

// ===== Legacy secret/config file cleanup ===================================
// The OAuth tokens, credential vault, last-good IMAP config, and primary pointer
// now live in the core DB. Once each is confirmed migrated (its blob/meta
// exists), its old JSON file — plus any .premigrated/.bak/.tmp sibling — is
// removed. Gating deletion on the migrated blob/meta is the "verified migration"
// safety: a file is never deleted until its data is provably in the core DB.
const LEGACY_MIGRATED_FILES: Array<{ blobKey?: string; metaKey?: string; file: string }> = [
  { blobKey: 'oauth-accounts', file: 'oauth-accounts.json' },
  { blobKey: 'secure-credentials', file: 'secure-credentials.json' },
  { blobKey: 'imap-account', file: 'imap-account.json' },
  { metaKey: 'primary_account_id', file: 'primary-account.json' },
  { metaKey: 'pipeline_ai_state', file: 'pipeline-ai-state.json' },
  // Migrated into core_blobs by their stores on first read (write-to-DB first):
  { blobKey: 'agent-config', file: 'agent-config.json' },
  { blobKey: 'ai-secrets', file: 'ai-secrets.json' },
  { blobKey: 'pipeline-ai-config', file: 'pipeline-ai-config.json' },
];

/** Remove legacy JSON files whose data has been verified-migrated into the core
 *  DB. Idempotent + best-effort; returns the removed filenames. */
export function cleanupMigratedLegacyFiles(): string[] {
  const dir = app.getPath('userData');
  const removed: string[] = [];
  for (const { blobKey, metaKey, file } of LEGACY_MIGRATED_FILES) {
    const migrated = blobKey ? hasBlob(blobKey) : metaKey ? !!getMeta(metaKey) : false;
    if (!migrated) continue;
    for (const suffix of ['', '.premigrated', '.bak', '.tmp']) {
      const p = join(dir, file + suffix);
      try {
        if (existsSync(p)) { unlinkSync(p); removed.push(file + suffix); }
      } catch (e) {
        logger.warn('[Registry] could not remove legacy file', file + suffix, (e as Error)?.message);
      }
    }
  }

  // A standalone `accounts-registry.db` from an earlier design is dead weight —
  // the registry is now the `account_registry` TABLE inside the core DB (see
  // listRegistryAccounts). Nothing opens the file and no migration reads it, so
  // once the core DB (the live backend) exists it can go, along with its SQLite
  // sidecars. Idempotent + gated on coreDbExists() (the verified-migration rule:
  // never delete the old store until the new one is provably present).
  if (coreDbExists()) {
    for (const suffix of ['', '-shm', '-wal', '-journal']) {
      const name = 'accounts-registry.db' + suffix;
      const p = join(dir, name);
      try {
        if (existsSync(p)) { unlinkSync(p); removed.push(name); }
      } catch (e) {
        logger.warn('[Registry] could not remove legacy accounts-registry.db', suffix, (e as Error)?.message);
      }
    }
  }

  return removed;
}
