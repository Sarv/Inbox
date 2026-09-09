/**
 * Per-account runtime factory (multi-account, Stage 2).
 *
 * Each account gets its OWN SQLite database file and sync engine. The PRIMARY
 * account keeps the legacy `sarvinbox.db` (it claims the startup runtime in
 * shared.ts); only ADDITIONAL accounts create `sarvinbox-<id>.db` files here.
 *
 * Which account is primary is persisted in `primary-account.json` so that, on
 * restart with a SECONDARY account active, the secondary never wrongly claims
 * the primary's `sarvinbox.db`.
 */
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';

import { app } from 'electron';

import { SyncEngine, createLogger } from '@sarvinbox/core';
import { SQLiteStorage } from '@sarvinbox/storage-node';
import { getDbEncryptionKey } from './db-key-store';
import { getMeta, setMeta } from './core-db';
import { deleteAccountSecrets, rekeyAccountSecrets } from './secure-credential-store';

import type { AccountRuntime } from '../shared';
import { claimDefaultRuntime, getAccountRuntime, hasAccountRuntime, registerAccountRuntime, rekeyRuntime, unregisterRuntime } from '../shared';
const logger = createLogger('accounts-runtime');

/** The legacy single-account database — owned by the primary account. */
export const PRIMARY_DB_FILE = 'sarvinbox.db';

/**
 * Unread count for the "All Inboxes" badge and the per-account switcher number.
 *
 * Returns the INBOX folder's unread count ONLY — which the storage layer keeps as
 * a DISTINCT-THREAD count (COUNT(DISTINCT thread_id) over unread INBOX mail), the
 * SAME unit and scope the inbox LIST renders. So the badge always equals the
 * unread conversations the user actually sees; summed across accounts it equals
 * the unified-inbox row count.
 *
 * Non-INBOX label/folder unread is deliberately NOT added in: it isn't shown in
 * the (INBOX-only) unified inbox list, and a message carrying both |INBOX| and a
 * label would be double-counted. Mixing those in is exactly what made the old
 * badge (INBOX threads + label emails, no dedupe) disagree with the visible
 * list. (Every folder's stored count is now the same distinct-thread unit — the
 * non-INBOX STATUS sweep reconciles rows and recounts from them instead of
 * writing the server's `unseen` message count into the badge.)
 */
export function accountInboxUnread(
  folders: Array<{ specialUse?: string | null; path?: string; name?: string; unreadCount?: number }>,
): number {
  const inbox = folders.find(
    (f) => f.specialUse === '\\Inbox' || (f.path || '').toLowerCase() === 'inbox',
  );
  return inbox?.unreadCount ?? 0;
}

/**
 * Per-account database filename for a NON-primary account. The account id is
 * HASHED (SHA-256, truncated) so the filename doesn't reveal the email/host, and
 * so it can't collide with another account. Deterministic: the same account id
 * always maps to the same file. Distinct account ids (email + host) → distinct
 * hashes → distinct DBs, so a second provider for the same address never shares
 * a database.
 */
export function dbFileForAccount(accountId: string): string {
  const hash = createHash('sha256').update(accountId).digest('hex').slice(0, 32);
  return `sarvinbox-${hash}.db`;
}

/**
 * Create (and initialize) a fresh runtime backed by `dbFile`: its own DB + sync
 * engine. The SMTP client is created lazily on connect (smtp-handlers), so it
 * starts null here.
 */
export async function createAccountRuntime(dbFile: string): Promise<AccountRuntime> {
  const dbPath = join(app.getPath('userData'), dbFile);
  // The primary account may be (re)opened here too; give it the larger cache and
  // every OTHER account the modest default (8 MB) so 10 accounts don't multiply
  // into ~320 MB of page cache. (Primary opened at startup in main.ts already
  // passes 32 MB; this covers the re-open path.)
  const isPrimaryDb = dbFile === PRIMARY_DB_FILE;
  const storage = new SQLiteStorage({
    dbPath,
    readonly: false,
    verbose: false,
    key: getDbEncryptionKey(),
    cacheSizeKb: isPrimaryDb ? 32768 : 8192,
  });
  await storage.initialize();
  const syncEngine = new SyncEngine(storage);
  logger.info('[Accounts] Created runtime ->', dbPath);
  return { storage, syncEngine, smtpClient: null };
}

