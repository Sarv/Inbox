// SQLite storage implementation for Node.js
// Refactored to use modular repositories for cleaner code organization

import { basename, dirname, join } from 'path';

import type {
  IEmailStorage,
  EmailRecord,
  FolderRecord,
  ThreadRecord,
  AttachmentRecord,
  ContactRecord,
  SearchQuery,
  ViewFilter,
  PaginationOptions,
  StorageStats,
  FilterRuleInput,
  LabelInput,
  DatabasePageStats,
} from '@sarvinbox/core';
import { parseAddresses , createLogger } from '@sarvinbox/core';
import Database from 'better-sqlite3';

import { BodyStorageBackfill } from './body-storage-backfill';
import { escapeDbKey, isExistingPlaintextDb } from './db-encryption';
import { InlineImageBackfill } from './inline-image-backfill';
import { createMigrationManager } from './migrations';
import { ReadModelMaintainer } from './read-model-maintainer';
import { attachSharedContacts, SHARED_CONTACTS_FILE } from './shared-contacts';
import {
  EmailRepository,
  FolderRepository,
  ThreadRepository,
  ContactRepository,
  AIRepository,
  SearchRepository,
  AgentRepository,
  PromptRepository,
  FilterRepository,
  LabelRepository,
} from './repositories';
import { missingBodyClause } from './repositories/agent-eligibility';
import { areBodyLengthsReady } from './repositories/body-metrics';
import { resolveThreadId, reattachOrphans, repairThreading as repairThreadingImpl } from './thread-resolver';


const log = createLogger('Storage');

/**
 * SQLite storage configuration
 */
export interface SQLiteStorageConfig {
  dbPath: string;
  readonly?: boolean;
  verbose?: boolean;
  /**
   * At-rest encryption key (passphrase) for the SQLCipher-compatible engine
   * (better-sqlite3-multiple-ciphers). When set, the DB is opened with this key;
   * a legacy PLAINTEXT DB is transparently migrated in place (PRAGMA rekey) on
   * first open, and a new DB is created encrypted. Omit for no encryption.
   */
  key?: string;
  /**
   * Path to the SHARED contact directory (`sarvinbox-contacts.db`), attached to
   * this connection as the schema `shared`. Contacts are one directory for the
   * whole app, not one address book per mailbox — see `shared-contacts.ts`.
   *
   * Defaults to a sibling of `dbPath`, which is what makes this work without
   * every caller having to know: in the app all account databases live in the
   * same userData directory, so they all resolve to the SAME directory file,
   * while a test using its own temp directory gets its own isolated one.
   */
  sharedContactsPath?: string;
  /**
   * The account this database belongs to, recorded as provenance on each
   * directory row (`contact_accounts`) so the union of accounts can still be
   * broken back down into its parts. Omitted outside the multi-account runtime
   * (tests, tools), where provenance simply isn't tracked.
   */
  accountId?: string;
  /**
   * SQLite page-cache size in KiB (applied as `PRAGMA cache_size = -<kb>`).
   * IMPORTANT: this is PER open connection, and every account opens its OWN
   * encrypted DB that stays open for the session — so with N accounts the total
   * is N × this. Keep it modest for background accounts; give only the primary/
   * active account a larger cache. Defaults to 8 MB when omitted.
   */
  cacheSizeKb?: number;
}

/**
 * SQLite storage implementation
 * Uses modular repositories for organized code structure
 */
export class SQLiteStorage implements IEmailStorage {
  private db: Database.Database | null = null;
  private initialized = false;
  // The mailbox owner's own address(es), set by the main process. The thread
  // resolver excludes these from same-subject participant overlap so a mail that
  // shares just ONE real correspondent with a thread (owner not directly on it)
  // still merges, while unrelated mail sharing only the owner stays separate.
  private selfAddresses = new Set<string>();

  // Read-model (denormalized threads/thread_folders) upkeep + backfill. Drains
  // the trigger-populated dirty queue off the write path. See read-model-maintainer.ts.
  private readModel: ReadModelMaintainer | null = null;

  // One-time upkeep for rows that predate the current body layout: moves bodies
  // out to `email_bodies` (v73) and stamps clean_body_len/raw_body_len (v72), in
  // one pass. Inert once the DB is marked complete. See body-storage-backfill.ts.
  private bodyStorage: BodyStorageBackfill | null = null;
  private inlineImages: InlineImageBackfill | null = null;

  // Repositories
  private _emailRepo: EmailRepository | null = null;
  private _folderRepo: FolderRepository | null = null;
  private _threadRepo: ThreadRepository | null = null;
  private _contactRepo: ContactRepository | null = null;
  private _aiRepo: AIRepository | null = null;
  private _searchRepo: SearchRepository | null = null;
  private _agentRepo: AgentRepository | null = null;
  private _promptRepo: PromptRepository | null = null;
  private _filterRepo: FilterRepository | null = null;
  private _labelRepo: LabelRepository | null = null;

  constructor(private config: SQLiteStorageConfig) {}

  // Repository getters
  private get emailRepo(): EmailRepository {
    if (!this._emailRepo) {
      this._emailRepo = new EmailRepository(() => this.db!);
    }
    return this._emailRepo;
  }

  private get folderRepo(): FolderRepository {
    if (!this._folderRepo) {
      this._folderRepo = new FolderRepository(() => this.db!);
    }
    return this._folderRepo;
  }

  private get threadRepo(): ThreadRepository {
    if (!this._threadRepo) {
      this._threadRepo = new ThreadRepository(() => this.db!);
    }
    return this._threadRepo;
  }

  private get contactRepo(): ContactRepository {
    if (!this._contactRepo) {
      this._contactRepo = new ContactRepository(() => this.db!, () => this.accountKey());
    }
    return this._contactRepo;
  }

  private get aiRepo(): AIRepository {
    if (!this._aiRepo) {
      this._aiRepo = new AIRepository(() => this.db!, (row) => this.rowToEmailRecord(row));
    }
    return this._aiRepo;
  }

  private get searchRepo(): SearchRepository {
    if (!this._searchRepo) {
      this._searchRepo = new SearchRepository(() => this.db!, (row) => this.rowToEmailRecord(row));
    }
    return this._searchRepo;
  }

  private get agentRepo(): AgentRepository {
    if (!this._agentRepo) {
      this._agentRepo = new AgentRepository(() => this.db!);
    }
    return this._agentRepo;
  }

  private get promptRepo(): PromptRepository {
    if (!this._promptRepo) {
      this._promptRepo = new PromptRepository(() => this.db!);
    }
    return this._promptRepo;
  }

  private get filterRepo(): FilterRepository {
    if (!this._filterRepo) {
      this._filterRepo = new FilterRepository(() => this.db!);
    }
    return this._filterRepo;
  }

  private get labelRepo(): LabelRepository {
    if (!this._labelRepo) {
      this._labelRepo = new LabelRepository(() => this.db!);
    }
    return this._labelRepo;
  }

  // ========== Connection & Lifecycle ==========

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Decide encrypt-vs-migrate BEFORE opening (opening a new/empty DB would make
    // the header look plaintext). A legacy plaintext DB → rekey in place.
    const legacyPlaintext = !!this.config.key && isExistingPlaintextDb(this.config.dbPath);

    // Only pass options we actually have a value for. better-sqlite3 validates
    // on KEY PRESENCE (`'readonly' in options`), not on value, so handing it
    // `{ readonly: undefined }` throws `Expected the "readonly" option to be a
    // boolean` — i.e. every caller that omits the OPTIONAL `readonly` config
    // would crash at DB open. Today's callers all pass `false` explicitly, which
    // is the only reason this never fired in the app.
    this.db = new Database(this.config.dbPath, {
      ...(typeof this.config.readonly === 'boolean' ? { readonly: this.config.readonly } : {}),
      ...(this.config.verbose ? { verbose: console.log } : {}),
    });

    // At-rest encryption MUST be applied as the very first statement, before any
    // read/write or journal pragma. Escape single quotes defensively (the key is
    // hex today, so this never triggers, but never build SQL from an unescaped value).
    if (this.config.key) {
      const k = escapeDbKey(this.config.key);
      if (legacyPlaintext) {
        // Migrate a plaintext DB to encrypted IN PLACE. Checkpoint + leave WAL
        // first (rekey rewrites every page; doing it under a rollback journal is
        // the safe path), then WAL is re-enabled below on the now-encrypted DB.
        this.db.pragma('journal_mode = DELETE');
        this.db.pragma(`rekey='${k}'`);
        log.info(`[SQLiteStorage] Migrated plaintext DB to encrypted: ${this.config.dbPath}`);
      } else {
        this.db.pragma(`key='${k}'`);
      }
    }

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // synchronous = NORMAL is durable under WAL (only loses the very last
    // transaction on OS crash, never corrupts the DB) and skips an fsync per
    // commit — a standard 2-5x write win on sync-heavy workloads.
    this.db.pragma('synchronous = NORMAL');
    // Page cache. On an ENCRYPTED (SQLCipher) DB every page read is decrypted +
    // HMAC-verified, so the default ~2 MB cache means hot pages get re-decrypted
    // on every list scan / folder recount. A larger cache keeps the working set
    // decrypted in memory. This is PER connection and every account keeps its DB
    // open all session, so the total is (accounts × cacheSizeKb) — the caller
    // gives only the primary/active account a large cache and background
    // accounts a small one. Default 8 MB (still 4× SQLite's default).
    const cacheKb = this.config.cacheSizeKb ?? 8192;
    this.db.pragma(`cache_size = -${cacheKb}`); // negative = KiB
    // Keep temp b-trees (ORDER BY / GROUP BY on the tags scans) in memory
    // instead of spilling decrypted pages to a temp file on disk.
    this.db.pragma('temp_store = MEMORY');

    // Attach the shared contact directory BEFORE migrating. The migration that
    // adopts this mailbox's old per-account `contacts` table has to be able to
    // read both sides at once, and every contact query from here on resolves
    // through `shared.` — so the schema has to exist before any of them runs.
    this.attachDirectory();

    const migrationManager = createMigrationManager(this.db, { accountId: this.config.accountId });
    migrationManager.migrate();

    this.initialized = true;

    // Start read-model upkeep AFTER init completes. It seeds the one-time backfill
    // and drains the dirty queue on later ticks, so it never blocks startup. Inert
    // to reads until the cutover — safe to run now to keep the tables warm.
    this.readModel = new ReadModelMaintainer(() => this.db);
    this.readModel.start();

    // Same deal for the body layout: a no-op on a fresh DB, and on an upgraded
    // one it moves bodies to `email_bodies` and stamps their lengths in
    // background slices rather than making startup wait on reading every body.
    // Both passes are labelled with the database file they work on. A
    // multi-account install runs one of each PER ACCOUNT, and their log lines are
    // otherwise identical and interleaved — with no way to tell whose mailbox a
    // warning is about, or whether two of them are the same pass twice.
    const dbLabel = basename(this.config.dbPath);
    this.bodyStorage = new BodyStorageBackfill(() => this.db, dbLabel);
    this.bodyStorage.start();

    // And the layer below that: take the base64 images out of the bodies
    // themselves. Started after the relocation pass on purpose — its cursor is a
    // partial index over `email_bodies`, so on an upgrading database there is
    // nothing for it to see until the bodies have arrived there. Its own start
    // delay is longer, which keeps the two from competing for the first minute.
    this.inlineImages = new InlineImageBackfill(() => this.db, dbLabel);
    this.inlineImages.start();
  }

  /**
   * Where this connection's contact directory lives.
   *
   * A sibling of the account database by default. That single rule gives both
   * behaviours we need with no configuration: every account database in the
   * app's userData directory resolves to the SAME directory file (one address
   * book), while a test that builds its database in its own temp directory gets
   * a directory of its own (no cross-test bleed).
   *
   * An in-memory database has no directory to be a sibling of, so it attaches
   * an anonymous temporary database — private to the connection and deleted
   * when it closes, which is the right isolation for the throwaway case.
   */
  /**
   * Provenance id for this mailbox's contributions to the shared directory.
   *
   * Falls back to the database's file name, which is derived from the account
   * (`sarvinbox-<hash>.db`) — so even a storage opened without an explicit
   * `accountId` records something a human can trace back to a mailbox. The same
   * fallback as the adoption migration, deliberately: the two must agree or one
   * account's history would split into two provenance rows.
   */
  /**
   * Name this connection's mailbox for the contact directory's provenance table.
   *
   * The LEGACY primary database is opened at startup, before the account that
   * owns it is known, so it starts out identified by its file name and is
   * renamed here once an account claims it. Without this, that mailbox's
   * provenance rows would be filed under `sarvinbox.db` and removing the
   * account could not find — and so could not subtract — what it contributed.
   *
   * Only ever set to a REAL account id, and only while the id is still unknown:
   * re-pointing a live connection at a different account would split one
   * mailbox's contributions across two provenance keys.
   */
  adoptAccountId(accountId: string): void {
    if (!accountId || this.config.accountId) return;
    this.config.accountId = accountId;
  }

