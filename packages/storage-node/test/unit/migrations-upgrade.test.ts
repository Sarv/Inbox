import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MigrationManager, createMigrationManager, type Migration } from '../../src/migrations';
import { attachSharedContacts, SHARED_SCHEMA } from '../../src/shared-contacts';
import { createLegacyContactsTable } from '../../src/test-support/legacy-contacts';
import { openTestDb } from '../../src/test-support/test-db';

// THE upgrade test. Every shipped release re-runs the chain over a database an
// OLDER build wrote, and that database still holds the user's only copy of their
// mail: a migration that drops a column's data, re-writes the wrong rows, or
// throws half-way leaves them with a broken (or empty) mailbox and no undo.
//
// A DB that has only ever seen v24's schema.sql is simulated by hand below —
// deliberately NOT by running v24, because schema.sql is the CURRENT schema and
// already contains every column the later migrations add, so running it would
// exercise only the "column already present" side of every guard. Building the
// v24-era shape drives the other side: the real ALTER TABLE paths an upgrading
// user takes, plus the data-repair UPDATEs those migrations run.

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

/** Runs the slice of the chain in (from, to] — i.e. what one upgrade applies. */
function migrateRange(db: Database.Database, from: number, to: number): void {
  const manager = new MigrationManager(db);
  CHAIN.filter((m) => m.version > from && m.version <= to).forEach((m) => manager.register(m));
  manager.migrate();
}

const columnsOf = (db: Database.Database, table: string, schema = 'main'): string[] =>
  (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>)
    .map((r) => r.name)
    .sort();

const indexesOf = (db: Database.Database): string[] =>
  (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'",
  ).all() as Array<{ name: string }>)
    .map((r) => r.name)
    .sort();

const rows = <T>(db: Database.Database, sql: string): T[] => db.prepare(sql).all() as T[];

const one = <T>(db: Database.Database, sql: string, ...params: unknown[]): T =>
  db.prepare(sql).get(...params) as T;

const scalar = (db: Database.Database, sql: string, ...params: unknown[]): unknown => {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
};

/**
 * A database in the v24-era shape: the base tables only, with schema_version
 * already stamped at 24 so the chain starts at v25 like a real upgrader.
 * Column lists mirror schema.sql MINUS everything v25..v67 adds.
 */