// ===== Primary-account persistence =========================================

// The primary pointer now lives in the core DB (registry_meta). The legacy
// `primary-account.json` is migrated into it on first read, then removed.
const PRIMARY_META_KEY = 'primary_account_id';

function legacyPrimaryFile(): string {
  return join(app.getPath('userData'), 'primary-account.json');
}

/** The account id that owns `sarvinbox.db`, or null if not yet recorded. */
export function loadPrimaryAccountId(): string | null {
  const fromDb = getMeta(PRIMARY_META_KEY);
  if (fromDb) return fromDb;
  // Migrate the legacy JSON pointer into the core DB, then drop the file.
  try {
    const raw = JSON.parse(readFileSync(legacyPrimaryFile(), 'utf8'));
    const id = typeof raw?.id === 'string' ? raw.id : null;
    if (id) {
      setMeta(PRIMARY_META_KEY, id);
      try { unlinkSync(legacyPrimaryFile()); } catch { /* keep if unlink fails */ }
      logger.info('[Accounts] migrated primary-account.json into core DB');
    }
    return id;
  } catch {
    return null;
  }
}

export function savePrimaryAccountId(id: string): void {
  setMeta(PRIMARY_META_KEY, id);
}

/** Forget the primary pointer (on primary-account removal) so the legacy
 *  sarvinbox.db is never adopted/recreated again — the app follows the per-id
 *  design from here. */
export function clearPrimaryAccountId(): void {
  setMeta(PRIMARY_META_KEY, null);
  try { unlinkSync(legacyPrimaryFile()); } catch { /* already gone */ }
}

/**
 * True only when the legacy `sarvinbox.db` already exists on disk. It's the
 * SOLE condition under which an account is placed on it: existing installs keep
 * their primary there, but a fresh install NEVER creates it — every account
 * (and every account after the legacy one is removed) uses its own per-id
 * `sarvinbox-<hash(id)>.db`.
 */
export function legacyDbExists(): boolean {
  return existsSync(join(app.getPath('userData'), PRIMARY_DB_FILE));
}

/**
 * True when this account's own per-id DB already exists on disk. Lets a caller
 * REUSE an existing account (open its DB) without risking the creation of a new,
 * empty one — used by imap:connect's self-activation so a renderer that lost its
 * active-account pointer can't accidentally spin up a blank mailbox.
 */
export function accountDbExists(accountId: string): boolean {
  if (!accountId) return false;
  return existsSync(join(app.getPath('userData'), dbFileForAccount(accountId)));
}

// ===== Exclusive maintenance ===============================================

/**
 * Accounts deliberately taken off the air so ONE operation can own the database
 * file outright — a VACUUM rebuild, or a delete that has to unlink it.
 *
 * Closing the handle is not enough on its own. Nothing in this app treats a
 * missing runtime as "leave it alone": the renderer's periodic sync tick, the
 * unified-inbox fan-out, imap:connect self-activation and the pipeline poller
 * all call `ensureAccountRuntime`, and the first one to fire simply opens a
 * fresh handle on the file the maintenance is midway through rewriting.
 *
 * Measured on the 9.8 GB Gmail account: the runtime was recreated 2.7 seconds
 * into a 31-second VACUUM, giving `database is locked` on the background INBOX
 * catch-up and the stuck-row heal, and pinning the post-VACUUM WAL at 1.7 GB
 * because the rebuilding connection was no longer the only one holding it.
 *
 * So the account stays MARKED for the whole window and `ensureAccountRuntime`
 * refuses it — a null, which every caller already handles, rather than a throw
 * that would surface as an unhandled rejection inside a background timer.
 */
const underMaintenance = new Set<string>();

/** True while `accountId` is held for exclusive maintenance. */
export function isAccountUnderMaintenance(accountId: string): boolean {
  return underMaintenance.has(accountId);
}

/**
 * Release the hold taken by `quiesceAccountRuntime(..., { hold: true })`.
 * MUST be called from a `finally` — an account left marked can never be
 * reopened for the rest of the process's life.
 */