  private accountKey(): string {
    if (this.config.accountId) return this.config.accountId;
    const path = this.config.dbPath;
    return path && path !== ':memory:' ? basename(path) : 'unknown-account';
  }

  private sharedContactsPath(): string {
    if (this.config.sharedContactsPath) return this.config.sharedContactsPath;
    const path = this.config.dbPath;
    if (!path || path === ':memory:' || path.startsWith('file::memory:')) return '';
    return join(dirname(path), SHARED_CONTACTS_FILE);
  }

  /**
   * Open + attach the shared contact directory.
   *
   * Deliberately NOT wrapped in a try/catch that carries on. If the directory
   * cannot be opened, every contact read would answer "none" — indistinguishable
   * from a genuinely empty address book, and the enrichment schedulers would
   * start rebuilding one on top of the real one. Failing here, loudly, at open
   * time is the only version of this that can be diagnosed.
   */
  private attachDirectory(): void {
    attachSharedContacts(this.db!, this.sharedContactsPath(), this.config.key);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.readModel?.stop();
      this.readModel = null;
      this.bodyStorage?.stop();
      this.bodyStorage = null;
      this.inlineImages?.stop();
      this.inlineImages = null;
      this.db.close();
      this.db = null;
      this.initialized = false;
      this._emailRepo = null;
      this._folderRepo = null;
      this._threadRepo = null;
      this._contactRepo = null;
      this._aiRepo = null;
      this._searchRepo = null;
      this._agentRepo = null;
      this._promptRepo = null;
      this._filterRepo = null;
      this._labelRepo = null;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getRepositories() {
    this.ensureInitialized();
    return {
      email: this.emailRepo,
      folder: this.folderRepo,
      thread: this.threadRepo,
      contact: this.contactRepo,
      ai: this.aiRepo,
      search: this.searchRepo,
      agent: this.agentRepo,
      prompts: this.promptRepo,
    };
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error('Storage not initialized');
    }
  }

  // ========== Email Operations ==========

  /**
   * Register the mailbox owner's own address(es) (the account email). The thread
   * resolver uses these to exclude "self" from same-subject participant overlap.
   * Idempotent; safe to call whenever the account identity is (re)resolved.
   */
  setSelfAddresses(addresses: string[]): void {
    this.selfAddresses = new Set(addresses.filter(Boolean).map((a) => a.toLowerCase()));
  }

  /**
   * Resolve the correct thread_id for an email by consulting the DB —
   * standard generateThreadId() in core hashes the FIRST entry of the
   * References header, but corporate webmail clients (sarv.com style)
   * often only put the immediate parent in References. The result is
   * one new thread per reply. resolveThreadId walks in_reply_to →
   * references chain → subject+participants fallback to find the
   * existing thread the email actually belongs to.
   *
   * Mutates `email.threadId` in place if a better match is found and
   * returns the email reference.
   */
  private resolveAndAttach(email: EmailRecord): EmailRecord {
    const result = resolveThreadId(this.db!, {
      id: email.id,
      messageId: email.messageId,
      threadId: email.threadId,
      subject: email.subject,
      fromAddress: email.fromAddress,
      toAddress: email.toAddress,
      ccAddress: email.ccAddress,
      date: email.date,
      inReplyTo: email.inReplyTo,
      references: (email as any).references ?? null,
      // Bulk/list mail (tagged at ingest) is excluded from the subject fallback.
      isBulk: (email.tags || '').includes('|bulk|'),
    }, { selfAddresses: this.selfAddresses });
    if (result.threadId !== email.threadId) {
      // Per-email reattach — TRACE (fires thousands of times on a large sync, so
      // it's dropped even in debug mode; set level=trace to see it).
      log.trace(`reattach ${email.id} ${email.threadId} → ${result.threadId} (via ${result.via})`);
      email.threadId = result.threadId;
    }
    return email;
  }

  /**
   * Mirror the sync existing-email path for a duplicate message_id:
   * add the folder's path tag to the already-stored row.
   */
  private linkExistingEmailToFolder(existing: { id: string; tags: string }, folderId: string): void {
    const folder = this.db!.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as { path: string } | undefined;
    if (!folder) return;
    const { addTag } = require('./repositories/email-repository');
    const newTags = addTag(existing.tags || '||', folder.path);
    if (newTags !== existing.tags) {
      this.db!.prepare('UPDATE emails SET tags = ? WHERE id = ?').run(newTags, existing.id);
    }
  }

  /**
   * Recompute a thread row's metadata from its emails. Deletes the row
   * when no emails reference it anymore (e.g. orphan reattachment
   * drained it) so husk threads don't get re-queued for extraction.
   */
  private recomputeThreadMeta(threadId: string): void {
    const stats = this.db!.prepare(`
      SELECT
        (SELECT id FROM emails WHERE thread_id = ? ORDER BY date ASC LIMIT 1) as first_id,
        (SELECT id FROM emails WHERE thread_id = ? ORDER BY date DESC LIMIT 1) as last_id,
        (SELECT MAX(date) FROM emails WHERE thread_id = ?) as last_date,
        (SELECT COUNT(*) FROM emails WHERE thread_id = ?) as count,
        (SELECT subject FROM emails WHERE thread_id = ? ORDER BY date ASC LIMIT 1) as subject
    `).get(threadId, threadId, threadId, threadId, threadId) as any;
    if (stats?.first_id) {
      this.db!.prepare(`
        UPDATE threads SET
          first_message_id = ?, last_message_id = ?, last_message_date = ?,
          message_count = ?, subject = ?
        WHERE id = ?
      `).run(stats.first_id, stats.last_id, stats.last_date, stats.count, stats.subject || '(No Subject)', threadId);
    } else {
      this.db!.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
    }
  }

  async insertEmail(email: EmailRecord): Promise<void> {
    this.ensureInitialized();

    const insert = this.db!.transaction(() => {
      // Dedupe on message_id (smtp-handlers relies on this when the
      // IMAP copy of a locally-written sent row arrives later) — link
      // the existing row to the folder instead of throwing on UNIQUE.
      if (email.messageId) {
        const existing = this.db!.prepare('SELECT id, tags FROM emails WHERE message_id = ?')
          .get(email.messageId) as { id: string; tags: string } | undefined;
        if (existing) {
          this.linkExistingEmailToFolder(existing, email.folderId);
          return;
        }
      }

      this.resolveAndAttach(email);
      // Ensure the threads row exists BEFORE inserting the email
      // (foreign_keys = ON — a new-thread insert would throw FK).
      const existingThread = this.db!.prepare('SELECT id FROM threads WHERE id = ?').get(email.threadId);
      if (!existingThread) {
        this.db!.prepare(`
          INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date, message_count)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(email.threadId, email.subject || '(No Subject)', email.id, email.id, email.date, 1);
      }
      this.emailRepo.insertSync(email);

      // Out-of-order: any orphan whose in_reply_to == my message_id
      // gets pulled into my thread.
      if (email.messageId) {
        const merged = reattachOrphans(this.db!, email.messageId, email.threadId);
        if (merged.changes > 0) {
          log.trace(`reattached ${merged.changes} orphan(s) under ${email.threadId}`);
          for (const prevId of merged.previousThreadIds) {
            this.recomputeThreadMeta(prevId);
          }
        }
      }
      this.recomputeThreadMeta(email.threadId);
    });

    insert();
  }

  async insertEmailBatch(emails: EmailRecord[]): Promise<void> {
    this.ensureInitialized();

    // Sort by date (oldest first) so parents land before children.
    // resolveAndAttach does a DB lookup on each email — for an in-batch parent
    // to be findable by its child, the parent must already be inserted.
    // Inserting in chronological order means any reply has its predecessor in
    // the DB by the time we resolve its thread_id. Sorted ONCE up front so we
    // can commit in chunks below: an earlier chunk's parents are already durable
    // before a later chunk's children resolve against them.
    const sortedAll = [...emails].sort((a, b) => a.date - b.date);

    // better-sqlite3 is synchronous, so one transaction over the whole batch
    // blocks the event loop for its entire duration — bad on initial sync
    // (thousands of messages). Commit in bounded chunks (each its own
    // transaction) and yield between chunks so IMAP/IPC/UI keep running.
    // At-least-once ingest is idempotent (message_id dedup), so a partial batch
    // on error is safe/resumable rather than the old all-or-nothing rollback.
    const CHUNK_SIZE = 100;

    const insertChunk = this.db!.transaction((chunk: EmailRecord[]) => {
      // Resolve + insert one email at a time, in order.
      const inserted: EmailRecord[] = [];
      const orphanSourceThreads = new Set<string>();
      for (const email of chunk) {
        // Tolerate duplicate message_ids (re-delivered messages, or two
        // no-Message-ID emails defaulted to the same id upstream) — a
        // plain INSERT would roll back the WHOLE batch on UNIQUE. Link
        // the existing row to the folder like the sync existing-email
        // path and skip. Also catches in-batch dupes (the first copy is
        // visible to this SELECT inside the transaction).
        if (email.messageId) {
          const existing = this.db!.prepare('SELECT id, tags FROM emails WHERE message_id = ?')
            .get(email.messageId) as { id: string; tags: string } | undefined;
          if (existing) {
            this.linkExistingEmailToFolder(existing, email.folderId);
            continue;
          }
        }
        this.resolveAndAttach(email);
        // Ensure the threads row exists BEFORE inserting the email
        // (FK CASCADE means we need it on disk first).
        const existingThread = this.db!.prepare('SELECT id FROM threads WHERE id = ?').get(email.threadId);
        if (!existingThread) {
          this.db!.prepare(`
            INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date, message_count)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(email.threadId, email.subject || '(No Subject)', email.id, email.id, email.date, 1);
        }
        this.emailRepo.insertSync(email);
        inserted.push(email);
        // Pull any orphans (children whose in_reply_to == this.messageId
        // that landed earlier under their own standalone thread_id) and
        // remember which threads they came from so those get recomputed.
        if (email.messageId) {
          const merged = reattachOrphans(this.db!, email.messageId, email.threadId);
          for (const prevId of merged.previousThreadIds) {
            orphanSourceThreads.add(prevId);
          }
        }
      }

      // Recompute thread metadata for every thread_id touched —
      // including the threads orphans were pulled OUT of (husks with
      // zero emails left get deleted by recomputeThreadMeta).
      const touchedThreads = new Set(inserted.map(e => e.threadId));
      for (const prevId of orphanSourceThreads) {
        touchedThreads.add(prevId);
      }
      for (const threadId of touchedThreads) {
        this.recomputeThreadMeta(threadId);
      }
    });