function newLegacyDb(): Database.Database {
  const db = openTestDb();
  // Every real connection has the contact directory attached before the chain
  // runs (SQLiteStorage.initialize), and v77 adopts this mailbox's `contacts`
  // into it. An empty path gives this database a private, anonymous directory —
  // which is also what a single upgrading account has: one mailbox, one
  // directory, nothing else contributing yet.
  attachSharedContacts(db, '');
  // The address book a v24-era mailbox really had, from the shared fixture so
  // this file and the adoption tests cannot disagree about what "legacy" means.
  createLegacyContactsTable(db);
  db.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      message_id TEXT UNIQUE NOT NULL,
      thread_id TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      uid INTEGER,
      tags TEXT NOT NULL DEFAULT '||',
      subject TEXT,
      from_address TEXT NOT NULL,
      from_name TEXT,
      to_address TEXT,
      to_names TEXT,
      cc_address TEXT,
      cc_names TEXT,
      bcc_address TEXT,
      bcc_names TEXT,
      reply_to TEXT,
      date INTEGER NOT NULL,
      received_date INTEGER,
      clean_body TEXT NOT NULL,
      raw_body TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      in_reply_to TEXT,
      "references" TEXT,
      priority TEXT,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      attachment_names TEXT,
      importance_score INTEGER DEFAULT 0,
      importance_source TEXT DEFAULT 'none',
      auth_status TEXT,
      ai_processed_at INTEGER,
      ai_confidence REAL DEFAULT 0,
      ai_reasoning TEXT,
      snooze_until INTEGER,
      snooze_original_tags TEXT,
      has_embedding INTEGER NOT NULL DEFAULT 0,
      embedding_last_generated INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT UNIQUE NOT NULL,
      parent_id TEXT,
      last_sync_uid INTEGER,
      last_sync_time INTEGER,
      total_count INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      last_known_uidnext INTEGER,
      last_known_message_count INTEGER,
      sync_status TEXT DEFAULT 'idle',
      special_use TEXT,
      subscribed INTEGER NOT NULL DEFAULT 1,
      provider TEXT DEFAULT 'generic',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      first_message_id TEXT NOT NULL,
      last_message_id TEXT NOT NULL,
      last_message_date INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 1,
      participants TEXT,
      has_unread INTEGER NOT NULL DEFAULT 0,
      has_flagged INTEGER NOT NULL DEFAULT 0,
      labels TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE sender_stats (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      domain TEXT NOT NULL,
      received_count INTEGER DEFAULT 0,
      replied_count INTEGER DEFAULT 0,
      sent_to_count INTEGER DEFAULT 0,
      read_count INTEGER DEFAULT 0,
      deleted_count INTEGER DEFAULT 0,
      first_seen INTEGER NOT NULL,
      last_received INTEGER,
      last_replied INTEGER,
      last_sent_to INTEGER,
      reputation_score INTEGER DEFAULT 0,
      is_vip INTEGER DEFAULT 0,
      is_blocked INTEGER DEFAULT 0,
      auth_pass_count INTEGER DEFAULT 0,
      auth_fail_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE pending_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      uid INTEGER NOT NULL,
      data TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE conversation_extractions (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,
      messages TEXT NOT NULL,
      email_count INTEGER,
      processed_email_ids TEXT,
      processed_at INTEGER NOT NULL,
      model_used TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE ai_category_definitions (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      prompt TEXT NOT NULL,
      icon TEXT DEFAULT 'Tag',
      color TEXT DEFAULT 'blue',
      sort_order INTEGER DEFAULT 0,
      is_system INTEGER DEFAULT 0,
      is_enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    INSERT INTO schema_version (version, applied_at) VALUES (24, 1690000000);
  `);
  return db;
}

/** Realistic user data, all timestamps fixed so nothing depends on the clock. */
function seedLegacyData(db: Database.Database): void {
  db.exec(`
    INSERT INTO folders (id, name, path, total_count, unread_count, last_sync_uid, sync_status)
    VALUES ('f-inbox', 'INBOX', 'INBOX', 7, 2, 4321, 'idle'),
           ('f-sent', 'Sent', 'Sent', 1, 0, 12, 'idle');

    INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date, message_count, participants, has_unread)
    VALUES ('t-1', 'Quarterly report review', '<m1@x>', '<m1@x>', 1690001000, 1, 'a@x.com', 1),
           ('t-2', 'Renewal question', '<m2@x>', '<m2@x>', 1690002000, 1, 'b@x.com', 1),
           ('t-3', 'Welcome aboard', '<m3@x>', '<m3@x>', 1690003000, 2, 'c@x.com', 0),
           ('t-4', 'Server maintenance', '<m4@x>', '<m4@x>', 1690004000, 1, 'd@x.com', 0);

    INSERT INTO conversation_extractions (id, thread_id, messages, processed_at)
    VALUES ('ce-1', 't-3', '[]', 1690003500);

    INSERT INTO contacts (id, email, name, first_seen, last_seen, email_count, phone)
    VALUES ('c-role', 'info@acme.com', 'Acme Info', 1680000000, 1690000000, 12, '+911234567890'),
           ('c-human', 'jane.doe@acme.com', 'Jane Doe', 1680000000, 1690000000, 30, NULL),
           ('c-role-typed', 'sales@vendor.io', 'Vendor Sales', 1680000000, 1690000000, 4, NULL);

    INSERT INTO sender_stats (id, email, domain, received_count, first_seen, reputation_score)
    VALUES ('ss-1', 'jane.doe@acme.com', 'acme.com', 30, 1680000000, 55);

    INSERT INTO pending_operations (type, folder_path, uid, data, retry_count)
    VALUES ('move', 'INBOX', 4321, '{"to":"Trash"}', 2),
           ('markRead', 'INBOX', 4322, NULL, 0);

    INSERT INTO ai_category_definitions (slug, name, description, prompt, sort_order)
    VALUES ('needs_response', 'Needs Response', 'Emails that require your reply', 'OLD LOOSE PROMPT', 2),
           ('invoice', 'Invoices', 'Any invoice-ish mail', 'OLD INVOICE PROMPT', 6),
           ('waiting_reply', 'Waiting Reply', 'Sent and waiting', 'OLD WAITING PROMPT', 9);
  `);

  const insertEmail = db.prepare(
    `INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address,
       from_name, to_address, cc_address, date, clean_body, raw_body, content_type, content_hash,
       in_reply_to, has_attachments, attachment_count, attachment_names, ai_processed_at)
     VALUES (@id, @messageId, @threadId, @folderId, @uid, @tags, @subject, @fromAddress,
       @fromName, @toAddress, @ccAddress, @date, @cleanBody, 'raw-mime', 'html', @hash,
       @inReplyTo, @hasAttachments, @attachmentCount, @attachmentNames, @aiProcessedAt)`,
  );
  const email = (over: Record<string, unknown>) =>
    insertEmail.run({
      messageId: `<${over.id}@x>`,
      folderId: 'f-inbox',
      uid: 100,
      tags: '|INBOX|',
      subject: 'subject',
      fromAddress: 'someone@example.com',
      fromName: 'Someone',
      toAddress: 'me@example.com',
      ccAddress: null,
      cleanBody: 'body text',
      hash: `h-${over.id}`,
      inReplyTo: null,
      hasAttachments: 0,
      attachmentCount: 0,
      attachmentNames: null,
      aiProcessedAt: null,
      ...over,
    } as never);

  email({
    id: 'e-need-1',
    threadId: 't-1',
    uid: 4321,
    tags: '|INBOX|needs_response|',
    subject: 'Quarterly report review',
    cleanBody: 'Please review the quarterly numbers before Friday',
    date: 1690001000,
    aiProcessedAt: 1690001500,
  });
  email({
    id: 'e-need-2',
    threadId: 't-2',
    uid: 4322,
    tags: '|INBOX|needs_response|',
    subject: 'Renewal question',
    cleanBody: 'Do we renew the licence?',
    date: 1690002000,
    aiProcessedAt: 1690002500,
  });
  email({
    id: 'e-read',
    threadId: 't-3',
    uid: 4323,
    tags: '|INBOX|read|',
    subject: 'Welcome aboard',
    cleanBody: 'Glad to have you',
    date: 1690003000,
    aiProcessedAt: 1690003500,
  });
  email({
    id: 'e-fresh',
    threadId: 't-4',
    uid: 4324,
    tags: '|INBOX|',
    subject: 'Server maintenance',
    cleanBody: 'Planned downtime on Sunday',
    date: 1690004000,
  });
  email({
    id: 'e-bogus-size',
    threadId: 't-4',
    uid: 4325,
    subject: 'Scan attached',
    date: 1690004100,
    hasAttachments: 1,
    attachmentCount: 2,
    attachmentNames: 'SIZE, SIZE',
  });
  email({
    id: 'e-placeholder',
    threadId: 't-4',
    uid: 4326,
    subject: 'Unnamed attachment',
    date: 1690004200,
    hasAttachments: 1,
    attachmentCount: 1,
    attachmentNames: '["attachment"]',
  });
  email({
    id: 'e-named',
    threadId: 't-4',
    uid: 4327,
    subject: 'Report attached',
    date: 1690004300,
    hasAttachments: 1,
    attachmentCount: 1,
    attachmentNames: '["report.pdf"]',
  });
}

describe('upgrading a v24-era database to the current version', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = newLegacyDb();
    seedLegacyData(db);
  });

  afterEach(() => db.close());

  // The single most important property of the whole module: after the upgrade the
  // user's mail, folders, contacts, sender stats and queued IMAP operations are
  // all still there, byte-for-byte, on top of the new schema.
  it('upgrades in staged hops (v41 → v42 → v47 → head) without losing a single row', () => {
    // Hop 1: an older build's worth of migrations.
    migrateRange(db, 24, 41);
    expect(new MigrationManager(db).getCurrentVersion()).toBe(41);
    // v27's backfill indexed the mail that already existed — without it, every
    // pre-upgrade email would be invisible to search forever.
    expect(scalar(db, 'SELECT COUNT(*) AS c FROM emails_fts')).toBe(7);
    expect(
      scalar(db, "SELECT email_id FROM emails_fts WHERE emails_fts MATCH 'quarterly'"),
    ).toBe('e-need-1');
    // v26 added the status column with a default, so queued ops stay runnable.
    expect(scalar(db, 'SELECT COUNT(*) AS c FROM pending_operations WHERE status = ?', 'pending')).toBe(2);

    // Enrichment (v39) had already stamped a person identity on two role
    // mailboxes and the user had hand-classified one of them — the state v42
    // exists to repair.
    db.exec(`
      UPDATE contacts SET person_id = 'p-shared', mobile_e164 = '+911234567890'
       WHERE id IN ('c-role', 'c-human', 'c-role-typed');
      UPDATE contacts SET contact_type = 'customer', contact_type_source = 'user'
       WHERE id = 'c-role-typed';
    `);

    // Hop 2: v42 only (the contact repair).
    migrateRange(db, 41, 42);

    // Role mailbox: identity stripped and typed automated.
    const role = one<{ person_id: string | null; mobile_e164: string | null; contact_type: string }>(
      db,
      "SELECT person_id, mobile_e164, contact_type FROM contacts WHERE id = 'c-role'",
    );
    expect(role.person_id).toBe(null);
    expect(role.mobile_e164).toBe(null);
    expect(role.contact_type).toBe('automated');

    // A real human keeps their merged identity — the repair must not over-reach.
    const human = one<{ person_id: string | null; mobile_e164: string | null; contact_type: string }>(
      db,
      "SELECT person_id, mobile_e164, contact_type FROM contacts WHERE id = 'c-human'",
    );
    expect(human.person_id).toBe('p-shared');
    expect(human.mobile_e164).toBe('+911234567890');
    expect(human.contact_type).toBe('unknown');

    // A user-set classification is never overwritten, but the bogus shared phone
    // identity still goes.
    const typed = one<{ person_id: string | null; contact_type: string; contact_type_source: string }>(
      db,
      "SELECT person_id, contact_type, contact_type_source FROM contacts WHERE id = 'c-role-typed'",
    );
    expect(typed.person_id).toBe(null);
    expect(typed.contact_type).toBe('customer');
    expect(typed.contact_type_source).toBe('user');

    // v31 already derived the pipeline state from the legacy AI columns.
    expect(scalar(db, "SELECT agent_status FROM emails WHERE id = 'e-read'")).toBe('done');
    expect(scalar(db, "SELECT agent_at FROM emails WHERE id = 'e-read'")).toBe(1690003500);
    expect(scalar(db, "SELECT extraction_status FROM emails WHERE id = 'e-read'")).toBe('done');
    expect(scalar(db, "SELECT extraction_status FROM emails WHERE id = 'e-need-1'")).toBe('pending');
    expect(scalar(db, "SELECT agent_status FROM emails WHERE id = 'e-fresh'")).toBe('pending');

    // One needs_response mail already HAS a drafted reply; the other does not.
    db.prepare(
      `INSERT INTO agent_decisions (id, email_id, proposed_action, confidence, status, proposed_at)
       VALUES ('d-1', 'e-need-2', 'reply', 0.9, 'pending', 1690002600)`,
    ).run();

    // Hop 3: v43..v47 (the re-queues and the attachment-name cleanup).
    migrateRange(db, 42, 47);

    // v43/v44 re-queue only the needs_response mail that never got a draft.
    expect(scalar(db, "SELECT agent_status FROM emails WHERE id = 'e-need-1'")).toBe('pending');
    expect(scalar(db, "SELECT agent_status FROM emails WHERE id = 'e-need-2'")).toBe('done');
    expect(scalar(db, "SELECT agent_status FROM emails WHERE id = 'e-read'")).toBe('done');
    // v47 dropped the parser's bogus "SIZE" filenames; real names survive.
    expect(scalar(db, "SELECT attachment_names FROM emails WHERE id = 'e-bogus-size'")).toBe(null);
    expect(scalar(db, "SELECT attachment_names FROM emails WHERE id = 'e-named'")).toBe(
      '["report.pdf"]',
    );

    // Sizes were re-derived by a body re-fetch between the two upgrades.
    db.exec(`
      UPDATE emails SET attachment_sizes = '[2048]' WHERE id = 'e-placeholder';
      UPDATE emails SET attachment_sizes = '[4096]' WHERE id = 'e-named';
    `);

    // Hop 4: the rest of the chain.
    migrateRange(db, 47, CURRENT_VERSION);
    expect(new MigrationManager(db).getCurrentVersion()).toBe(CURRENT_VERSION);

    // v48 only re-arms the re-fetch for the placeholder-named attachment.
    expect(scalar(db, "SELECT attachment_sizes FROM emails WHERE id = 'e-placeholder'")).toBe(null);
    expect(scalar(db, "SELECT attachment_sizes FROM emails WHERE id = 'e-named'")).toBe('[4096]');

    // ---- nothing was lost ----
    expect(scalar(db, 'SELECT COUNT(*) AS c FROM emails')).toBe(7);
    expect(scalar(db, 'SELECT COUNT(*) AS c FROM threads')).toBe(4);
    expect(scalar(db, 'SELECT COUNT(*) AS c FROM contacts')).toBe(3);
    expect(scalar(db, 'SELECT COUNT(*) AS c FROM pending_operations')).toBe(2);

    const kept = one<Record<string, unknown>>(
      db,
      `SELECT message_id, thread_id, folder_id, uid, tags, subject, from_address, to_address,
              date, clean_body, content_hash, ai_processed_at
         FROM emails WHERE id = 'e-need-1'`,
    );
    expect(kept).toEqual({
      message_id: '<e-need-1@x>',
      thread_id: 't-1',
      folder_id: 'f-inbox',
      uid: 4321,
      tags: '|INBOX|needs_response|',
      subject: 'Quarterly report review',
      from_address: 'someone@example.com',
      to_address: 'me@example.com',
      date: 1690001000,
      clean_body: 'Please review the quarterly numbers before Friday',
      content_hash: 'h-e-need-1',
      ai_processed_at: 1690001500,
    });

    // Folder sync state (the thing that decides what gets re-downloaded) intact,
    // and the columns added on the way have safe defaults.
    const inbox = one<Record<string, unknown>>(
      db,
      `SELECT total_count, unread_count, last_sync_uid, uid_validity, highest_modseq,
              backfill_oldest_uid, backfill_complete FROM folders WHERE id = 'f-inbox'`,
    );
    expect(inbox).toEqual({
      total_count: 7,
      unread_count: 2,
      last_sync_uid: 4321,
      uid_validity: null,
      highest_modseq: null,
      backfill_oldest_uid: null,
      backfill_complete: 0,
    });

    // Queued IMAP ops keep their payload and pick up the dead-letter columns.
    const ops = rows<Record<string, unknown>>(
      db,
      `SELECT type, folder_path, uid, data, retry_count, status, last_error, next_retry_at,
              attempted_command, server_response FROM pending_operations ORDER BY uid`,
    );
    expect(ops[0]).toEqual({
      type: 'move',
      folder_path: 'INBOX',
      uid: 4321,
      data: '{"to":"Trash"}',
      retry_count: 2,
      status: 'pending',
      last_error: null,
      next_retry_at: null,
      attempted_command: null,
      server_response: null,
    });

    // Contact + sender history survives (email_count/reputation are learned data
    // that cannot be recomputed from the mailbox alone).
    expect(scalar(db, "SELECT email_count FROM contacts WHERE id = 'c-human'")).toBe(30);
    expect(scalar(db, "SELECT phone FROM contacts WHERE id = 'c-role'")).toBe('+911234567890');
    expect(scalar(db, "SELECT reputation_score FROM sender_stats WHERE id = 'ss-1'")).toBe(55);

    // Thread rows keep their counts and gain the read-model rollup defaults.
    const thread = one<Record<string, unknown>>(
      db,
      `SELECT message_count, participants, chat_email_count, has_important, live_message_count,
              state_version FROM threads WHERE id = 't-3'`,
    );
    expect(thread).toEqual({
      message_count: 2,
      participants: 'c@x.com',
      chat_email_count: 0,
      has_important: 0,
      live_message_count: 0,
      state_version: 0,
    });

    // ---- taxonomy converged onto the current definitions ----
    const slugs = rows<{ slug: string }>(
      db,
      'SELECT slug FROM ai_category_definitions ORDER BY slug',
    ).map((r) => r.slug);
    expect(slugs).toEqual(['finance', 'invoice', 'needs_response', 'promotions']);
    expect(scalar(db, "SELECT prompt FROM ai_category_definitions WHERE slug = 'needs_response'")).toContain(
      'COLD SALES / PROMOTIONAL OUTREACH',
    );
    expect(scalar(db, "SELECT description FROM ai_category_definitions WHERE slug = 'invoice'")).toBe(
      'Invoices and bills from vendors',
    );

    // ---- the read model is registered as needing its first backfill ----
    expect(scalar(db, "SELECT value FROM read_model_state WHERE key = 'status'")).toBe('pending');
    // v65's triggers are live, so the very next write is captured for the rebuild.
    db.prepare("UPDATE emails SET tags = '|INBOX|read|' WHERE id = 'e-fresh'").run();
    expect(scalar(db, "SELECT COUNT(*) AS c FROM read_model_dirty WHERE thread_id = 't-4'")).toBe(1);
  });

  // Guards against the classic split-brain bug: schema.sql gets a new column but
  // no migration adds it (or vice versa), so upgraders and fresh installs end up
  // with DIFFERENT schemas and only one of them hits the "no such column" crash.
  it('lands on the SAME column set as a fresh install', () => {
    migrateRange(db, 24, CURRENT_VERSION);

    const fresh = openTestDb();
    attachSharedContacts(fresh, '');
    createMigrationManager(fresh).migrate();

    for (const table of [
      'emails',
      'threads',
      'folders',
      'sender_stats',
      'pending_operations',
      'pending_sends',
      'labels',
      'filter_rules',
      'thread_folders',
      'thread_categories',
      'read_model_state',
      'read_model_dirty',
      'agent_prompt_templates',
      'user_categorization_rules',
      'image_allowed_senders',
    ]) {
      expect(columnsOf(db, table), `column drift on ${table}`).toEqual(columnsOf(fresh, table));
    }
    // `contacts` is no longer in the mailbox at all. The same drift check still
    // matters, and matters MORE here: the upgrader's directory was populated by
    // v77 from a v24-era table, the fresh install's was created empty from
    // `directorySchema`, and the two must still be the same shape.
    expect(
      columnsOf(db, 'contacts', SHARED_SCHEMA),
      'column drift on shared.contacts',
    ).toEqual(columnsOf(fresh, 'contacts', SHARED_SCHEMA));
    fresh.close();
  });

  // schema.sql and the migration chain are two independent definitions of the
  // same database. An index added to one and not the other is invisible: both
  // installs work, but the upgraded user runs the slow plan forever while a
  // fresh install does not — and nothing fails. So every index a hot-path query
  // plan depends on is asserted on the UPGRADE path, not just a fresh install.
  //
  // NOT asserted here: full index parity between the two paths. It does not hold
  // today — a v24-era DB never receives the indexes schema.sql declares but no
  // migration creates (idx_threads_last_message_date, idx_sender_stats_email and
  // others). That is a real pre-existing gap, deliberately left visible rather
  // than pinned as correct; pinning parity would fail, and enumerating the
  // missing ones would record the gap as intended behaviour.
  it('creates the plan-critical emails indexes on the upgrade path too', () => {
    migrateRange(db, 24, CURRENT_VERSION);

    const indexes = indexesOf(db);
    // v71 — the case-folded sender lookup behind the 2.2s enrichment scan.
    expect(indexes).toContain('idx_emails_from_lower_date');
    // v60/v70 — the label drain and the thread-resolver subject seek.
    expect(indexes).toContain('idx_emails_label_status');
    expect(indexes).toContain('idx_email_thread_keys_lookup');
  });

  // A single-hop upgrade (a user who skipped many releases) must reach exactly the
  // same place as the staged hops above — no migration may depend on having been
  // run in its own session.
  it('reaches the head in one hop, with the same data repairs applied', () => {
    migrateRange(db, 24, CURRENT_VERSION);

    expect(new MigrationManager(db).getCurrentVersion()).toBe(CURRENT_VERSION);
    expect(scalar(db, 'SELECT COUNT(*) AS c FROM emails')).toBe(7);
    // No agent_decisions existed, so BOTH needs_response mails were re-queued.
    expect(
      scalar(db, "SELECT COUNT(*) AS c FROM emails WHERE agent_status = 'pending' AND tags LIKE '%|needs_response|%'"),
    ).toBe(2);
    // v62 re-marks the categorized window for a one-time label re-mirror.
    expect(scalar(db, "SELECT COUNT(*) AS c FROM emails WHERE label_status = 'pending'")).toBe(1);
    expect(scalar(db, "SELECT label_status FROM emails WHERE id = 'e-read'")).toBe('pending');
    expect(scalar(db, "SELECT label_status FROM emails WHERE id = 'e-fresh'")).toBe(null);
  });

  // v76 adds the AI's own category verdict. The NOT-backfilling is the point of
  // the migration, so it is asserted here rather than left to a comment: seeding
  // ai_categories from the tag string would re-label Gmail's `\Important` guess
  // as something the AI decided, which is the exact bug the column exists to end.
  // Every upgraded row must read as "no verdict recorded" until the AI re-runs.
  it('adds ai_categories without backfilling it from tags', () => {
    migrateRange(db, 24, CURRENT_VERSION);

    expect(columnsOf(db, 'emails')).toContain('ai_categories');
    expect(scalar(db, 'SELECT COUNT(*) AS c FROM emails WHERE ai_categories IS NOT NULL')).toBe(0);
    // Including the categorized row v62 queued for re-mirroring: it is exactly
    // the row a tag-based backfill would have gotten wrong.
    expect(scalar(db, "SELECT ai_categories FROM emails WHERE id = 'e-read'")).toBe(null);
  });
});