export function releaseAccountMaintenance(accountId: string): void {
  underMaintenance.delete(accountId);
}

/**
 * Ensure `accountId` has an initialized runtime (its DB open), creating one if
 * needed, and return it. Deterministic DB ownership: the persisted PRIMARY
 * account reuses the already-open sarvinbox.db (claims the startup slot);
 * every other account opens its own sarvinbox-<id>.db. This is the single
 * source of the "open the right DB for this account" logic — used both when
 * switching accounts and when fanning a read across accounts (unified inbox).
 *
 * Returns null (never a wrong/empty DB) when the primary hasn't been
 * established yet, because the primary's file can't be resolved until then.
 * Does NOT connect IMAP — storage/engine only; safe to call for background reads.
 */
export async function ensureAccountRuntime(accountId: string): Promise<AccountRuntime | null> {
  const existing = getAccountRuntime(accountId);
  if (existing?.storage) return existing;

  // Held off the air for exclusive maintenance — do NOT open a second handle.
  // See `underMaintenance`.
  if (underMaintenance.has(accountId)) {
    logger.warn(`[Accounts] refused to open ${accountId} — database maintenance in progress`);
    return null;
  }

  const primary = loadPrimaryAccountId();
  // A legacy sarvinbox.db exists but its owner isn't established yet → don't
  // risk opening a wrong DB; wait until setActive claims it. With NO legacy DB
  // (fresh install) there's no ambiguity — every account just uses its per-id
  // file, so we proceed.
  if (!primary && legacyDbExists()) return null;
  // Only put an account on sarvinbox.db when it's the recorded primary AND that
  // legacy file actually exists — never (re)create it otherwise.
  const isPrimary = !!primary && accountId === primary && legacyDbExists();

  // Primary: reuse the already-open sarvinbox.db rather than a second handle.
  if (isPrimary && claimDefaultRuntime(accountId)) {
    return getAccountRuntime(accountId) ?? null;
  }

  const dbFile = isPrimary ? PRIMARY_DB_FILE : dbFileForAccount(accountId);
  const rt = await createAccountRuntime(dbFile);
  registerAccountRuntime(accountId, rt);
  return rt;
}

/** True once `ensureAccountRuntime` can resolve DB files (primary established). */
export function canResolveAccountRuntimes(): boolean {
  return !!loadPrimaryAccountId();
}

// ===== One-time account-id canonicalization ================================

/**
 * Rename a NON-primary account's DB files from its old id-hash to the new one.
 * No-op — and safe — when the source doesn't exist (a primary account lives in
 * `sarvinbox.db`, or the account is fresh) or the target already exists (already
 * migrated). The main `.db` is moved FIRST and its failure THROWS so the caller
 * aborts the whole id change (the old DB stays intact and is retried next
 * start); the `-wal`/`-shm` sidecars are best-effort (SQLite regenerates them,
 * and a cleanly-closed DB has already checkpointed them away). The caller MUST
 * ensure the DB isn't open — renaming an open SQLite file is unsafe on Windows.
 */
export function renameAccountDbFiles(oldId: string, newId: string): boolean {
  if (oldId === newId) return false;
  const dir = app.getPath('userData');
  const src = join(dir, dbFileForAccount(oldId));
  const dst = join(dir, dbFileForAccount(newId));
  if (!existsSync(src) || existsSync(dst)) return false;
  // Critical file first: a failure here throws → the id change is aborted with
  // the old DB fully intact.
  renameSync(src, dst);
  // WAL sidecars: best-effort — never fail the migration over them.
  for (const suffix of ['-wal', '-shm']) {
    const s = src + suffix;
    const d = dst + suffix;
    if (existsSync(s) && !existsSync(d)) {
      try { renameSync(s, d); } catch (e) { logger.warn('[AccountMigration] sidecar move skipped', s, e); }
    }
  }
  return true;
}

/**
 * Canonicalize ONE account from a legacy id (`acct-<email>`) to the current
 * `acct-<email>--<host>` scheme, moving every main-process store keyed by the
 * id: the per-account DB file (non-primary only), the credential vault, the
 * primary-account pointer, and any in-memory runtime. Fully idempotent and
 * guarded — every step no-ops when there's nothing to move. Renderer-driven
 * (the registry lives in renderer localStorage); this handles the main side.
 */