    for (let i = 0; i < sortedAll.length; i += CHUNK_SIZE) {
      insertChunk(sortedAll.slice(i, i + CHUNK_SIZE));
      // Let the event loop breathe between chunks (skip the yield after the
      // last chunk — nothing waits on it).
      if (i + CHUNK_SIZE < sortedAll.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    // Auto-extract contacts
    this.autoExtractContacts(emails).catch(err => {
      log.error('[Storage] Failed to auto-extract contacts:', err);
    });
  }

  private async autoExtractContacts(emails: EmailRecord[]): Promise<void> {
    const { hasTag, hasSentFolderTag } = require('./repositories/email-repository');

    // Wrap the entire extraction pass in ONE better-sqlite3 transaction so
    // it commits (and fsyncs) once instead of once per statement. A large
    // sync would otherwise fire 40-60K individually-durable SELECT+UPSERTs.
    // The callback must be synchronous, so it calls the repo's *Sync methods.
    const extract = this.db!.transaction((batch: EmailRecord[]) => {
      for (const email of batch) {
        const tags = email.tags || '||';
        const isSentFolder = hasSentFolderTag(tags);
        this.contactRepo.extractFromEmailSync(email, isSentFolder ? 'sent' : 'received');

        if (isSentFolder && email.toAddress) {
          const isReply = !!email.inReplyTo || (email.subject || '').match(/^Re:/i) !== null;
          const recipients = parseAddresses(email.toAddress);
          for (const addr of recipients) {
            this.contactRepo.upsertSenderStatsSync({
              email: addr,
              sentToCount: 1,
              eventDate: email.date,
              ...(isReply ? { repliedCount: 1 } : {}),
            });
          }
        } else if (!isSentFolder && email.fromAddress) {
          const isRead = hasTag(tags, 'read');
          const isTrashFolder = tags.toLowerCase().includes('|trash|') || tags.toLowerCase().includes('|deleted');
          this.contactRepo.upsertSenderStatsSync({
            email: email.fromAddress,
            receivedCount: 1,
            eventDate: email.date,
            ...(isRead ? { readCount: 1 } : {}),
            ...(isTrashFolder ? { deletedCount: 1 } : {}),
          });
        }
      }
    });

    // Commit in chunks (each its own transaction) and yield between them, same
    // as insertEmailBatch — this is a second synchronous pass over the batch, so
    // over a large sync it would otherwise block the loop on its own.
    const CHUNK_SIZE = 100;
    for (let i = 0; i < emails.length; i += CHUNK_SIZE) {
      extract(emails.slice(i, i + CHUNK_SIZE));
      if (i + CHUNK_SIZE < emails.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  async updateEmail(id: string, updates: Partial<EmailRecord>): Promise<void> {
    this.ensureInitialized();

    // Track read tag transitions for sender_stats.read_count
    if (updates.tags) {
      const { hasTag } = require('./repositories/email-repository');
      const existing = await this.emailRepo.get(id);
      if (existing?.fromAddress) {
        const wasRead = hasTag(existing.tags, 'read');
        const nowRead = hasTag(updates.tags, 'read');
        if (nowRead && !wasRead) {
          this.contactRepo.upsertSenderStats({ email: existing.fromAddress, readCount: 1 }).catch(() => {});
        } else if (!nowRead && wasRead) {
          this.contactRepo.upsertSenderStats({ email: existing.fromAddress, readCount: -1 }).catch(() => {});
        }
      }
    }

    return this.emailRepo.update(id, updates);
  }

  /**
   * Batched tag-only update for many emails in ONE transaction (one WAL commit
   * instead of N). Used by the bulk mark-read/unread/star handler. Unlike
   * `updateEmail` this does NOT re-`SELECT` each row (the caller already has the
   * old tags), so bulk-marking N emails is N prepared UPDATEs inside a single
   * transaction rather than N × (SELECT + UPDATE + implicit commit).
   *
   * Read transitions (for sender read-count stats) are passed in by the caller —
   * we aggregate the net per-sender delta and apply it best-effort AFTER the
   * transaction, off the hot path.
   */
  async bulkUpdateTags(
    updates: Array<{ id: string; tags: string; fromAddress?: string; wasRead?: boolean; nowRead?: boolean }>,
  ): Promise<void> {
    this.ensureInitialized();
    if (updates.length === 0) return;
    const db = this.db!;
    const stmt = db.prepare('UPDATE emails SET tags = ? WHERE id = ?');
    const applyChunk = db.transaction((rows: typeof updates) => {
      for (const r of rows) stmt.run(r.tags, r.id);
    });
    // better-sqlite3 is synchronous, so one transaction over a huge selection
    // (e.g. "select all → mark read" on a big mailbox) blocks the main-process
    // event loop for its whole duration, stalling IMAP IDLE / other IPC. Commit
    // in bounded chunks and yield between them — mirrors insertEmailBatch. The
    // op is idempotent, so a partial apply on error is safe.
    const CHUNK_SIZE = 500;
    for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
      applyChunk(updates.slice(i, i + CHUNK_SIZE));
      if (i + CHUNK_SIZE < updates.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    // Aggregate net read-count deltas per sender (best-effort; never blocks).
    const deltas = new Map<string, number>();
    for (const r of updates) {
      if (!r.fromAddress || r.wasRead === undefined || r.nowRead === undefined) continue;
      if (r.nowRead && !r.wasRead) deltas.set(r.fromAddress, (deltas.get(r.fromAddress) || 0) + 1);
      else if (!r.nowRead && r.wasRead) deltas.set(r.fromAddress, (deltas.get(r.fromAddress) || 0) - 1);
    }
    for (const [email, delta] of deltas) {
      if (delta !== 0) this.contactRepo.upsertSenderStats({ email, readCount: delta }).catch(() => {});
    }
  }

  async getEmail(id: string): Promise<EmailRecord | null> {
    this.ensureInitialized();
    return this.emailRepo.get(id);
  }

  async getEmailByMessageId(messageId: string): Promise<EmailRecord | null> {
    this.ensureInitialized();
    return this.emailRepo.getByMessageId(messageId);
  }

  async getEmailByFolderAndUid(folderId: string, uid: number): Promise<EmailRecord | null> {
    this.ensureInitialized();
    return this.emailRepo.getByFolderAndUid(folderId, uid);
  }

  async getEmailIdsByFolderAndUids(folderId: string, uids: number[]): Promise<Array<{ id: string; uid: number }>> {
    this.ensureInitialized();
    return this.emailRepo.getIdsByFolderAndUids(folderId, uids);
  }

  async getEmailsByMessageIds(messageIds: string[]): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.emailRepo.getByMessageIds(messageIds);
  }

  async getEmailsByIds(ids: string[]): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.emailRepo.getByIds(ids);
  }

  async getIncompleteEmails(limit: number): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.emailRepo.getIncomplete(limit);
  }

  async deleteEmail(id: string): Promise<void> {
    this.ensureInitialized();
    return this.emailRepo.delete(id);
  }

  async deleteEmails(ids: string[]): Promise<void> {
    this.ensureInitialized();
    return this.emailRepo.deleteMany(ids);
  }

  /**
   * Drop every email's membership of `folderId`, returning how many rows were
   * affected.
   *
   * NOT a blind `DELETE ... WHERE instr(tags, '|path|')`: that also destroyed
   * multi-folder (Gmail-label) rows which still live in OTHER folders — one
   * UIDVALIDITY change on a mirror folder wiped mail out of every folder it
   * belonged to. Unlink-or-delete keeps rows that survive elsewhere (dropping
   * only this folder's tag, repointing the primary) and hard-deletes only rows
   * that belong to no other folder.
   */
  async deleteEmailsByFolder(folderId: string): Promise<number> {
    this.ensureInitialized();
    const { unlinked, deleted } = await this.folderRepo.invalidateFolderMembership(folderId);
    return unlinked + deleted;
  }

  async markSentEmailsAsRead(): Promise<number> {
    this.ensureInitialized();
    return this.emailRepo.markSentAsRead();
  }

  async getAllEmails(options: { limit?: number; offset?: number } = {}): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.emailRepo.getAll(options);
  }

  async getImportantEmails(options: { limit?: number; offset?: number } = {}): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.emailRepo.getImportant(options);
  }

