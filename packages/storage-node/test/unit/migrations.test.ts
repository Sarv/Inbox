import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MigrationManager,
  createMigrationManager,
  emailLabelStatus,
  financeCategory,
  fts5SearchIndex,
  reconcileLabelDrift,
  type Migration,
} from '../../src/migrations';
import { attachSharedContacts, SHARED_SCHEMA } from '../../src/shared-contacts';
import { openTestDb } from '../../src/test-support/test-db';

// The migration chain is the ONLY thing standing between an existing user's
// mailbox and a corrupt/half-upgraded database: every release runs it against
// DBs written by every previous release. These tests pin (a) that a fresh
// install lands on the full production schema, (b) that re-running the chain
// (or a single migration) never throws or duplicates data, and (c) that the
// manager's transaction/rollback mechanics leave no partially applied version
// behind — a half-applied migration is unrecoverable in the field.

/**
 * The registered chain, in the order the manager will run it. `migrations` is
 * `private` only for callers of the public API; reading it here is what lets a
 * test run a PREFIX of the chain (i.e. simulate an older DB) without having to
 * duplicate the registration list.
 */
type ManagerInternals = { migrations: Migration[] };

function registeredMigrations(): Migration[] {
  const probe = openTestDb();
  try {
    return [...(createMigrationManager(probe) as unknown as ManagerInternals).migrations];
  } finally {
    probe.close();
  }
}

const CHAIN = registeredMigrations();
const CURRENT_VERSION = Math.max(...CHAIN.map((m) => m.version));

const byVersion = (version: number): Migration => {
  const found = CHAIN.find((m) => m.version === version);
  if (!found) throw new Error(`no migration v${version}`);
  return found;
};

/** A manager carrying only part of the chain — an "app build" that is behind. */
function managerUpTo(db: Database.Database, maxVersion: number): MigrationManager {
  const manager = new MigrationManager(db);
  CHAIN.filter((m) => m.version <= maxVersion).forEach((m) => manager.register(m));
  return manager;
}