export async function rekeyAccount(oldId: string, newId: string): Promise<void> {
  if (!oldId || !newId || oldId === newId) return;
  // DB file: only when the account has its own (non-primary) file AND it isn't
  // currently open. The primary uses the fixed sarvinbox.db (no rename).
  if (!hasAccountRuntime(oldId)) {
    renameAccountDbFiles(oldId, newId);
  }
  await rekeyAccountSecrets(oldId, newId);
  if (loadPrimaryAccountId() === oldId) savePrimaryAccountId(newId);
  rekeyRuntime(oldId, newId);
  logger.info('[AccountMigration] rekeyed account', oldId, '->', newId);
}

// ===== Account removal (wipe local data) ===================================

/** Delete a SQLite DB and its WAL sidecars. Best-effort + idempotent. */
function deleteDbFiles(dbFullPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbFullPath + suffix;
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch (e) {
      logger.warn('[Accounts] Failed to delete DB file', p, e);
    }
  }
}

/**
 * Permanently remove ONE account's local footprint: close + delete its SQLite
 * DB, drop its in-memory runtime, and forget its vaulted secrets. If it was the
 * PRIMARY (on the legacy sarvinbox.db), that file is deleted and the primary
 * pointer cleared — so sarvinbox.db is never recreated and every remaining/new
 * account follows the per-id design. Safe + idempotent; the caller should have
 * already switched the active account away from `accountId`.
 */
/**
 * Take an account fully off the air: disconnect its IMAP engine, close its
 * database handle, and drop the runtime from the registry.
 *
 * Shared by the two callers that need the account's DB file to be nobody's
 * business but their own — deletion (an open SQLite file can't be unlinked on
 * Windows, and leaves -wal/-shm behind elsewhere) and compaction (VACUUM takes
 * an exclusive lock and cannot run alongside a live connection).
 *
 * Every step is best-effort: a failure to disconnect must not stop the close,
 * and a failure to close must not leave a stale runtime registered. A caller
 * that intends to bring the account BACK is responsible for calling
 * `ensureAccountRuntime` afterwards, in a `finally`.
 *
 * Pass `{ hold: true }` to also block anything else from reopening the account
 * while you work on its file (see `underMaintenance`). The hold is taken FIRST,
 * before the close, so there is no window in which the runtime is gone but
 * unguarded — that window is exactly how a background timer got in last time.
 * The caller then owns releasing it with `releaseAccountMaintenance`.
 */
export async function quiesceAccountRuntime(
  accountId: string,
  reason: string,
  options: { hold?: boolean } = {},
): Promise<void> {
  if (options.hold) underMaintenance.add(accountId);
  const rt = getAccountRuntime(accountId);

  // Disconnect the IMAP engine FIRST — primary connection, pool, and IDLE. The
  // account is often still connected (background accounts are kept live for
  // instant switching), and without this its sockets linger with no reference
  // until the provider reaps them, counting against the per-account connection
  // cap (Gmail = 15) the whole time.
  if (rt?.syncEngine) {
    try {
      (rt.syncEngine as { getClient?: () => { setShuttingDown?: () => void } | null }).getClient?.()?.setShuttingDown?.();
      await rt.syncEngine.disconnect?.();
    } catch (e) { logger.warn(`[Accounts] engine disconnect before ${reason} failed`, e); }
  }
  if (rt?.storage) {
    try { await rt.storage.close(); } catch (e) { logger.warn(`[Accounts] close before ${reason} failed`, e); }
  }
  unregisterRuntime(accountId);
}