  async getStarredEmails(options: { limit?: number; offset?: number } = {}): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.emailRepo.getStarred(options);
  }

  /** The Snoozed view's rows, as EMAILS — the same shape every other listing
   *  hands the renderer, so the view does not have to fetch each message back
   *  one IPC call at a time. `limit`/`offset` count conversations. */
  async getSnoozedEmailRecords(options: { limit?: number; offset?: number } = {}): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.emailRepo.getSnoozed(options);
  }

  async getAllCount(): Promise<number> {
    this.ensureInitialized();
    return this.emailRepo.getAllCount();
  }

  async countEmailsInFolder(folderId: string, options: { filter?: ViewFilter; categoryTag?: string } = {}): Promise<number> {
    this.ensureInitialized();
    return this.emailRepo.countByFolder(folderId, options);
  }

  async getImportantCount(): Promise<number> {
    this.ensureInitialized();
    return this.emailRepo.getImportantCount();
  }

  async getStarredCount(): Promise<number> {
    this.ensureInitialized();
    return this.emailRepo.getStarredCount();
  }

  async getUnreadImportantCount(): Promise<number> {
    this.ensureInitialized();
    return this.emailRepo.getUnreadImportantCount();
  }

  // ========== Section Queries (per-section independent pagination) ==========

  async getEmailsBySection(filter: string, options: { limit: number; offset: number; folderPath?: string; viewFilter?: ViewFilter }): Promise<EmailRecord[]> {
    this.ensureInitialized();
    // Read-model fast path (thread_folders indexed scan) when enabled + ready and
    // the view is folder-scoped. Falls through to the legacy GROUP BY otherwise.
    if (this.emailRepo.readModelReadsEnabled()) {
      const folderId = this.emailRepo.folderIdForPath(options.folderPath);
      if (folderId) {
        return this.emailRepo.listSectionFast(filter, folderId, {
          limit: options.limit, offset: options.offset, viewFilter: options.viewFilter,
        });
      }
    }
    switch (filter) {
      case 'important_unread':
        return this.emailRepo.getImportantUnread(options);
      case 'starred':
        return this.emailRepo.getStarredNotImportantUnread(options);
      case 'everything_else':
        return this.emailRepo.getEverythingElse(options);
      case 'important':
        return this.emailRepo.getImportantSection(options);
      case 'unread':
        return this.emailRepo.getUnreadSection(options);
      case 'not_important':
        return this.emailRepo.getNotImportantSection(options);
      case 'read':
        return this.emailRepo.getReadSection(options);
      default:
        return [];
    }
  }

  async getSectionCount(filter: string, folderPath?: string, viewFilter?: ViewFilter): Promise<number> {
    this.ensureInitialized();
    return this.emailRepo.getSectionCount(filter, folderPath, viewFilter);
  }

  async getSectionCounts(filters: string[], folderPath?: string, viewFilter?: ViewFilter): Promise<Record<string, number>> {
    this.ensureInitialized();
    const counts: Record<string, number> = {};
    for (const filter of filters) {
      counts[filter] = await this.emailRepo.getSectionCount(filter, folderPath, viewFilter);
    }
    return counts;
  }

  async searchEmails(query: SearchQuery): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.searchRepo.search(query);
  }

  /** True total of ALL rows matching a search (no limit/offset) — the paginator's
   *  "of N" over the whole mailbox, not just the loaded page. */
  async searchEmailsCount(query: SearchQuery): Promise<number> {
    this.ensureInitialized();
    return this.searchRepo.count(query);
  }

  async getEmailsByFolder(folderId: string, options: PaginationOptions & { categoryTag?: string; collapseThreads?: boolean }): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.emailRepo.getByFolder(folderId, options);
  }

  /** Thread-grained "of N" denominator for a folder view, matching
   *  getByFolder's read-model (thread) pagination. Returns null when the
   *  read-model isn't ready (getByFolder then paginates by message, so the
   *  caller keeps the legacy message-count total). */
  async getFolderThreadCount(folderPath?: string, viewFilter?: ViewFilter): Promise<number | null> {
    this.ensureInitialized();
    if (!this.emailRepo.readModelReadsEnabled()) return null;
    const folderId = this.emailRepo.folderIdForPath(folderPath);
    if (!folderId) return null;
    return this.emailRepo.countFolderFast(folderId, viewFilter);
  }

  async getEmailsByThread(threadId: string): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.emailRepo.getByThread(threadId);
  }

  async fullTextSearch(query: string, options?: SearchQuery): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.searchRepo.search({
      ...options,
      query,
      limit: options?.limit || 100,
    });
  }

  /** Rebuild the FTS5 search index */
  async rebuildSearchIndex(): Promise<void> {
    this.ensureInitialized();
    this.searchRepo.rebuildIndex();
  }

  /** Get search term suggestions */
  getSearchSuggestions(partial: string): string[] {
    this.ensureInitialized();
    return this.searchRepo.suggestTerms(partial);
  }

  async getRecentEmails(options: { sinceTimestamp: number; limit?: number }): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.emailRepo.getRecent(options);
  }

  // ========== Folder Operations ==========

  async syncFolders(folders: FolderRecord[]): Promise<void> {
    this.ensureInitialized();
    return this.folderRepo.sync(folders);
  }

  async getFolders(): Promise<FolderRecord[]> {
    this.ensureInitialized();
    return this.folderRepo.getAll();
  }

  async getFolder(id: string): Promise<FolderRecord | null> {
    this.ensureInitialized();
    return this.folderRepo.get(id);
  }

  async getFolderByPath(path: string): Promise<FolderRecord | null> {
    this.ensureInitialized();
    return this.folderRepo.getByPath(path);
  }

  async updateFolder(id: string, updates: Partial<FolderRecord>): Promise<void> {
    this.ensureInitialized();
    return this.folderRepo.update(id, updates);
  }

  async deleteFolder(id: string): Promise<void> {
    this.ensureInitialized();
    return this.folderRepo.delete(id);
  }

  async linkEmailToFolder(emailId: string, folderId: string, uid?: number, flags?: string[]): Promise<void> {
    this.ensureInitialized();
    return this.folderRepo.linkEmail(emailId, folderId, uid, flags);
  }

  async unlinkEmailFromFolder(emailId: string, folderId: string): Promise<void> {
    this.ensureInitialized();
    return this.folderRepo.unlinkEmail(emailId, folderId);
  }

  async unlinkOrDeleteEmailsFromFolder(emailIds: string[], folderId: string): Promise<{ unlinked: number; deleted: number }> {
    this.ensureInitialized();
    return this.folderRepo.unlinkOrDeleteFromFolder(emailIds, folderId);
  }

  async invalidateFolderMembership(folderId: string): Promise<{ unlinked: number; deleted: number }> {
    this.ensureInitialized();
    return this.folderRepo.invalidateFolderMembership(folderId);
  }

  async getEmailFolders(emailId: string): Promise<{ folderId: string; uid: number | null; flags: string[] }[]> {
    this.ensureInitialized();
    return this.folderRepo.getEmailFolders(emailId);
  }

  async getEmailWithFolders(messageId: string): Promise<{ email: EmailRecord; folders: string[] } | null> {
    this.ensureInitialized();
    const email = await this.getEmailByMessageId(messageId);
    if (!email) return null;
    const folderLinks = await this.getEmailFolders(email.id);
    return { email, folders: folderLinks.map(f => f.folderId) };
  }

  async updateEmailFolderFlags(emailId: string, folderId: string, flags: string[]): Promise<void> {
    this.ensureInitialized();
    return this.folderRepo.updateEmailFolderFlags(emailId, folderId, flags);
  }

  async getEmailsByFolderViaJunction(folderId: string, options: PaginationOptions): Promise<EmailRecord[]> {
    this.ensureInitialized();
    // Junction table removed — all queries are tags-based now
    return this.emailRepo.getByFolder(folderId, options);
  }

  /**
   * Lightweight {id, uid} for EVERY email whose PRIMARY folder is `folderId` and
   * that carries a server UID. Used by non-CONDSTORE deletion detection to diff
   * the WHOLE folder's local UIDs against the server's full UID set — the recent
   * (200) window missed server-side deletions of OLD mail (they orphaned locally
   * as ghost rows). Indexed by folder_id, so it's a cheap id+uid scan, not a
   * full-record load.
   */
  async getEmailUidsInFolder(folderId: string): Promise<Array<{ id: string; uid: number }>> {
    this.ensureInitialized();
    return this.emailRepo.getUidsInFolder(folderId);
  }

  /**
   * Lightweight `{id, uid, tags}` for EVERY email whose PRIMARY folder is
   * `folderId` — same row set as `getEmailUidsInFolder`, plus the tags string.
   *
   * This is what IMAP flag reconciliation should page through instead of
   * `getEmailsByFolder`: it reads three small columns off the
   * `(folder_id, uid)` index in keyset pages (never OFFSET), with no
   * THREAD_META subqueries and no body columns, and yields the event loop
   * between pages so a big folder can't stall the main process.
   */
  async getEmailTagsInFolder(folderId: string): Promise<Array<{ id: string; uid: number | null; tags: string }>> {
    this.ensureInitialized();
    return this.emailRepo.getTagsInFolder(folderId);
  }

  /**
   * Count emails carrying `folderPath` as a membership tag — the tag-based
   * membership the folder view renders (includes cross-folder linked messages),
   * used by the addition reconcile to avoid re-fetching already-visible mail.
   */
  async countEmailsWithFolderTag(folderPath: string): Promise<number> {
    this.ensureInitialized();
    return this.emailRepo.countByFolderTag(folderPath);
  }

  /**
   * Count emails FILED in this folder (primary `folder_id`) — the count that
   * separates two names for one mailbox, where the tag count cannot.
   */
  async countEmailsFiledIn(folderId: string): Promise<number> {
    this.ensureInitialized();
    return this.emailRepo.countByPrimaryFolder(folderId);
  }

  async getFolderMembersOutsideUidSpace(
    folderId: string,
    folderPath: string,
  ): Promise<Array<{ id: string; messageId: string; folderId: string; uid: number | null }>> {
    this.ensureInitialized();
    return this.emailRepo.getMembersOutsideUidSpace(folderId, folderPath);
  }

  /**
   * Lowest server UID among emails whose primary folder is `folderId`, or null
   * when none. The historical backfill's starting floor — it pages older mail
   * downward from the oldest UID already stored.
   */
  async getOldestUidInFolder(folderId: string): Promise<number | null> {
    this.ensureInitialized();
    return this.emailRepo.getMinUidInFolder(folderId);
  }

  async recalculateFolderCounts(folderPaths?: string[]): Promise<void> {
    this.ensureInitialized();
    return this.folderRepo.recalculateFolderCounts(folderPaths);
  }

  /** Scan-free unread_count maintenance for a single read-flag flip (hot path).
   *  See FolderRepository.applyReadFlagDelta. */
  async applyReadFlagToFolderCounts(emailId: string, nowRead: boolean): Promise<void> {
    this.ensureInitialized();
    return this.folderRepo.applyReadFlagDelta(emailId, nowRead);
  }

  /** Scan-free unread_count maintenance for a BATCH of read-flag flips (bulk
   *  mark-read/unread, realtime flag sync). See
   *  FolderRepository.applyReadFlagDeltaBatch. */
  async applyReadFlagToFolderCountsBatch(flips: Array<{ emailId: string; nowRead: boolean }>): Promise<void> {
    this.ensureInitialized();
    return this.folderRepo.applyReadFlagDeltaBatch(flips);
  }

  async recalculateStarredCount(): Promise<number> {
    this.ensureInitialized();
    return this.folderRepo.recalculateStarredCount();
  }

  // ========== Thread Operations ==========

  async upsertThread(thread: ThreadRecord): Promise<void> {
    this.ensureInitialized();
    return this.threadRepo.upsert(thread);
  }

  async getThread(id: string): Promise<ThreadRecord | null> {
    this.ensureInitialized();
    return this.threadRepo.get(id);
  }

  async getThreads(options: PaginationOptions): Promise<ThreadRecord[]> {
    this.ensureInitialized();
    return this.threadRepo.getAll(options);
  }

  async rebuildThreads(): Promise<{ emailsUpdated: number; threadsCreated: number }> {
    this.ensureInitialized();
    return this.threadRepo.rebuild();
  }

  async updateThread(id: string, updates: Partial<ThreadRecord>): Promise<void> {
    this.ensureInitialized();
    return this.threadRepo.update(id, updates);
  }

  async deleteThread(id: string): Promise<void> {
    this.ensureInitialized();
    return this.threadRepo.delete(id);
  }

  async insertAttachment(attachment: AttachmentRecord): Promise<void> {
    this.ensureInitialized();
    return this.threadRepo.insertAttachment(attachment);
  }

  async getAttachments(emailId: string): Promise<AttachmentRecord[]> {
    this.ensureInitialized();
    return this.threadRepo.getAttachments(emailId);
  }

  async deleteAttachment(id: string): Promise<void> {
    this.ensureInitialized();
    return this.threadRepo.deleteAttachment(id);
  }

  // ========== Statistics & Maintenance ==========

  /**
   * File occupancy: how much of the database is real data and how much is
   * freelist — pages that hold nothing but are still in the file.
   *
   * SQLite never hands freed pages back to the OS (these DBs run
   * `auto_vacuum = 0`), so after a bulk one-off — the body-table migration, the
   * inline-image rewrite, a full-mailbox re-ingest — the file can be mostly
   * holes. This is the cheap read (three pragmas, no table access) behind the
   * "Compress database" estimate; the reclaim itself is a VACUUM, which runs on
   * a worker thread against a CLOSED handle.
   */
  getPageStats(): DatabasePageStats {
    this.ensureInitialized();
    const pragmaValue = (name: string): number =>
      Number(this.db!.pragma(name, { simple: true })) || 0;

    return {
      pageSize: pragmaValue('page_size'),
      pageCount: pragmaValue('page_count'),
      freelistCount: pragmaValue('freelist_count'),
    };
  }

  async getStats(): Promise<StorageStats> {
    this.ensureInitialized();

    const stats = this.db!.prepare(`
      SELECT
        (SELECT COUNT(*) FROM emails) as totalEmails,
        (SELECT COUNT(*) FROM threads) as totalThreads,
        (SELECT COUNT(*) FROM folders) as totalFolders,
        (SELECT COUNT(*) FROM attachments) as totalAttachments,
        (SELECT COUNT(*) FROM embedding_metadata) as totalEmbeddings
    `).get() as any;

    const dbSize = this.db!.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as any;
    const lastSync = this.db!.prepare('SELECT MAX(last_sync_time) as lastSyncTime FROM folders').get() as any;

    return {
      totalEmails: stats.totalEmails,
      totalThreads: stats.totalThreads,
      totalFolders: stats.totalFolders,
      totalAttachments: stats.totalAttachments,
      totalEmbeddings: stats.totalEmbeddings,
      databaseSize: dbSize.size,
      attachmentsSize: 0,
      lastSyncTime: lastSync.lastSyncTime,
    };
  }

  async vacuum(): Promise<void> {
    this.ensureInitialized();
    this.db!.exec('VACUUM');
  }

  async checkIntegrity(): Promise<boolean> {
    this.ensureInitialized();
    const result = this.db!.prepare('PRAGMA integrity_check').get() as any;
    return result.integrity_check === 'ok';
  }

  // ========== Contact Operations ==========

  async upsertContact(contact: Partial<ContactRecord> & { email: string }): Promise<ContactRecord> {
    this.ensureInitialized();
    return this.contactRepo.upsert(contact);
  }

  async getContactByEmail(email: string): Promise<ContactRecord | null> {
    this.ensureInitialized();
    return this.contactRepo.getByEmail(email);
  }

  async getContact(id: string): Promise<ContactRecord | null> {
    this.ensureInitialized();
    return this.contactRepo.get(id);
  }

  async getContacts(options: PaginationOptions & { search?: string; contactType?: string }): Promise<ContactRecord[]> {
    this.ensureInitialized();
    return this.contactRepo.getAll(options);
  }

  async getContactsCount(search?: string, contactType?: string): Promise<number> {
    this.ensureInitialized();
    return this.contactRepo.getCount(search, contactType);
  }

  async updateContact(id: string, updates: Partial<ContactRecord>): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.update(id, updates);
  }

  async deleteContact(id: string): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.delete(id);
  }

  // ========== Contact Enrichment Operations (v39) ==========

  async getContactEnrichmentCandidates(opts: { minAgeDays?: number; limit?: number } = {}) {
    this.ensureInitialized();
    return this.contactRepo.getEnrichmentCandidates(opts);
  }

  async applyContactEnrichment(input: import('./repositories/contact-repository').ApplyEnrichmentInput) {
    this.ensureInitialized();
    return this.contactRepo.applyEnrichment(input);
  }

  async applyPhoneClassification(email: string, officePhone: string | null, directPhone: string | null, linkedinUrl: string | null = null): Promise<void> {
    this.ensureInitialized();
    this.contactRepo.applyPhoneClassification(email, officePhone, directPhone, linkedinUrl);
  }

  async applyPersonalUrls(email: string, urls: { twitter?: string | null; website?: string | null; socials?: string[] }): Promise<void> {
    this.ensureInitialized();
    this.contactRepo.applyPersonalUrls(email, urls);
  }

  async applyCompanyUrls(domain: string, urls: { twitter?: string | null; website?: string | null; socials?: string[] }): Promise<void> {
    this.ensureInitialized();
    this.contactRepo.applyCompanyUrls(domain, urls);
  }

  async applyLinkedInUrl(email: string, url: string): Promise<void> {
    this.ensureInitialized();
    this.contactRepo.applyLinkedInUrl(email, url);
  }

  async recordContactEnrichmentWatermark(contactId: string, throughEmailAt: number): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.recordEnrichmentWatermark(contactId, throughEmailAt);
  }

  async setContactAvatarCandidate(contactId: string, dataUri: string): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.setAvatarCandidate(contactId, dataUri);
  }

  async confirmContactAvatar(contactId: string): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.confirmAvatar(contactId);
  }

  async markContactAvatarChecked(contactId: string): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.markAvatarChecked(contactId);
  }

  async rejectContactAvatar(contactId: string): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.rejectAvatar(contactId);
  }

  async getContactsNeedingAvatar(limit: number, staleBefore: number) {
    this.ensureInitialized();
    return this.contactRepo.getContactsNeedingAvatar(limit, staleBefore);
  }

  async getContactEnrichmentHistory(contactId: string) {
    this.ensureInitialized();
    return this.contactRepo.getEnrichmentHistory(contactId);
  }

  async getContactsRelatedByPerson(contactId: string) {
    this.ensureInitialized();
    return this.contactRepo.getRelatedByPerson(contactId);
  }

  async getRecentInboundEmailsForContact(email: string, limit = 20) {
    this.ensureInitialized();
    return this.contactRepo.getRecentInboundEmails(email, limit);
  }

  async extractContactsFromEmail(email: EmailRecord, direction: 'sent' | 'received'): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.extractFromEmail(email, direction);
  }

  // ========== Sender Context ==========

  getSenderContextBatch(emails: string[]): Record<string, import('./repositories/contact-repository').SenderContext> {
    this.ensureInitialized();
    return this.contactRepo.getSenderContextBatch(emails);
  }

  /**
   * Get thread depths (message counts) for a batch of thread IDs.
   * Used by AI categorization to detect active conversations.
   */
  getThreadDepths(threadIds: string[]): Record<string, number> {
    this.ensureInitialized();
    if (threadIds.length === 0) return {};

    const placeholders = threadIds.map(() => '?').join(',');
    const rows = this.db!.prepare(`
      SELECT thread_id, COUNT(*) as depth
      FROM emails
      WHERE thread_id IN (${placeholders})
      GROUP BY thread_id
    `).all(...threadIds) as Array<{ thread_id: string; depth: number }>;

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.thread_id] = row.depth;
    }
    return result;
  }

  /**
   * For a list of sender addresses, return same-subject counts and total email count.
   * Used by AI categorization to detect repetitive/automated senders.
   */
  getSenderRepetitionStats(fromAddresses: string[]): { sameSubject: Record<string, Record<string, number>>; totalEmails: number } {
    this.ensureInitialized();
    if (fromAddresses.length === 0) return { sameSubject: {}, totalEmails: 0 };

    const placeholders = fromAddresses.map(() => '?').join(',');
    const lowered = fromAddresses.map(e => e.toLowerCase());

    // Same-subject counts per sender+subject
    const rows = this.db!.prepare(`
      SELECT LOWER(from_address) as from_address, subject, COUNT(*) as cnt
      FROM emails
      WHERE LOWER(from_address) IN (${placeholders})
      GROUP BY LOWER(from_address), subject
    `).all(...lowered) as Array<{ from_address: string; subject: string; cnt: number }>;

    const sameSubject: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      if (!sameSubject[row.from_address]) sameSubject[row.from_address] = {};
      sameSubject[row.from_address][row.subject || ''] = row.cnt;
    }

    // Total emails in DB for volume % calculation
    const total = this.db!.prepare('SELECT COUNT(*) as cnt FROM emails').get() as { cnt: number };

    return { sameSubject, totalEmails: total.cnt };
  }

  // ========== Sender Stats Operations ==========

  async getSenderStats(email: string): Promise<SenderStats | null> {
    this.ensureInitialized();
    return this.contactRepo.getSenderStats(email);
  }

  async getSenderEngagement(email: string): Promise<{ received: number; read: number; deleted: number }> {
    this.ensureInitialized();
    return this.emailRepo.getSenderEngagement(email);
  }

  async getSenderStatsByDomain(domain: string): Promise<SenderStats[]> {
    this.ensureInitialized();
    return this.contactRepo.getSenderStatsByDomain(domain);
  }

  async upsertSenderStats(stats: { email: string; receivedCount?: number; repliedCount?: number; sentToCount?: number; readCount?: number; deletedCount?: number; authPass?: boolean; eventDate?: number }): Promise<SenderStats> {
    this.ensureInitialized();
    return this.contactRepo.upsertSenderStats(stats);
  }

  /** Absolute (idempotent) counter write — see ContactRepository.setSenderStatsCounts. */
  async setSenderStatsCounts(
    entries: Array<{
      email: string;
      receivedCount: number; readCount: number; deletedCount: number;
      repliedCount: number; sentToCount: number;
    }>,
  ): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.setSenderStatsCounts(entries);
  }

  /** See ContactRepository.getContactTypeSync. */
  getContactType(email: string): string {
    this.ensureInitialized();
    return this.contactRepo.getContactTypeSync(email);
  }

  /** See ContactRepository.getPhoneMiningState. */
  getPhoneMiningState(): Map<string, { through: number; phones: Record<string, number> }> {
    this.ensureInitialized();
    return this.contactRepo.getPhoneMiningState();
  }

  /** See ContactRepository.getNewestEmailDateBySender. */
  getNewestEmailDateBySender(): Map<string, number> {
    this.ensureInitialized();
    return this.contactRepo.getNewestEmailDateBySender();
  }

  /** See ContactRepository.setPhoneMiningState. */
  setPhoneMiningState(email: string, through: number, phones: Record<string, number>): void {
    this.ensureInitialized();
    this.contactRepo.setPhoneMiningState(email, through, phones);
  }

  async setSenderVip(email: string, isVip: boolean): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.setSenderVip(email, isVip);
  }

  async setSenderBlocked(email: string, isBlocked: boolean): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.setSenderBlocked(email, isBlocked);
  }

  async getVipSenders(): Promise<SenderStats[]> {
    this.ensureInitialized();
    return this.contactRepo.getVipSenders();
  }

  async getBlockedSenders(): Promise<SenderStats[]> {
    this.ensureInitialized();
    return this.contactRepo.getBlockedSenders();
  }

  async updateEmailImportance(emailId: string, score: number, source: 'rule' | 'ai' | 'user'): Promise<void> {
    this.ensureInitialized();
    return this.aiRepo.updateImportance(emailId, score, source);
  }

  async updateEmailAuthStatus(emailId: string, authStatus: string): Promise<void> {
    this.ensureInitialized();
    return this.aiRepo.updateAuthStatus(emailId, authStatus);
  }

  async getEmailsNeedingProcessing(limit: number = 100): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.aiRepo.getEmailsNeedingProcessing(limit);
  }

  /**
   * "This email's body has not been downloaded", for the body-fetch schedulers.
   *
   * Was spelled `clean_body = '' AND raw_body = ''` inline at five call sites.
   * Two things were wrong with that once the bodies moved to `email_bodies`
   * (migration 73): the inline columns are NULL on a relocated row and `NULL = ''`
   * is NULL, so every one of these queries would have returned nothing and the
   * body prefetch would have gone permanently silent on a fully-synced mailbox —
   * bodies simply stop arriving, with no error. The shared clause also closes a
   * pre-existing gap in the same breath: `= ''` never matched a row whose body
   * column was NULL rather than empty, so those rows were never queued for
   * download either.
   */
  private missingBody(): string {
    return missingBodyClause('', areBodyLengthsReady(this.db!));
  }

  getEmailIdsWithoutBody(limit: number = 200): string[] {
    this.ensureInitialized();
    const rows = this.db!.prepare(
      `SELECT id FROM emails WHERE ${this.missingBody()} ORDER BY date DESC LIMIT ?`
    ).all(limit) as { id: string }[];
    return rows.map(r => r.id);
  }

  /**
   * Same as getEmailIdsWithoutBody but only unread, not-in-spam-or-trash
   * emails. Used by the background body-fetch scheduler — read emails
   * have already been triaged by the user, so spending bandwidth /
   * server time on their bodies has no payoff (categorization /
   * conversation extraction skip them anyway).
   */
  getUnreadEmailIdsWithoutBody(limit: number = 200): string[] {
    this.ensureInitialized();
    const rows = this.db!.prepare(`
      SELECT id FROM emails
      WHERE ${this.missingBody()}
        AND instr(tags, '|read|') = 0
        AND instr(tags, '|Spam|') = 0
        AND instr(tags, '|Junk|') = 0
        AND instr(tags, '|Trash|') = 0
        AND instr(tags, '|[Gmail]/Spam|') = 0
        AND instr(tags, '|[Gmail]/Trash|') = 0
        AND instr(tags, '|Junk Email|') = 0
        AND instr(tags, '|Deleted Items|') = 0
        AND instr(tags, '|nobody|') = 0
      ORDER BY date DESC LIMIT ?
    `).all(limit) as { id: string }[];
    return rows.map(r => r.id);
  }

  /**
   * Count of unread emails missing a body — for telemetry / UI badges.
   */
  countUnreadEmailsWithoutBody(): number {
    this.ensureInitialized();
    const row = this.db!.prepare(`
      SELECT COUNT(*) AS n FROM emails
      WHERE ${this.missingBody()}
        AND instr(tags, '|read|') = 0
        AND instr(tags, '|Spam|') = 0
        AND instr(tags, '|Junk|') = 0
        AND instr(tags, '|Trash|') = 0
        AND instr(tags, '|[Gmail]/Spam|') = 0
        AND instr(tags, '|[Gmail]/Trash|') = 0
        AND instr(tags, '|Junk Email|') = 0
        AND instr(tags, '|Deleted Items|') = 0
        AND instr(tags, '|nobody|') = 0
    `).get() as { n: number };
    return row?.n || 0;
  }

  /**
   * Count of ALL emails missing a body (read or unread), excluding
   * Trash/Spam/Junk. Used by the body-prefetch scheduler now that the
   * scope is per-thread instead of unread-only — when the user opens
   * an older thread we still need every message's body for conversation
   * extraction, even if the older messages are already read.
   */
  countEmailsWithoutBody(): number {
    this.ensureInitialized();
    const row = this.db!.prepare(`
      SELECT COUNT(*) AS n FROM emails
      WHERE ${this.missingBody()}
        AND instr(tags, '|Spam|') = 0
        AND instr(tags, '|Junk|') = 0
        AND instr(tags, '|Trash|') = 0
        AND instr(tags, '|[Gmail]/Spam|') = 0
        AND instr(tags, '|[Gmail]/Trash|') = 0
        AND instr(tags, '|Junk Email|') = 0
        AND instr(tags, '|Deleted Items|') = 0
        AND instr(tags, '|nobody|') = 0
    `).get() as { n: number };
    return row?.n || 0;
  }

  /**
   * Seed query for the body-prefetch scheduler: newest emails of any
   * read state that are missing bodies, with Trash/Spam/Junk excluded.
   * The thread-sibling expansion in getThreadSiblingsWithoutBody fans
   * out from these seeds so the scheduler ends up draining the latest
   * N threads' worth of bodies, not just the unread tail.
   */
  /**
   * Mark emails as permanently un-fetchable (tag `|nobody|`) so the body
   * prefetch backlog queries above STOP re-seeding them. Used by the scheduler
   * after a body fetch fails repeatedly — e.g. a ghost row whose server UID was
   * expunged ("No message found for UID N"): without this the prefetcher retries
   * the same dead UIDs every 60s forever, churning IMAP connections and never
   * draining. Tags are pipe-delimited with a trailing '|', so appending
   * 'nobody|' yields a valid marker; idempotent via the instr() guard.
   */
  markBodiesUnfetchable(ids: string[]): void {
    this.ensureInitialized();
    if (ids.length === 0) return;
    const stmt = this.db!.prepare(
      "UPDATE emails SET tags = tags || 'nobody|' WHERE id = ? AND instr(tags, '|nobody|') = 0",
    );
    const txn = this.db!.transaction((rows: string[]) => {
      for (const id of rows) stmt.run(id);
    });
    txn(ids);
  }

  /**
   * Drop every `|nobody|` marker, putting those rows back in the prefetch
   * backlog. Called once per app start: the marker is a CACHED VERDICT, and a
   * verdict reached during a bad IMAP session (connection flapping, rate limit,
   * expired token) is simply wrong — the mail is on the server and its body
   * would download fine on a healthy connection. Without this reset a single bad
   * session left mail permanently body-less, with no way back short of editing
   * the DB. Genuinely-expunged UIDs just fail again and get re-marked, which
   * costs one attempt per launch.
   *
   * Returns how many rows were cleared, so the caller can log a real number.
   */
  clearBodiesUnfetchable(): number {
    this.ensureInitialized();
    const info = this.db!
      .prepare("UPDATE emails SET tags = replace(tags, '|nobody|', '|') WHERE instr(tags, '|nobody|') > 0")
      .run();
    return info.changes ?? 0;
  }

  /**
   * Newest emails still missing a body, skipping the first `offset` of them.
   *
   * The offset is what lets the prefetch scheduler get UNSTUCK. Seeds are
   * newest-first, so when the head of that list can't be downloaded (a server
   * throttling FETCH, a message that keeps timing out) an offset-less query
   * hands back the exact same rows every tick and the thousands behind them are
   * never even attempted. Rotating past a starved window keeps the backlog
   * draining while the head is retried later.
   */
  getSeedEmailIdsWithoutBody(limit: number = 200, offset: number = 0): string[] {
    this.ensureInitialized();
    const rows = this.db!.prepare(`
      SELECT id FROM emails
      WHERE ${this.missingBody()}
        AND instr(tags, '|Spam|') = 0
        AND instr(tags, '|Junk|') = 0
        AND instr(tags, '|Trash|') = 0
        AND instr(tags, '|[Gmail]/Spam|') = 0
        AND instr(tags, '|[Gmail]/Trash|') = 0
        AND instr(tags, '|Junk Email|') = 0
        AND instr(tags, '|Deleted Items|') = 0
        AND instr(tags, '|nobody|') = 0
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `).all(limit, Math.max(0, offset)) as { id: string }[];
    return rows.map(r => r.id);
  }

  /**
   * Given a list of seed email IDs, return all OTHER emails in those
   * same threads that are still missing a body (regardless of read
   * state — older messages in a needs-response thread are usually
   * already read but still required for conversation extraction).
   *
   * Used by the body-prefetch scheduler so a thread with one fresh
   * unread + four older-read messages gets the WHOLE thread fetched,
   * not just the unread one. Without this, conversation Phase 1 sees
   * an empty body for older quoted messages and falls back to a
   * partial cache forever.
   *
   * Trash/Spam/Junk are still excluded — there's no point pulling a
   * thread's deleted siblings down. Returns an array deduped against
   * the seed set so the caller can concat without duplicates.
   */
  getThreadSiblingsWithoutBody(seedEmailIds: string[], limit: number = 200): string[] {
    this.ensureInitialized();
    if (seedEmailIds.length === 0) return [];
    const seedSet = new Set(seedEmailIds);

    // 1. Collect every thread_id the seeds belong to.
    const threadIdRows = this.db!.prepare(
      `SELECT DISTINCT thread_id FROM emails WHERE id IN (${seedEmailIds.map(() => '?').join(',')}) AND thread_id IS NOT NULL`
    ).all(...seedEmailIds) as { thread_id: string }[];
    const threadIds = threadIdRows.map(r => r.thread_id).filter(Boolean);
    if (threadIds.length === 0) return [];

    // 2. Pull every email in those threads that's missing a body and
    //    isn't in a Trash/Spam tag bucket.
    const placeholders = threadIds.map(() => '?').join(',');
    const rows = this.db!.prepare(`
      SELECT id FROM emails
      WHERE thread_id IN (${placeholders})
        AND ${this.missingBody()}
        AND instr(tags, '|Spam|') = 0
        AND instr(tags, '|Junk|') = 0
        AND instr(tags, '|Trash|') = 0
        AND instr(tags, '|[Gmail]/Spam|') = 0
        AND instr(tags, '|[Gmail]/Trash|') = 0
        AND instr(tags, '|Junk Email|') = 0
        AND instr(tags, '|Deleted Items|') = 0
        AND instr(tags, '|nobody|') = 0
      ORDER BY date DESC
      LIMIT ?
    `).all(...threadIds, limit) as { id: string }[];

    // 3. Drop seeds — caller already has those.
    return rows.map(r => r.id).filter(id => !seedSet.has(id));
  }

  // ========== Signature Pattern Operations ==========

  async saveSignaturePattern(pattern: { email: string; htmlSelector: string; sampleHtml?: string; emailId?: string; confidence: 'high' | 'medium' | 'low' }): Promise<SignaturePattern> {
    this.ensureInitialized();
    return this.contactRepo.saveSignaturePattern(pattern);
  }

  async getSignaturePatternByEmail(email: string): Promise<SignaturePattern | null> {
    this.ensureInitialized();
    return this.contactRepo.getSignaturePatternByEmail(email);
  }

  async getSignaturePatternBySelector(selector: string): Promise<SignaturePattern | null> {
    this.ensureInitialized();
    const patterns = await this.contactRepo.getSignaturePatterns();
    return patterns.find(p => p.htmlSelector === selector) || null;
  }

  async getSignaturePatterns(options?: { limit?: number; offset?: number }): Promise<SignaturePattern[]> {
    this.ensureInitialized();
    return this.contactRepo.getSignaturePatterns(options);
  }

  async getSignaturePatternsCount(): Promise<number> {
    this.ensureInitialized();
    const patterns = await this.contactRepo.getSignaturePatterns();
    return patterns.length;
  }

  async deleteSignaturePattern(id: string): Promise<void> {
    this.ensureInitialized();
    return this.contactRepo.deleteSignaturePattern(id);
  }

  async deleteSignaturePatternByEmail(email: string): Promise<void> {
    this.ensureInitialized();
    const pattern = await this.contactRepo.getSignaturePatternByEmail(email);
    if (pattern) {
      return this.contactRepo.deleteSignaturePattern(pattern.id);
    }
  }

  async clearSignaturePatterns(): Promise<void> {
    this.ensureInitialized();
    this.db!.exec('DELETE FROM signature_patterns');
  }

  // ========== Snooze Operations (tags-based) ==========

  async snoozeEmail(emailId: string, snoozeUntil: number): Promise<SnoozedEmail> {
    this.ensureInitialized();
    const { addTag, removeTag } = require('./repositories/email-repository');
    const email = await this.getEmail(emailId);
    if (!email) throw new Error(`Email not found: ${emailId}`);

    const originalTags = email.tags;
    let newTags = addTag(email.tags, 'snoozed');
    newTags = removeTag(newTags, 'was_snoozed');

    await this.emailRepo.update(emailId, {
      tags: newTags,
      snoozeUntil,
      snoozeOriginalTags: originalTags,
    } as any);

    return {
      id: `snooze-${emailId}`,
      emailId,
      threadId: email.threadId,
      snoozeUntil,
      originalFolderId: email.folderId,
      originalTags: email.tags || '||',
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  async unsnoozeEmail(emailId: string, markUnread: boolean = true): Promise<void> {
    this.ensureInitialized();
    const { removeTag, addTag } = require('./repositories/email-repository');
    const email = await this.getEmail(emailId);
    if (!email) return;

    let tags = removeTag(email.tags, 'snoozed');
    tags = addTag(tags, 'was_snoozed');
    if (markUnread) {
      tags = removeTag(tags, 'read');
    }

    await this.emailRepo.update(emailId, {
      tags,
      snoozeUntil: null,
      snoozeOriginalTags: null,
    } as any);
  }

  /**
   * The Snoozed listing, as snooze records — one per snoozed MESSAGE, but drawn
   * from a page of CONVERSATIONS (see {@link EmailRepository.getSnoozed}), so
   * `limit` is a number of conversations and matches what `getSnoozedCount`
   * returns. The caller used to take the repository's default silently, which
   * made an unpaginated view quietly stop at 100 messages.
   */
  async getSnoozedEmails(options: { limit?: number; offset?: number } = {}): Promise<SnoozedEmail[]> {
    this.ensureInitialized();
    const emails = await this.emailRepo.getSnoozed(options);
    return emails.map(e => ({
      id: `snooze-${e.id}`,
      emailId: e.id,
      threadId: e.threadId,
      snoozeUntil: e.snoozeUntil!,
      originalFolderId: e.folderId,
      originalTags: e.tags || '||',
      createdAt: e.createdAt,
    }));
  }

  async getDueSnoozedEmails(): Promise<SnoozedEmail[]> {
    this.ensureInitialized();
    const emails = await this.emailRepo.getDueSnoozed();
    return emails.map(e => ({
      id: `snooze-${e.id}`,
      emailId: e.id,
      threadId: e.threadId,
      snoozeUntil: e.snoozeUntil!,
      originalFolderId: e.folderId,
      originalTags: e.tags || '||',
      createdAt: e.createdAt,
    }));
  }

  async getSnoozeRecord(emailId: string): Promise<SnoozedEmail | null> {
    this.ensureInitialized();
    const email = await this.getEmail(emailId);
    if (!email || !email.snoozeUntil) return null;
    return {
      id: `snooze-${emailId}`,
      emailId,
      threadId: email.threadId,
      snoozeUntil: email.snoozeUntil,
      originalFolderId: email.folderId,
      originalTags: email.tags || '||',
      createdAt: email.createdAt,
    };
  }

  async getSnoozedCount(): Promise<number> {
    this.ensureInitialized();
    return this.emailRepo.getSnoozedCount();
  }

  // ========== AI Categories ==========

  async upsertEmailAICategory(category: EmailAICategory): Promise<void> {
    this.ensureInitialized();
    return this.aiRepo.upsertCategory(category);
  }

  async getEmailAICategory(emailId: string): Promise<EmailAICategory | null> {
    this.ensureInitialized();
    return this.aiRepo.getCategory(emailId);
  }

  async removeEmailAICategory(emailId: string): Promise<void> {
    this.ensureInitialized();
    return this.aiRepo.removeCategory(emailId);
  }

  async getEmailsByAICategory(categoryColumn: string, options: { limit?: number; offset?: number } = {}): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.aiRepo.getEmailsByCategory(categoryColumn, options);
  }

  async getAICategoryCounts(): Promise<AICategoryCounts> {
    this.ensureInitialized();
    return this.aiRepo.getCategoryCounts();
  }

  async getEmailsWithoutAICategory(limit: number = 100): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.aiRepo.getEmailsWithoutCategory(limit);
  }

  async deleteEmailAICategory(emailId: string): Promise<void> {
    return this.removeEmailAICategory(emailId);
  }

  // ========== Dynamic Category Definitions ==========

  getCategoryDefinitions(): CategoryDefinition[] {
    this.ensureInitialized();
    return this.aiRepo.getCategoryDefinitions();
  }

  getEnabledCategoryDefinitions(): CategoryDefinition[] {
    this.ensureInitialized();
    return this.aiRepo.getEnabledCategoryDefinitions();
  }

  upsertCategoryDefinition(def: Partial<CategoryDefinition> & { slug: string }): void {
    this.ensureInitialized();
    this.aiRepo.upsertCategoryDefinition(def);
    // Adding a category whose slug retroactively matches existing tags changes
    // has_category derivation without touching any email row (no trigger fires),
    // so enqueue affected threads explicitly.
    this.dirtyThreadsForCategorySlug(def.slug);
  }

  deleteCategoryDefinition(slug: string): boolean {
    this.ensureInitialized();
    const result = this.aiRepo.deleteCategoryDefinition(slug);
    // Deletion leaves the stale |slug| in email tags but drops it from the
    // definitions, so affected threads become "unlabelled" — re-dirty them.
    this.dirtyThreadsForCategorySlug(slug);
    return result;
  }

  /**
   * Enqueue every thread carrying `|slug|` for a read-model rebuild. Category
   * definition edits change what `has_category` derives to (the rollup counts
   * ALL defined slugs) without changing any `emails` row, so the emails triggers
   * never see them — this closes that gap. Best-effort; the periodic drain still
   * converges if it throws.
   */
  private dirtyThreadsForCategorySlug(slug: string): void {
    if (!this.db || !slug) return;
    try {
      this.db.prepare(
        "INSERT OR IGNORE INTO read_model_dirty(thread_id) SELECT DISTINCT thread_id FROM emails WHERE instr(tags, '|' || ? || '|') > 0",
      ).run(slug);
      this.readModel?.schedule();
    } catch (error) {
      log.warn(`[Storage] Failed to enqueue threads for category '${slug}':`, error);
    }
  }

  toggleCategoryDefinition(slug: string, enabled: boolean): void {
    this.ensureInitialized();
    return this.aiRepo.toggleCategoryDefinition(slug, enabled);
  }

  saveEmailCategories(
    emailId: string,
    categories: { slug: string; confidence: number }[],
    isSpam: boolean,
    reasoning: string,
    processedAt: number,
    confidence: number,
  ): void {
    this.ensureInitialized();
    return this.aiRepo.saveEmailCategories(emailId, categories, isSpam, reasoning, processedAt, confidence);
  }

  saveEmailCategoriesBatch(batch: Array<{
    emailId: string;
    categories: { slug: string; confidence: number }[];
    isSpam: boolean;
    reasoning: string;
    processedAt: number;
    confidence: number;
  }>): number {
    this.ensureInitialized();
    return this.aiRepo.saveEmailCategoriesBatch(batch);
  }

  async getEmailsByDynamicCategory(categorySlug: string, options: { limit?: number; offset?: number; folderId?: string } = {}): Promise<EmailRecord[]> {
    this.ensureInitialized();
    return this.aiRepo.getEmailsByDynamicCategory(categorySlug, options);
  }

  getDynamicCategoryCounts(folderId?: string, mode: 'unread' | 'total' = 'unread'): DynamicCategoryCounts {
    this.ensureInitialized();
    return this.aiRepo.getDynamicCategoryCounts(folderId, mode);
  }

  getEmailCategoriesBatch(emailIds: string[]): Record<string, string[]> {
    this.ensureInitialized();
    return this.aiRepo.getEmailCategoriesBatch(emailIds);
  }

  // ========== Spammers Management ==========

  async addSpammer(spammer: SpammerRecord): Promise<void> {
    this.ensureInitialized();
    return this.aiRepo.addSpammer(spammer);
  }

  async removeSpammer(email: string): Promise<void> {
    this.ensureInitialized();
    return this.aiRepo.removeSpammer(email);
  }

  async isSpammer(email: string): Promise<boolean> {
    this.ensureInitialized();
    return this.aiRepo.isSpammer(email);
  }

  // ========== Remote-image sender allowlist ==========

  async allowSenderImages(email: string): Promise<void> {
    this.ensureInitialized();
    const addr = (email || '').trim().toLowerCase();
    if (!addr) return;
    this.db!.prepare('INSERT OR IGNORE INTO image_allowed_senders (email) VALUES (?)').run(addr);
  }

  async getImageAllowedSenders(): Promise<string[]> {
    this.ensureInitialized();
    const rows = this.db!.prepare('SELECT email FROM image_allowed_senders').all() as Array<{ email: string }>;
    return rows.map((r) => r.email);
  }

  async isSpammerDomain(domain: string): Promise<boolean> {
    this.ensureInitialized();
    return this.aiRepo.isSpammerDomain(domain);
  }

  async getSpammers(options: { limit?: number; offset?: number; search?: string } = {}): Promise<SpammerRecord[]> {
    this.ensureInitialized();
    return this.aiRepo.getSpammers(options);
  }

  async getSpammerCount(search?: string): Promise<number> {
    this.ensureInitialized();
    return this.aiRepo.getSpammerCount(search);
  }

  // ========== Thread Summaries ==========

  async upsertThreadSummary(summary: ThreadSummaryRecord): Promise<void> {
    this.ensureInitialized();
    return this.aiRepo.upsertSummary(summary);
  }

  async getThreadSummary(threadId: string): Promise<ThreadSummaryRecord | null> {
    this.ensureInitialized();
    return this.aiRepo.getSummary(threadId);
  }

  async deleteThreadSummary(threadId: string): Promise<void> {
    this.ensureInitialized();
    return this.aiRepo.deleteSummary(threadId);
  }

  // ========== Conversation Extractions ==========

  async upsertConversation(record: ConversationExtractionRecord): Promise<void> {
    this.ensureInitialized();
    return this.aiRepo.upsertConversation(record);
  }

  async getConversation(threadId: string): Promise<ConversationExtractionRecord | null> {
    this.ensureInitialized();
    return this.aiRepo.getConversation(threadId);
  }

  async deleteConversation(threadId: string): Promise<void> {
    this.ensureInitialized();
    return this.aiRepo.deleteConversation(threadId);
  }

  async clearAllConversations(): Promise<number> {
    this.ensureInitialized();
    return this.aiRepo.clearAllConversations();
  }

  async getUnprocessedEmailCount(limit: number = 10000, skipRead: boolean = false): Promise<number> {
    this.ensureInitialized();
    return this.aiRepo.getUnprocessedEmailCount(limit, skipRead);
  }

  upsertCategoryBatch(categories: Array<{
    emailId: string;
    isImportant: boolean | number;
    isSpam: boolean | number;
    isReminder: boolean | number;
    isWaitingReply: boolean | number;
    isNeedsResponse: boolean | number;
    isMeetingRelated: boolean | number;
    isInvoiceBilling: boolean | number;
    reasoning?: string | null;
    confidence: number;
    processedAt: number;
  }>): number {
    this.ensureInitialized();
    return this.aiRepo.upsertCategoryBatch(categories);
  }

  getEligibleEmailsForAI(limit: number = 100, skipRead: boolean = true): import('@sarvinbox/core').EmailRecord[] {
    this.ensureInitialized();
    return this.aiRepo.getEligibleEmailsForAI(limit, skipRead);
  }

  incrementParseFailureCount(emailId: string): number {
    this.ensureInitialized();
    return this.aiRepo.incrementParseFailureCount(emailId);
  }

  resetParseFailureCount(emailId: string): void {
    this.ensureInitialized();
    this.aiRepo.resetParseFailureCount(emailId);
  }

  getParseFailureCounts(maxRetries: number): { pendingRetry: number; givenUp: number } {
    this.ensureInitialized();
    return this.aiRepo.getParseFailureCounts(maxRetries);
  }

  getChatViewBodyForEmail(threadId: string, emailId: string): string | null {
    this.ensureInitialized();
    return this.aiRepo.getChatViewBodyForEmail(threadId, emailId);
  }

  // ========== Pending Operations ==========

  async savePendingOperation(op: { type: string; folderPath: string; uid: number; data?: any; retryCount: number }): Promise<number> {
    this.ensureInitialized();
    const result = this.db!.prepare(`
      INSERT OR REPLACE INTO pending_operations (type, folder_path, uid, data, status, retry_count)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(op.type, op.folderPath, op.uid, op.data ? JSON.stringify(op.data) : null, op.retryCount);
    return Number(result.lastInsertRowid);
  }

  async savePendingOperationsBatch(ops: Array<{ type: string; folderPath: string; uid: number; data?: any; retryCount: number }>): Promise<number[]> {
    this.ensureInitialized();
    const ids: number[] = [];
    const insert = this.db!.prepare(`
      INSERT OR REPLACE INTO pending_operations (type, folder_path, uid, data, status, retry_count)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `);
    const transaction = this.db!.transaction((items: Array<{ type: string; folderPath: string; uid: number; data?: any; retryCount: number }>) => {
      for (const op of items) {
        const result = insert.run(op.type, op.folderPath, op.uid, op.data ? JSON.stringify(op.data) : null, op.retryCount);
        ids.push(Number(result.lastInsertRowid));
      }
    });
    transaction(ops);
    return ids;
  }

  async getPendingOperations(): Promise<Array<{ id: number; type: string; folderPath: string; uid: number; data: any; status: string; retryCount: number; createdAt: number }>> {
    this.ensureInitialized();
    // Exclude dead-lettered ('failed') rows — those are surfaced/retried
    // explicitly and must not be auto-reloaded into the live queue on startup.
    const rows = this.db!.prepare("SELECT * FROM pending_operations WHERE status != 'failed' ORDER BY created_at ASC").all() as any[];
    return rows.map(row => ({
      id: row.id,
      type: row.type,
      folderPath: row.folder_path,
      uid: row.uid,
      data: row.data ? JSON.parse(row.data) : null,
      status: row.status || 'pending',
      retryCount: row.retry_count,
      createdAt: row.created_at,
    }));
  }

  async getPendingOperationUidsByFolder(folderPath: string): Promise<number[]> {
    this.ensureInitialized();
    // Only IN-FLIGHT ops (pending/executing) protect the local optimistic change
    // from the server-wins syncFlags reconciliation. A DEAD-LETTERED ('failed')
    // op has permanently failed to reach the server, so its optimistic value is a
    // lie — dropping it from the guard lets syncFlags revert the row to the
    // server's truth (e.g. a markRead that never round-tripped springs back to
    // unread). This is the "only stays read if the server accepted it" rule.
    // (Transient failures now RE-QUEUE as 'pending' — see isConnectionError — so
    // this fires only on genuine terminal failure. A user Retry re-arms the op to
    // 'pending', re-protecting it.)
    const rows = this.db!.prepare(
      "SELECT DISTINCT uid FROM pending_operations WHERE folder_path = ? AND status IN ('pending','executing') AND uid > 0"
    ).all(folderPath) as Array<{ uid: number }>;
    return rows.map(row => row.uid);
  }

  async updatePendingOperationStatus(id: number, status: string): Promise<void> {
    this.ensureInitialized();
    this.db!.prepare('UPDATE pending_operations SET status = ? WHERE id = ?').run(status, id);
  }

  async updatePendingOperationRetry(id: number, retryCount: number): Promise<void> {
    this.ensureInitialized();
    this.db!.prepare('UPDATE pending_operations SET retry_count = ? WHERE id = ?').run(retryCount, id);
  }

  async deletePendingOperation(id: number): Promise<void> {
    this.ensureInitialized();
    this.db!.prepare('DELETE FROM pending_operations WHERE id = ?').run(id);
  }

  async deletePendingOperationsBatch(ids: number[]): Promise<void> {
    this.ensureInitialized();
    if (ids.length === 0) return;
    const del = this.db!.prepare('DELETE FROM pending_operations WHERE id = ?');
    const transaction = this.db!.transaction((ids: number[]) => {
      for (const id of ids) {
        del.run(id);
      }
    });
    transaction(ids);
  }

  async deleteFailedOperations(): Promise<number> {
    this.ensureInitialized();
    const info = this.db!.prepare("DELETE FROM pending_operations WHERE status = 'failed'").run();
    return info.changes;
  }

  async clearPendingOperations(): Promise<void> {
    this.ensureInitialized();
    this.db!.exec('DELETE FROM pending_operations');
  }

  // ---- Dead-letter (failed) operations ----

  async markPendingOperationFailed(
    id: number,
    lastError: string,
    detail?: { attemptedCommand?: string; serverResponse?: string },
  ): Promise<void> {
    this.ensureInitialized();
    this.db!.prepare(
      "UPDATE pending_operations SET status = 'failed', last_error = ?, attempted_command = ?, server_response = ? WHERE id = ?"
    ).run(lastError, detail?.attemptedCommand ?? null, detail?.serverResponse ?? null, id);
  }

  // Cap the dead-letter list so a pathological pile-up can't bloat the settings
  // pane / IPC payload. The true total is available via getQueueStats().failed.
  async getFailedOperations(limit = 200): Promise<Array<{ id: number; type: string; folderPath: string; uid: number; data: any; status: string; retryCount: number; lastError: string | null; attemptedCommand: string | null; serverResponse: string | null; nextRetryAt: number | null; createdAt: number }>> {
    this.ensureInitialized();
    const rows = this.db!.prepare("SELECT * FROM pending_operations WHERE status = 'failed' ORDER BY created_at DESC LIMIT ?").all(limit) as any[];
    return rows.map(row => ({
      id: row.id,
      type: row.type,
      folderPath: row.folder_path,
      uid: row.uid,
      data: row.data ? JSON.parse(row.data) : null,
      status: row.status,
      retryCount: row.retry_count,
      lastError: row.last_error ?? null,
      attemptedCommand: row.attempted_command ?? null,
      serverResponse: row.server_response ?? null,
      nextRetryAt: row.next_retry_at ?? null,
      createdAt: row.created_at,
    }));
  }

  async resetFailedOperation(id: number): Promise<void> {
    this.ensureInitialized();
    this.db!.prepare(
      "UPDATE pending_operations SET status = 'pending', retry_count = 0, next_retry_at = NULL WHERE id = ?"
    ).run(id);
  }

  async getPendingOperationCounts(): Promise<{ pending: number; failed: number }> {
    this.ensureInitialized();
    const row = this.db!.prepare(`
      SELECT
        SUM(CASE WHEN status = 'failed' THEN 0 ELSE 1 END) AS pending,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM pending_operations
    `).get() as { pending: number | null; failed: number | null };
    return { pending: row.pending ?? 0, failed: row.failed ?? 0 };
  }

  // ========== Pending Sends (Outbox) ==========

  async savePendingSend(payload: unknown, nextRetryAt?: number): Promise<number> {
    this.ensureInitialized();
    const result = this.db!.prepare(`
      INSERT INTO pending_sends (payload, status, retry_count, next_retry_at)
      VALUES (?, 'pending', 0, ?)
    `).run(JSON.stringify(payload), nextRetryAt ?? null);
    return Number(result.lastInsertRowid);
  }

  async cancelHeldSend(id: number): Promise<boolean> {
    this.ensureInitialized();
    const now = Math.floor(Date.now() / 1000);
    // Only delete a send that is STILL held for the undo window (pending + a
    // future next_retry_at). Once it's executing/failed/due, undo is too late and
    // we leave it — transmitting a mail the user tried to unsend beats losing it.
    const res = this.db!.prepare(
      `DELETE FROM pending_sends WHERE id = ? AND status = 'pending' AND next_retry_at IS NOT NULL AND next_retry_at > ?`,
    ).run(id, now);
    return res.changes > 0;
  }

  async clearSendHold(id: number): Promise<void> {
    this.ensureInitialized();
    // Release the undo-hold so the drain treats it as due now. Guarded to
    // pending+held rows so it can't disturb an executing/failed send.
    this.db!.prepare(
      `UPDATE pending_sends SET next_retry_at = NULL, updated_at = unixepoch() WHERE id = ? AND status = 'pending'`,
    ).run(id);
  }

  async getDueSends(now: number): Promise<Array<{ id: number; payload: any; status: string; retryCount: number; lastError: string | null; nextRetryAt: number | null; createdAt: number; updatedAt: number }>> {
    this.ensureInitialized();
    const rows = this.db!.prepare(`
      SELECT * FROM pending_sends
      WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC
    `).all(now) as any[];
    return rows.map(row => this.mapPendingSend(row));
  }

  async getAllSends(): Promise<Array<{ id: number; payload: any; status: string; retryCount: number; lastError: string | null; nextRetryAt: number | null; createdAt: number; updatedAt: number }>> {
    this.ensureInitialized();
    const rows = this.db!.prepare('SELECT * FROM pending_sends ORDER BY created_at ASC').all() as any[];
    return rows.map(row => this.mapPendingSend(row));
  }

  private mapPendingSend(row: any) {
    return {
      id: row.id,
      payload: row.payload ? JSON.parse(row.payload) : null,
      status: row.status || 'pending',
      retryCount: row.retry_count,
      lastError: row.last_error ?? null,
      nextRetryAt: row.next_retry_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      smtpAccepted: !!row.smtp_accepted,
      sentAppendPending: !!row.sent_append_pending,
      rawMime: row.raw_mime ?? null,
      messageId: row.sent_message_id ?? null,
    };
  }

  async markSendAppendPending(id: number, rawMime: string, messageId: string): Promise<void> {
    this.ensureInitialized();
    // Atomic single UPDATE: once this commits the row can never be re-sent
    // (smtp_accepted=1); it will only be appended. status='append_pending' keeps
    // it out of the normal send path (getDueSends) and the executing→pending
    // crash reset.
    this.db!.prepare(`
      UPDATE pending_sends
      SET smtp_accepted = 1,
          sent_append_pending = 1,
          raw_mime = ?,
          sent_message_id = ?,
          status = 'append_pending',
          updated_at = unixepoch()
      WHERE id = ?
    `).run(rawMime, messageId, id);
  }

  async getAppendPendingSends(): Promise<Array<{ id: number; payload: any; status: string; retryCount: number; lastError: string | null; nextRetryAt: number | null; createdAt: number; updatedAt: number; smtpAccepted?: boolean; sentAppendPending?: boolean; rawMime?: string | null; messageId?: string | null }>> {
    this.ensureInitialized();
    const rows = this.db!.prepare(
      "SELECT * FROM pending_sends WHERE sent_append_pending = 1 ORDER BY created_at ASC"
    ).all() as any[];
    return rows.map(row => this.mapPendingSend(row));
  }

  async updatePendingSendAttempt(id: number, retryCount: number, lastError: string, nextRetryAt: number): Promise<void> {
    this.ensureInitialized();
    this.db!.prepare(`
      UPDATE pending_sends
      SET status = 'pending', retry_count = ?, last_error = ?, next_retry_at = ?, updated_at = unixepoch()
      WHERE id = ?
    `).run(retryCount, lastError, nextRetryAt, id);
  }

  async updatePendingSendStatus(id: number, status: string): Promise<void> {
    this.ensureInitialized();
    this.db!.prepare('UPDATE pending_sends SET status = ?, updated_at = unixepoch() WHERE id = ?').run(status, id);
  }

  async markPendingSendFailed(id: number, lastError: string): Promise<void> {
    this.ensureInitialized();
    this.db!.prepare(
      "UPDATE pending_sends SET status = 'failed', last_error = ?, updated_at = unixepoch() WHERE id = ?"
    ).run(lastError, id);
  }

  async resetPendingSend(id: number): Promise<void> {
    this.ensureInitialized();
    this.db!.prepare(
      "UPDATE pending_sends SET status = 'pending', next_retry_at = NULL, updated_at = unixepoch() WHERE id = ?"
    ).run(id);
  }

  async deletePendingSend(id: number): Promise<void> {
    this.ensureInitialized();
    this.db!.prepare('DELETE FROM pending_sends WHERE id = ?').run(id);
  }

  async deleteFailedSends(): Promise<number> {
    this.ensureInitialized();
    const info = this.db!.prepare("DELETE FROM pending_sends WHERE status = 'failed'").run();
    return info.changes;
  }

  async clearPendingSends(): Promise<void> {
    this.ensureInitialized();
    this.db!.exec('DELETE FROM pending_sends');
  }

  async getPendingSendCounts(): Promise<{ pending: number; failed: number }> {
    this.ensureInitialized();
    const row = this.db!.prepare(`
      SELECT
        SUM(CASE WHEN status = 'failed' THEN 0 ELSE 1 END) AS pending,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM pending_sends
    `).get() as { pending: number | null; failed: number | null };
    return { pending: row.pending ?? 0, failed: row.failed ?? 0 };
  }

  // ========== Filter Rules ==========

  async getFilterRules() {
    this.ensureInitialized();
    return this.filterRepo.list();
  }

  async getEnabledFilterRules() {
    this.ensureInitialized();
    return this.filterRepo.listEnabled();
  }

  async createFilterRule(input: FilterRuleInput) {
    this.ensureInitialized();
    return this.filterRepo.create(input);
  }

  async updateFilterRule(id: string, updates: Partial<FilterRuleInput>) {
    this.ensureInitialized();
    return this.filterRepo.update(id, updates);
  }

  async deleteFilterRule(id: string) {
    this.ensureInitialized();
    this.filterRepo.delete(id);
  }

  async reorderFilterRules(orderedIds: string[]) {
    this.ensureInitialized();
    this.filterRepo.reorder(orderedIds);
  }

  // ========== Labels ==========

  async getLabels() {
    this.ensureInitialized();
    return this.labelRepo.list();
  }

  async createLabel(input: LabelInput, syncedToServer = false) {
    this.ensureInitialized();
    return this.labelRepo.create(input, syncedToServer);
  }

  async updateLabel(id: string, updates: Partial<LabelInput>) {
    this.ensureInitialized();
    return this.labelRepo.update(id, updates);
  }

  async deleteLabel(id: string) {
    this.ensureInitialized();
    this.labelRepo.delete(id);
  }

  // ========== Threading Repair ==========

  /**
   * Walk the entire emails table and reattach broken thread_ids using
   * the same resolver the insert path uses (parent lookup → references
   * chain → subject + participant fallback). Pass `dryRun: true` first
   * to see what WOULD change before committing.
   *
   * Apply path is destructive — it rewrites thread_id on affected
   * emails and rebuilds the threads table to match. Conversation
   * extraction caches keyed on the OLD thread_id will become orphans
   * (the next visit to those threads triggers re-extraction anyway).
   */
  async repairThreading(options: { dryRun: boolean } = { dryRun: true }) {
    this.ensureInitialized();
    return repairThreadingImpl(this.db!, { ...options, selfAddresses: this.selfAddresses });
  }

  // ========== Helper Methods ==========

  private rowToEmailRecord(row: any): EmailRecord {
    // Delegate to EmailRepository's rowToRecord
    return this.emailRepo.rowToRecord(row);
  }
}

// ========== Type Exports ==========

export interface SnoozedEmail {
  id: string;
  emailId: string;
  threadId: string | null;
  snoozeUntil: number;
  originalFolderId: string;
  originalTags: string;
  createdAt: number;
}

export interface SenderStats {
  id: string;
  email: string;
  domain: string;
  receivedCount: number;
  repliedCount: number;
  sentToCount: number;
  readCount: number;
  deletedCount: number;
  firstSeen: number;
  lastReceived: number | null;
  lastReplied: number | null;
  lastSentTo: number | null;
  reputationScore: number;
  isVip: boolean;
  isBlocked: boolean;
  authPassCount: number;
  authFailCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SignaturePattern {
  id: string;
  email: string;
  htmlSelector: string;
  sampleHtml: string | null;
  emailIds: string[];
  confidence: 'high' | 'medium' | 'low';
  usageCount: number;
  lastUsed: number;
  createdAt: number;
}

export interface EmailAICategory {
  id?: string;
  emailId: string;
  threadId?: string | null;
  isImportant: boolean;
  isSpam: boolean;
  isReminder: boolean;
  isWaitingReply: boolean;
  isNeedsResponse: boolean;
  isMeetingRelated: boolean;
  isInvoiceBilling: boolean;
  reasoning?: string | null;
  confidence: number;
  processedAt: number;
  modelUsed?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface SpammerRecord {
  id?: string;
  email: string;
  domain?: string | null;
  name?: string | null;
  reason?: string | null;
  reportedCount?: number;
  firstReportedAt?: number;
  lastReportedAt?: number;
  createdAt?: number;
}

export interface ThreadSummaryRecord {
  id?: string;
  threadId: string;
  summary: string;
  keyPoints: string[];
  participants: string[];
  lastEmailDate: number;
  emailCount: number;
  processedAt: number;
  modelUsed?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface ConversationExtractionRecord {
  id?: string;
  threadId: string;
  messages: string;              // JSON stringified ConversationMessage[]
  emailCount: number;
  processedEmailIds: string;     // JSON stringified string[] — tracks which emails have been processed
  processedAt: number;
  modelUsed?: string | null;
}

export interface AICategoryCounts {
  important: number;
  reminders: number;
  waitingReply: number;
  needsResponse: number;
  meeting: number;
  invoice: number;
}

/** Dynamic category counts — keyed by slug */
export type DynamicCategoryCounts = Record<string, number>;

/** Category definition record from ai_category_definitions table */
export interface CategoryDefinition {
  slug: string;
  name: string;
  description: string | null;
  prompt: string;
  icon: string;
  color: string;
  sortOrder: number;
  isSystem: boolean;
  isEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