// Every inspector below takes a SCHEMA, because the mailbox is no longer the
// only database on the connection: contacts moved to the attached `shared`
// directory. Defaulting to `main` keeps the mailbox assertions unchanged, and
// an explicit `SHARED_SCHEMA` is what proves a directory table really did land
// in the directory rather than back in somebody's mailbox.
const tableNames = (db: Database.Database, schema = 'main'): Set<string> =>
  new Set(
    (
      db
        .prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type IN ('table','view')`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );

const columnsOf = (db: Database.Database, table: string, schema = 'main'): Set<string> =>
  new Set(
    (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

const objectExists = (
  db: Database.Database,
  type: string,
  name: string,
  schema = 'main',
): boolean =>
  !!db
    .prepare(`SELECT 1 AS ok FROM ${schema}.sqlite_master WHERE type = ? AND name = ?`)
    .get(type, name);

const appliedVersions = (db: Database.Database): number[] =>
  (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{
    version: number;
  }>).map((r) => r.version);

const scalar = (db: Database.Database, sql: string): unknown => {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
};

// ---------------------------------------------------------------------------

describe('fresh install reaches the current production schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    // Same order as SQLiteStorage.initialize: the directory is attached BEFORE
    // the chain runs, because v77 adopts this mailbox's contacts into it. An
    // empty path gives each test a private, anonymous directory.
    attachSharedContacts(db, '');
    createMigrationManager(db).migrate();
  });

  afterEach(() => db.close());

  // A fresh DB that stops short of the newest version means the app queries
  // columns/tables that do not exist yet — every sync throws "no such column".
  it('ends on the newest registered version and records every applied version', () => {
    expect(CURRENT_VERSION).toBe(84);
    expect(createMigrationManager(db).getCurrentVersion()).toBe(CURRENT_VERSION);
    // v24 is stamped by schema.sql itself; the chain stamps 25..84 contiguously.
    expect(appliedVersions(db)).toEqual(CHAIN.map((m) => m.version).sort((a, b) => a - b));
  });

  // Each of these tables is read by a repository on startup; a missing one is a
  // hard crash, not a degraded feature.
  it('creates every table the app reads', () => {
    const names = tableNames(db);
    for (const table of [
      'emails',
      'threads',
      'folders',
      'attachments',
      'accounts',
      'sender_stats',
      'sender_daily_metrics',
      'spammers',
      'signature_patterns',
      'pending_operations',
      'pending_sends',
      'filter_rules',
      'labels',
      'image_allowed_senders',
      'thread_summaries',
      'conversation_extractions',
      'ai_category_definitions',
      'agent_prompt_templates',
      'user_categorization_rules',
      'user_action_log',
      'agent_decisions',
      'pipeline_event_log',
      'emails_fts',
      'thread_folders',
      'thread_categories',
      'read_model_state',
      'read_model_dirty',
      // v73: bodies live here now. A DB that reached the newest version without
      // it would have every reader COALESCE against a table that does not exist,
      // which is a hard "no such table" on the first mail list.
      'email_bodies',
      'email_body_metrics_state',
      // v74: inline images live here, and the bodies hold `sarv-inline:` refs to
      // them. A DB that reached the newest version without these tables would
      // resolve every ref to nothing, so every mail with an inline image renders
      // its images broken — and the extraction pass would throw on its first
      // insert rather than fail visibly.
      'inline_images',
      'email_inline_images',
      'schema_version',
    ]) {
      expect(names, `missing table ${table}`).toContain(table);
    }
    // ...and NOT the directory's. A local `contacts` table would shadow
    // `shared.contacts` for any query that forgot its prefix, and the mailbox
    // would quietly read an empty address book.
    for (const moved of ['contacts', 'contact_notes', 'contact_enrichment_history']) {
      expect(names, `${moved} must not be re-created in the mailbox`).not.toContain(moved);
    }
  });

  // The address book is shared across accounts and lives in its own attached
  // database. If these were missing, every contact query would fail outright
  // with `no such table: shared.contacts` — the whole contacts UI, the agent's
  // sender classification and the enrichment pipeline at once.
  it('creates the shared contact directory tables', () => {
    const names = tableNames(db, SHARED_SCHEMA);
    for (const table of [
      'contacts',
      'contact_notes',
      'contact_enrichment_history',
      // v77 provenance: which mailbox each address was actually seen in. The
      // union is only maintainable while the parts are still known.
      'contact_accounts',
    ]) {
      expect(names, `missing directory table ${table}`).toContain(table);
    }
  });

  // These columns are all ADDED by later migrations. Asserting the real column
  // set (not "the migration ran") is what catches schema.sql and the migration
  // chain drifting apart — the drift only shows up as a runtime SQL error.
  it('carries the columns later migrations add to emails/threads/folders', () => {
    const emails = columnsOf(db, 'emails');
    for (const col of [
      'extraction_status',
      'extraction_at',
      'agent_status',
      'agent_at',
      'priority_score',
      'priority_tier',
      'priority_reasoning',
      'recommended_action',
      'ai_parse_failure_count',
      'attachment_sizes',
      'calendar_ics',
      'calendar_added',
      'label_status',
    ]) {
      expect(emails, `emails.${col}`).toContain(col);
    }

    const threads = columnsOf(db, 'threads');
    for (const col of [
      'chat_extracted_at',
      'chat_email_count',
      'has_important',
      'has_important_unread',
      'has_attachment',
      'has_draft',
      'has_category',
      'max_priority_score',
      'first_sender',
      'last_sender',
      'live_message_count',
      'state_version',
    ]) {
      expect(threads, `threads.${col}`).toContain(col);
    }

    const folders = columnsOf(db, 'folders');
    for (const col of ['uid_validity', 'highest_modseq', 'backfill_oldest_uid', 'backfill_complete']) {
      expect(folders, `folders.${col}`).toContain(col);
    }
  });

  it('carries the columns later migrations add to contacts/sender_stats/queues', () => {
    // The directory schema is written out in full rather than replayed from the
    // per-account chain, so this is what keeps the two from drifting: a column
    // added to `contacts` by a migration but forgotten in `directorySchema`
    // fails here instead of at runtime.
    const contacts = columnsOf(db, 'contacts', SHARED_SCHEMA);
    for (const col of [
      'contact_type',
      'contact_type_confidence',
      'contact_type_source',
      'company',
      'last_inbound_at',
      'last_outbound_at',
      'avg_response_time_sec',
      'thread_count',
      'needs_response',
      'kind',
      'person_id',
      'company_contact_id',
      'mobile_e164',
      'enrichment',
      'enriched_through_email_at',
      'enrichment_source',
      'phones_mined_through',
      'phones_mined',
      'avatar_status',
      'avatar_checked_at',
    ]) {
      expect(contacts, `contacts.${col}`).toContain(col);
    }

    const senderStats = columnsOf(db, 'sender_stats');
    for (const col of [
      'contact_type',
      'greeting',
      'closing',
      'tone',
      'key_context',
      'memory_updated_at',
      'signature_marker',
      'signature_marker_updated_at',
    ]) {
      expect(senderStats, `sender_stats.${col}`).toContain(col);
    }

    const ops = columnsOf(db, 'pending_operations');
    for (const col of ['status', 'last_error', 'next_retry_at', 'attempted_command', 'server_response']) {
      expect(ops, `pending_operations.${col}`).toContain(col);
    }

    const sends = columnsOf(db, 'pending_sends');
    for (const col of ['smtp_accepted', 'sent_append_pending', 'raw_mime', 'sent_message_id']) {
      expect(sends, `pending_sends.${col}`).toContain(col);
    }

    expect(columnsOf(db, 'labels')).toContain('synced_to_server');
    expect(columnsOf(db, 'agent_decisions')).toContain('draft_body');
  });

  // Without these the app still "works" but every list query degrades to a full
  // table scan (the label drain and folder listing are the hot paths).
  it('creates the hot-path indexes and the read-model / FTS triggers', () => {
    for (const index of [
      'idx_emails_label_status',
      'idx_emails_in_reply_to',
      'idx_pending_ops_unique',
      'idx_tf_list',
      'idx_tf_unread',
      'idx_tc_slug',
      'idx_threads_chat_extraction',
      // Every sender lookup in the app is case-folded, so the plain
      // `from_address` index cannot serve any of them. Without this expression
      // index the contact-enrichment join scans all of `emails` per contact —
      // measured at 2.2s of blocked main thread on a 26k mailbox.
      'idx_emails_from_lower_date',
    ]) {
      expect(objectExists(db, 'index', index), `missing index ${index}`).toBe(true);
    }
    // Contact indexes moved with the table: they are only useful where the rows
    // actually are, and a leftover copy in the mailbox would index nothing.
    for (const index of [
      'idx_contacts_type',
      'idx_contacts_needs_response',
      'idx_contacts_last_inbound',
      'idx_contacts_kind',
      'idx_contacts_mobile',
      'idx_contact_notes_email',
      'idx_enrichment_history_contact',
    ]) {
      expect(
        objectExists(db, 'index', index, SHARED_SCHEMA),
        `missing directory index ${index}`,
      ).toBe(true);
      expect(objectExists(db, 'index', index), `${index} must not linger in the mailbox`).toBe(
        false,
      );
    }
    for (const trigger of [
      'emails_fts_insert',
      'emails_fts_delete',
      'emails_fts_update',
      'trg_emails_rm_dirty_insert',
      'trg_emails_rm_dirty_update',
      'trg_emails_rm_dirty_delete',
    ]) {
      expect(objectExists(db, 'trigger', trigger), `missing trigger ${trigger}`).toBe(true);
    }
  });

  // The category rows ARE the AI classifier's taxonomy: a missing/duplicated
  // slug silently changes how every incoming mail is categorized.
  it('seeds the AI category taxonomy exactly once, with the v33/v35/v36 edits applied', () => {
    const slugs = (
      db.prepare('SELECT slug FROM ai_category_definitions ORDER BY slug').all() as Array<{
        slug: string;
      }>
    ).map((r) => r.slug);
    expect(slugs).toEqual([
      'finance',
      'important',
      'invoice',
      'meeting',
      'needs_response',
      'promotions',
      'reminders',
    ]);
    // v35 removed waiting_reply (it overlapped needs_response).
    expect(slugs).not.toContain('waiting_reply');

    const invoice = db
      .prepare('SELECT description, prompt FROM ai_category_definitions WHERE slug = ?')
      .get('invoice') as { description: string; prompt: string };
    // v33 narrowed invoice so bank/card alerts land in finance instead.
    expect(invoice.description).toBe('Invoices and bills from vendors');
    expect(invoice.prompt).toContain('NOT invoice');

    // v36 tightened needs_response so cold sales pitches stop demanding replies.
    const needsResponse = scalar(
      db,
      "SELECT prompt FROM ai_category_definitions WHERE slug = 'needs_response'",
    ) as string;
    expect(needsResponse).toContain('COLD SALES / PROMOTIONAL OUTREACH');
  });

  // Reads stay on the legacy path until the backfill marks itself complete;
  // a missing 'pending' row means the read model is never built at all.
  it('marks the read model as needing a backfill', () => {
    expect(scalar(db, "SELECT value FROM read_model_state WHERE key = 'status'")).toBe('pending');
  });
});

// ---------------------------------------------------------------------------

describe('idempotency — the chain may be re-run on every app start', () => {
  // migrate() runs on EVERY launch. If a second pass were not a no-op, launching
  // the app twice would duplicate seed rows or throw on a duplicate column.
  it('migrate() twice is a no-op and does not duplicate seed data', () => {
    const db = openTestDb();
    createMigrationManager(db).migrate();
    const categoriesAfterFirst = scalar(db, 'SELECT COUNT(*) FROM ai_category_definitions');
    const versionsAfterFirst = appliedVersions(db);

    expect(() => createMigrationManager(db).migrate()).not.toThrow();

    expect(appliedVersions(db)).toEqual(versionsAfterFirst);
    expect(scalar(db, 'SELECT COUNT(*) FROM ai_category_definitions')).toBe(categoriesAfterFirst);
    expect(scalar(db, "SELECT value FROM read_model_state WHERE key = 'status'")).toBe('pending');
    db.close();
  });

  // EVERY migration must survive a second application on its own. schema_version
  // is not enough of a guard: a column can already exist because schema.sql
  // carries the current shape, because a crash left a migration half-applied, or
  // because a DB was restored from a newer build. v34/v46/v53/v54 did a BARE
  // `ALTER TABLE ... ADD COLUMN`, which throws `duplicate column name` — and
  // since the chain aborts on the first throw, that one error froze the schema
  // at that version and every later migration never ran.
  it('re-running any single migration up() is harmless', () => {
    const throwing: Array<{ version: number; error: string }> = [];
    for (const migration of CHAIN) {
      const db = openTestDb();
      createMigrationManager(db).migrate();
      try {
        migration.up(db);
      } catch (error) {
        throwing.push({ version: migration.version, error: (error as Error).message });
      }
      db.close();
    }
    expect(throwing).toEqual([]);
  });

  // v64 doubles as the read-model backfill trigger. Re-running it must NOT knock
  // a finished backfill back to 'pending' — that would re-scan the whole mailbox.
  it('v64 does not reset a COMPLETED read-model backfill', () => {
    const db = openTestDb();
    createMigrationManager(db).migrate();
    db.prepare("UPDATE read_model_state SET value = 'complete' WHERE key = 'status'").run();

    byVersion(64).up(db);

    expect(scalar(db, "SELECT value FROM read_model_state WHERE key = 'status'")).toBe('complete');
    db.close();
  });

  // v27's backfill was a plain INSERT..SELECT, so a second application indexed
  // every email a second time and search returned each hit twice. It now skips
  // rows already in the index.
  it('v27 re-applied does NOT double-index the FTS table', () => {
    const db = openTestDb();
    createMigrationManager(db).migrate();
    insertEmail(db, { id: 'e1', subject: 'quarterly report' });
    expect(scalar(db, 'SELECT COUNT(*) FROM emails_fts')).toBe(1);

    fts5SearchIndex.up(db);

    expect(scalar(db, 'SELECT COUNT(*) FROM emails_fts')).toBe(1);
    // …and still finds the email exactly once.
    expect(scalar(db, "SELECT COUNT(*) FROM emails_fts WHERE emails_fts MATCH 'quarterly'")).toBe(1);
    db.close();
  });

  // A row that is genuinely missing from the index (written before the triggers
  // existed) still gets backfilled — the guard must not turn the backfill off.
  it('v27 backfills a row that is missing from the index', () => {
    const db = openTestDb();
    createMigrationManager(db).migrate();
    insertEmail(db, { id: 'e1', subject: 'quarterly report' });
    db.prepare('DELETE FROM emails_fts WHERE email_id = ?').run('e1');
    expect(scalar(db, 'SELECT COUNT(*) FROM emails_fts')).toBe(0);

    fts5SearchIndex.up(db);

    expect(scalar(db, 'SELECT COUNT(*) FROM emails_fts')).toBe(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------

describe('MigrationManager mechanics', () => {
  // Version 0 is the signal "this file has no schema at all"; if the missing
  // table threw instead, a brand-new DB could never be initialised.
  it('reports version 0 when schema_version is missing or empty', () => {
    const empty = openTestDb();
    expect(new MigrationManager(empty).getCurrentVersion()).toBe(0);

    empty.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
    expect(new MigrationManager(empty).getCurrentVersion()).toBe(0);
    empty.close();
  });

  // createMigrationManager registers v38 BEFORE v37. Migrations must still run
  // in version order — v37/v38 are independent, but a future pair where the
  // later one ALTERs a table the earlier one creates would break outright.
  it('runs migrations in version order regardless of registration order', () => {
    const db = openTestDb();
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER)');
    db.exec('CREATE TABLE run_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER)');

    const record = (version: number): Migration => ({
      version,
      name: `record_${version}`,
      up: (d) => d.prepare('INSERT INTO run_log (version) VALUES (?)').run(version),
    });

    const manager = new MigrationManager(db);
    // Deliberately out of order, mirroring the real registration list.
    manager.register(record(102));
    manager.register(record(100));
    manager.register(record(101));
    manager.migrate();

    expect(
      (db.prepare('SELECT version FROM run_log ORDER BY seq').all() as Array<{ version: number }>).map(
        (r) => r.version,
      ),
    ).toEqual([100, 101, 102]);
    expect(appliedVersions(db)).toEqual([100, 101, 102]);
    db.close();
  });

  // A migration that half-applies is the worst outcome: the version would be
  // stamped, so the missing half never runs again. The transaction must undo the
  // partial write AND leave the version unstamped so a fixed build can retry.
  it('rolls back a failing migration completely and does not stamp its version', () => {
    const db = openTestDb();
    createMigrationManager(db).migrate();

    const manager = new MigrationManager(db);
    manager.register({
      version: 9999,
      name: 'writes_then_throws',
      up: (d) => {
        d.prepare("INSERT INTO labels (id, name) VALUES ('l1', 'half-applied')").run();
        throw new Error('boom');
      },
    });

    expect(() => manager.migrate()).toThrow(/boom/);

    expect(scalar(db, 'SELECT COUNT(*) FROM labels')).toBe(0);
    expect(appliedVersions(db)).not.toContain(9999);
    expect(manager.getCurrentVersion()).toBe(CURRENT_VERSION);
    db.close();
  });

  // rollback() is how a downgrade recovers; it must undo NEWEST-first (a down()
  // depending on a newer table would fail otherwise) and un-stamp the versions
  // so the next upgrade re-applies them.
  it('rollback() runs down() newest-first and deletes the version rows', () => {
    const db = openTestDb();
    const manager = createMigrationManager(db);
    manager.migrate();
    expect(objectExists(db, 'index', 'idx_emails_label_status')).toBe(true);

    manager.rollback(59);

    expect(manager.getCurrentVersion()).toBe(59);
    expect(appliedVersions(db).filter((v) => v > 59)).toEqual([]);
    // v60's down drops the partial index it created.
    expect(objectExists(db, 'index', 'idx_emails_label_status')).toBe(false);
    db.close();
  });

  // A no-op guard: rolling "back" to the current (or a newer) version must not
  // run any down() — otherwise a stale caller could destroy live tables.
  it('rollback() to the current version or newer does nothing', () => {
    const db = openTestDb();
    const manager = createMigrationManager(db);
    manager.migrate();

    manager.rollback(CURRENT_VERSION);
    manager.rollback(CURRENT_VERSION + 10);

    expect(manager.getCurrentVersion()).toBe(CURRENT_VERSION);
    expect(tableNames(db)).toContain('image_allowed_senders');
    db.close();
  });

  // Most migrations from v40 on are additive and define no down(). Rolling past
  // one must fail LOUDLY — and BEFORE touching the database. It used to unwind
  // migrations one at a time and throw when it reached the first one with no
  // down(), leaving the schema partly rolled back with schema_version already
  // decremented for those steps: a state no later migrate() can repair.
  it('rollback() refuses up front when any migration in range has no down()', () => {
    const db = openTestDb();
    const manager = createMigrationManager(db);
    manager.migrate();
    const before = manager.getCurrentVersion();

    expect(() => manager.rollback(58)).toThrow(/Cannot roll back to 58/);
    // Nothing was unwound — the schema is exactly as it was.
    expect(manager.getCurrentVersion()).toBe(before);
    expect(scalar(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='emails'")).toBe(1);
    db.close();
  });

  // Rolls the early chain all the way back to the v24 baseline: exercises the
  // down() of every migration that has one, and proves they drop what they added.
  it('rollback() of the v25..v39 range removes the objects those migrations created', () => {
    const db = openTestDb();
    const manager = managerUpTo(db, 39);
    manager.migrate();
    expect(manager.getCurrentVersion()).toBe(39);

    manager.rollback(24);

    expect(manager.getCurrentVersion()).toBe(24);
    const names = tableNames(db);
    expect(names).not.toContain('emails_fts');
    expect(names).not.toContain('contact_notes');
    expect(names).not.toContain('user_action_log');
    expect(names).not.toContain('agent_decisions');
    expect(names).not.toContain('agent_prompt_templates');
    expect(names).not.toContain('user_categorization_rules');
    expect(names).not.toContain('contact_enrichment_history');
    expect(objectExists(db, 'trigger', 'emails_fts_update')).toBe(false);
    expect(objectExists(db, 'index', 'idx_contacts_type')).toBe(false);
    // v33/v36 downs delete the category rows they seeded.
    expect(scalar(db, "SELECT COUNT(*) FROM ai_category_definitions WHERE slug = 'finance'")).toBe(0);
    expect(scalar(db, "SELECT COUNT(*) FROM ai_category_definitions WHERE slug = 'promotions'")).toBe(0);
    // The core tables (and the user's mail) survive a rollback to the baseline.
    expect(names).toContain('emails');
    expect(names).toContain('threads');
    db.close();
  });

  // Current behaviour, pinned so it is a deliberate choice and not a surprise in
  // the field: v24's down() drops schema_version, so the manager's own
  // `DELETE FROM schema_version` then fails and the whole rollback aborts —
  // rolling back to 0 is not supported.
  it('rollback() to 0 fails because v24.down drops schema_version itself', () => {
    const db = openTestDb();
    const manager = managerUpTo(db, 24);
    manager.migrate();

    expect(() => manager.rollback(0)).toThrow(/schema_version/);

    // The aborted transaction left the baseline schema intact.
    expect(tableNames(db)).toContain('emails');
    expect(manager.getCurrentVersion()).toBe(24);
    db.close();
  });
});

// ---------------------------------------------------------------------------

let emailSeq = 0;

/** Minimal but schema-valid email insert (NOT NULL columns only). */
function insertEmail(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    subject: string;
    tags: string;
    agentStatus: string | null;
    labelStatus: string | null;
    date: number;
    cleanBody: string;
  }> = {},
): string {
  const id = overrides.id ?? `e-${(emailSeq += 1)}`;
  const date = overrides.date ?? 1_700_000_000;
  // emails FKs point at folders/threads, and node:sqlite enforces them.
  db.prepare(
    `INSERT OR IGNORE INTO folders (id, name, path) VALUES ('f-inbox', 'INBOX', 'INBOX')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`t-${id}`, overrides.subject ?? 'subject', `<${id}@test>`, `<${id}@test>`, date);
  db.prepare(
    `INSERT INTO emails (id, message_id, thread_id, folder_id, tags, subject, from_address,
       date, clean_body, raw_body, content_type, content_hash, agent_status, label_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    `<${id}@test>`,
    `t-${id}`,
    'f-inbox',
    overrides.tags ?? '|INBOX|',
    overrides.subject ?? 'subject',
    'sender@example.com',
    date,
    overrides.cleanBody ?? 'body',
    'raw',
    'text',
    `hash-${id}`,
    overrides.agentStatus ?? null,
    overrides.labelStatus ?? null,
  );
  return id;
}

describe('guarded / conditional migrations run BOTH sides of their guard', () => {
  // These migrations may run against a DB whose earlier columns are missing
  // (a DB restored from another build, or a partially restructured file). They
  // must bail out cleanly instead of throwing "no such column" — a throw here
  // aborts startup for that user with no way forward.
  it('v42 contact reclassification returns early when contacts lacks person_id', () => {
    const db = openTestDb();
    db.exec("CREATE TABLE contacts (id TEXT PRIMARY KEY, email TEXT, contact_type TEXT)");
    db.prepare("INSERT INTO contacts VALUES ('c1', 'info@acme.com', 'unknown')").run();

    expect(() => byVersion(42).up(db)).not.toThrow();

    // Untouched: the migration could not run safely, so it changed nothing.
    expect(scalar(db, 'SELECT contact_type FROM contacts')).toBe('unknown');
    db.close();
  });

  it('v43/v44 requeue return early without agent_status or without agent_decisions', () => {
    const noAgentStatus = openTestDb();
    noAgentStatus.exec("CREATE TABLE emails (id TEXT PRIMARY KEY, tags TEXT)");
    noAgentStatus.prepare("INSERT INTO emails VALUES ('e1', '|INBOX|needs_response|')").run();
    expect(() => byVersion(43).up(noAgentStatus)).not.toThrow();
    expect(() => byVersion(44).up(noAgentStatus)).not.toThrow();
    noAgentStatus.close();

    const noDecisions = openTestDb();
    noDecisions.exec("CREATE TABLE emails (id TEXT PRIMARY KEY, tags TEXT, agent_status TEXT)");
    noDecisions
      .prepare("INSERT INTO emails VALUES ('e1', '|INBOX|needs_response|', 'done')")
      .run();
    expect(() => byVersion(43).up(noDecisions)).not.toThrow();
    expect(() => byVersion(44).up(noDecisions)).not.toThrow();
    // Still 'done': without the decisions table we cannot tell what was drafted,
    // so re-queueing would be unbounded.
    expect(scalar(noDecisions, 'SELECT agent_status FROM emails')).toBe('done');
    noDecisions.close();
  });

  it('v57 FTS trigger gate returns early when there is no FTS table', () => {
    const db = openTestDb();
    db.exec('CREATE TABLE emails (id TEXT PRIMARY KEY, subject TEXT)');

    expect(() => byVersion(57).up(db)).not.toThrow();

    expect(objectExists(db, 'trigger', 'emails_fts_update')).toBe(false);
    db.close();
  });

  it('v62 label-drift reconcile returns early when emails lacks label_status (pre-v60)', () => {
    const db = openTestDb();
    db.exec("CREATE TABLE emails (id TEXT PRIMARY KEY, agent_status TEXT, date INTEGER)");
    db.prepare("INSERT INTO emails VALUES ('e1', 'done', 1)").run();

    expect(() => reconcileLabelDrift.up(db)).not.toThrow();

    expect(columnsOf(db, 'emails')).not.toContain('label_status');
    db.close();
  });

  // v60's index is partial (`WHERE label_status = 'pending'`), so the drain query
  // only ever scans rows that actually need a label — the guard must not skip
  // creating it when the column already exists.
  it('v60 adds label_status when missing and only re-creates the partial index when present', () => {
    const db = openTestDb();
    db.exec("CREATE TABLE emails (id TEXT PRIMARY KEY)");

    emailLabelStatus.up(db);
    expect(columnsOf(db, 'emails')).toContain('label_status');
    expect(objectExists(db, 'index', 'idx_emails_label_status')).toBe(true);

    // Second run takes the "column already present" branch and stays quiet.
    expect(() => emailLabelStatus.up(db)).not.toThrow();
    expect(columnsOf(db, 'emails')).toContain('label_status');
    db.close();
  });
});

describe('data-mutating migrations', () => {
  // v62 re-marks the most recent categorized window 'pending' so the label drain
  // repairs drifted server labels ONCE. It must stay bounded (Gmail rate limits)
  // and must not touch mail the pipeline has not categorized yet.
  it('v62 re-marks only categorized mail, and only the newest 500', () => {
    const db = openTestDb();
    createMigrationManager(db).migrate();
    // 502 categorized + 1 uncategorized.
    for (let i = 0; i < 502; i += 1) {
      insertEmail(db, { id: `done-${i}`, agentStatus: 'done', labelStatus: 'done', date: 1000 + i });
    }
    insertEmail(db, { id: 'not-yet', agentStatus: 'pending', labelStatus: null, date: 9999 });

    reconcileLabelDrift.up(db);

    expect(scalar(db, "SELECT COUNT(*) FROM emails WHERE label_status = 'pending'")).toBe(500);
    // The two OLDEST categorized mails fall outside the window and keep 'done'.
    expect(scalar(db, "SELECT label_status FROM emails WHERE id = 'done-0'")).toBe('done');
    expect(scalar(db, "SELECT label_status FROM emails WHERE id = 'done-501'")).toBe('pending');
    // Never-categorized mail is left alone (no label to mirror yet).
    expect(scalar(db, "SELECT label_status FROM emails WHERE id = 'not-yet'")).toBe(null);
    db.close();
  });

  // The v57 gate is the fix for bulk mark-read re-tokenizing every body. Proven
  // by deleting the FTS row: a tags-only UPDATE must NOT resurrect it, while a
  // subject change must.
  it('v57 gate: flag-only updates skip the FTS re-index, content changes do not', () => {
    const db = openTestDb();
    createMigrationManager(db).migrate();
    const id = insertEmail(db, { subject: 'invoice for april', cleanBody: 'please pay' });
    db.prepare('DELETE FROM emails_fts WHERE email_id = ?').run(id);

    db.prepare("UPDATE emails SET tags = '|INBOX|read|' WHERE id = ?").run(id);
    expect(scalar(db, 'SELECT COUNT(*) FROM emails_fts')).toBe(0);

    db.prepare("UPDATE emails SET subject = 'invoice for may' WHERE id = ?").run(id);
    expect(
      scalar(db, "SELECT subject FROM emails_fts WHERE emails_fts MATCH 'may'"),
    ).toBe('invoice for may');
    db.close();
  });

  // v33 seeds the finance category. Re-inserting must not clobber a user's edited
  // prompt — it is INSERT OR IGNORE, and this pins that.
  it('v33 keeps a user-edited finance prompt on re-run (INSERT OR IGNORE)', () => {
    const db = openTestDb();
    createMigrationManager(db).migrate();
    db.prepare("UPDATE ai_category_definitions SET prompt = 'MY OWN RULES' WHERE slug = 'finance'").run();

    financeCategory.up(db);

    expect(scalar(db, "SELECT prompt FROM ai_category_definitions WHERE slug = 'finance'")).toBe(
      'MY OWN RULES',
    );
    expect(scalar(db, "SELECT COUNT(*) FROM ai_category_definitions WHERE slug = 'finance'")).toBe(1);
    db.close();
  });

  // v47 clears filenames that are nothing but the parser's literal "SIZE"; real
  // names (even ones containing the word) must survive — losing them means the
  // attachment chip renders blank forever.
  it('v47 clears only all-"SIZE" attachment names', () => {
    const db = openTestDb();
    createMigrationManager(db).migrate();
    const bogus = insertEmail(db, { id: 'bogus' });
    const bogusPair = insertEmail(db, { id: 'bogus2' });
    const real = insertEmail(db, { id: 'real' });
    db.prepare("UPDATE emails SET attachment_names = 'SIZE' WHERE id = ?").run(bogus);
    db.prepare("UPDATE emails SET attachment_names = 'SIZE, SIZE' WHERE id = ?").run(bogusPair);
    db.prepare("UPDATE emails SET attachment_names = 'SIZE-chart.pdf' WHERE id = ?").run(real);

    byVersion(47).up(db);

    expect(scalar(db, `SELECT attachment_names FROM emails WHERE id = 'bogus'`)).toBe(null);
    expect(scalar(db, `SELECT attachment_names FROM emails WHERE id = 'bogus2'`)).toBe(null);
    expect(scalar(db, `SELECT attachment_names FROM emails WHERE id = 'real'`)).toBe('SIZE-chart.pdf');
    db.close();
  });

  // v48 trips the re-fetch gate (`hasAttachments && !attachment_sizes`) for mail
  // whose filename came back as the placeholder "attachment". Clearing sizes for
  // correctly-named mail would re-download bodies for no reason.
  it('v48 clears attachment_sizes only for placeholder "attachment" names', () => {
    const db = openTestDb();
    createMigrationManager(db).migrate();
    const placeholder = insertEmail(db, { id: 'placeholder' });
    const named = insertEmail(db, { id: 'named' });
    db.prepare(
      `UPDATE emails SET attachment_names = '["attachment"]', attachment_sizes = '[123]' WHERE id = ?`,
    ).run(placeholder);
    db.prepare(
      `UPDATE emails SET attachment_names = '["report.pdf"]', attachment_sizes = '[456]' WHERE id = ?`,
    ).run(named);

    byVersion(48).up(db);

    expect(scalar(db, `SELECT attachment_sizes FROM emails WHERE id = 'placeholder'`)).toBe(null);
    expect(scalar(db, `SELECT attachment_sizes FROM emails WHERE id = 'named'`)).toBe('[456]');
    db.close();
  });
});