export async function deleteAccountData(accountId: string): Promise<void> {
  if (!accountId) return;
  const isPrimary = loadPrimaryAccountId() === accountId;

  // Held across the unlink: a background tick that reopened the account between
  // the close and the delete would recreate the file we are removing, leaving a
  // blank mailbox on disk for a deleted account.
  await quiesceAccountRuntime(accountId, 'delete', { hold: true });

  try {
    const dbFile = isPrimary ? PRIMARY_DB_FILE : dbFileForAccount(accountId);
    deleteDbFiles(join(app.getPath('userData'), dbFile));
    if (isPrimary) clearPrimaryAccountId();

    try { await deleteAccountSecrets(accountId); } catch (e) { logger.warn('[Accounts] vault delete failed', e); }
    logger.info('[Accounts] wiped account data', accountId, isPrimary ? '(primary/sarvinbox.db)' : `(${dbFile})`);
  } finally {
    // The account is gone, but the id must not stay marked: re-adding the same
    // address later resolves to the same id, and it would be unopenable.
    releaseAccountMaintenance(accountId);
  }
}

// ===== Legacy DB leftover cleanup ==========================================

/**
 * Delete ORPHANED per-account DB files left behind by older builds. Current
 * per-account DBs are ALWAYS named `sarvinbox-<sha256(id)>.db` (dbFileForAccount)
 * — a hashed name that doesn't leak the email and is also encrypted at rest.
 * Older builds named them by the RAW account id (e.g.
 * `sarvinbox-acct-advik-d-sarv-com.db`) AND left them PLAINTEXT. When the app
 * switched to hashed+encrypted files those raw-named files were orphaned: the
 * current code never opens them again, so they're dead weight AND a plaintext
 * privacy leak (old mail readable at rest, email in the filename).
 *
 * This deletes every `sarvinbox-*.db` that is NOT one of the known-good names:
 *   - `sarvinbox.db`        (legacy primary)
 *   - `sarvinbox-core.db`   (the core app DB)
 *   - `sarvinbox-<32 hex>.db` (a live/hashed per-account DB)
 * along with each orphan's `-wal`/`-shm` sidecars. Live/background account DBs
 * are always hashed, so they're never touched. Returns the removed filenames.
 * Meant to run ONCE (see the migration flag in the caller).
 */
export function cleanupOrphanedAccountDbs(opts?: {
  /** The account ids that CURRENTLY exist (from the registry). When supplied and
   *  NON-EMPTY, hashed per-account DBs whose id isn't in this set are treated as
   *  orphans and removed — but ONLY the stale ones (see `staleAfterMs`), so an
   *  actively-synced background account we might have momentarily missed is never
   *  touched. Omit → hashed files are all KEPT. An EMPTY array is also treated as
   *  "not authoritative" and keeps every hashed file: a registry reporting zero
   *  accounts while hashed per-account DBs exist on disk is far more often a
   *  registry we failed to READ than a user who removed their last mailbox, and
   *  the two outcomes are not comparable — one leaves a stale file behind, the
   *  other destroys live mail. (It really happened: a native-module load failure
   *  emptied the keep-set and both live account DBs were deleted.) Callers must
   *  still source the ids from `readRegistryAccounts`, which THROWS rather than
   *  reporting an unreadable registry as empty. */
  keepAccountIds?: string[];
  /** Only remove a hashed orphan that hasn't been written for this long. Guards a
   *  live DB against a stale/racing keep-set. Default 1h. */
  staleAfterMs?: number;
}): string[] {
  const dir = app.getPath('userData');
  const removed: string[] = [];
  const HASHED = /^sarvinbox-[0-9a-f]{32}\.db$/;
  const KEEP_EXACT = new Set([PRIMARY_DB_FILE, 'sarvinbox-core.db']);
  // Non-empty is the authority test — see `keepAccountIds`. `null` here means
  // "keep every hashed DB", which is always the safe answer.
  const keepFiles = opts?.keepAccountIds?.length
    ? new Set(opts.keepAccountIds.map((id) => dbFileForAccount(id)))
    : null;
  const staleAfterMs = opts?.staleAfterMs ?? 60 * 60 * 1000;

  const isStale = (name: string): boolean => {
    try { return Date.now() - statSync(join(dir, name)).mtimeMs >= staleAfterMs; }
    catch { return false; } // can't stat → don't risk deleting
  };
  // Verify a file is actually a SQLite DB (magic header) before deleting a
  // loosely-matched legacy name, so an unrelated file that merely starts with
  // `acct-` is never touched.
  const isSqliteFile = (name: string): boolean => {
    let fd: number | undefined;
    try {
      fd = openSync(join(dir, name), 'r');
      const buf = Buffer.alloc(16);
      readSync(fd, buf, 0, 16, 0);
      return buf.toString('latin1', 0, 15) === 'SQLite format 3';
    } catch { return false; }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
  };

  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    logger.warn('[Accounts] cleanup: could not read userData dir', e);
    return removed;
  }
  for (const name of entries) {
    if (/^sarvinbox-.+\.db$/.test(name)) {
      // Main DB files; the -wal/-shm sidecars are removed alongside each.
      if (KEEP_EXACT.has(name)) continue;
      if (HASHED.test(name)) {
        // A live/background account DB is hashed. Remove ONLY when we have an
        // authoritative (supplied AND non-empty) keep-set AND this file isn't in
        // it AND it's stale — the orphan left by a since-removed/rekeyed account
        // (was never swept because the old sweep kept ALL hashed files).
        if (keepFiles && !keepFiles.has(name) && isStale(name)) {
          deleteDbFiles(join(dir, name));
          removed.push(name);
          logger.info('[Accounts] removed orphaned hashed account DB:', name);
        }
        continue;
      }
      // Raw-named legacy per-account DB (e.g. `sarvinbox-acct-…​.db`) — never
      // created by current code, always an orphan.
      deleteDbFiles(join(dir, name));
      removed.push(name);
      logger.info('[Accounts] removed orphaned legacy DB:', name);
      continue;
    }
    // Oldest scheme: per-account DB named by the RAW account id with no
    // `sarvinbox-` prefix and no `.db` extension (e.g. `acct-<email>`), left
    // PLAINTEXT — dead weight AND a privacy leak (mail readable at rest, email in
    // the filename). Magic-verified so we never delete an unrelated `acct-*` file.
    if (/^acct-[a-z0-9-]+$/i.test(name) && isSqliteFile(name)) {
      try {
        unlinkSync(join(dir, name));
        removed.push(name);
        logger.info('[Accounts] removed legacy plaintext account DB:', name);
      } catch (e) {
        logger.warn('[Accounts] could not remove legacy plaintext DB', name, e);
      }
    }
  }
  return removed;
}

/**
 * Remove known STALE non-DB artifacts from userData that nothing writes anymore:
 *   - `draft-debug.log` — a debug log from a removed code path (no current writer).
 *   - `.com.sarv.sarvinbox[.dev].<rand>` — bundle-id-prefixed atomic-write temp
 *     files (macOS/Chromium), orphaned when a small write was interrupted.
 *
 * Every candidate is removed ONLY when it hasn't been written in the last hour, so
 * a file that IS live (or a temp the OS is mid-writing) is left untouched — the
 * dead ones have old mtimes and go. Idempotent + best-effort. Returns removed
 * names. Deliberately does NOT touch `sentry/` (a live SDK working dir when a DSN
 * is configured) or the app logs.
 */
export function cleanupStaleUserDataArtifacts(): string[] {
  const dir = app.getPath('userData');
  const removed: string[] = [];
  const STALE_MS = 60 * 60 * 1000;

  const removeIfStale = (name: string): void => {
    const p = join(dir, name);
    try {
      if (!existsSync(p)) return;
      if (Date.now() - statSync(p).mtimeMs < STALE_MS) return; // written recently → live, leave it
      unlinkSync(p);
      removed.push(name);
    } catch (e) {
      logger.warn('[Accounts] could not remove stale artifact', name, (e as Error).message);
    }
  };

  removeIfStale('draft-debug.log');

  // Orphaned bundle-id temp files (dev: com.sarv.sarvinbox.dev, release: com.sarv.sarvinbox).
  const TEMP_RE = /^\.com\.sarv\.sarvinbox(\.dev)?\..+/;
  try {
    for (const name of readdirSync(dir)) {
      if (TEMP_RE.test(name)) removeIfStale(name);
    }
  } catch { /* dir unreadable — nothing to do */ }

  if (removed.length) logger.info('[Accounts] removed stale artifacts:', removed.join(', '));
  return removed;
}

// Re-exported for callers that only import from this module.
export { hasAccountRuntime };
