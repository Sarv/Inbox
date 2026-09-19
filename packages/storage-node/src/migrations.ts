// Database migration system — Simplified for v2 tags schema
// Fresh start: just load schema.sql, no incremental migrations

import { readFileSync } from 'fs';
import { basename, join } from 'path';

import { logger, isRoleAddress, isNoReplyAddress, contactNameForAddress, normalizeSubject } from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { applyFtsSchema, FTS_REBUILD_SQL, FTS_TRIGGERS } from './fts-schema';
import { rawBodyExpression } from './repositories/body-storage';
import { clearInlineImageCache, inflateInlineImages } from './repositories/inline-image-store';
import { hasSharedContacts, SHARED } from './shared-contacts';

/**
 * Facts a migration cannot read off the connection it is handed.
 *
 * Only the adoption pass (v77) needs one so far: folding a mailbox's contacts
 * into the shared directory has to record WHICH mailbox they came from, and
 * the account id lives in the storage config, not in the database.
 *
 * Every field is optional and every migration must work without it — the
 * seeding script, the test fixtures and any direct `new SQLiteStorage(...)`
 * all open databases with no account behind them.
 */
export interface MigrationContext {
  /** Stable id of the account this database belongs to, when one is known. */
  accountId?: string;
}

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database, context: MigrationContext) => void;
  down?: (db: Database.Database, context: MigrationContext) => void;
}

/**
 * Does THIS mailbox still own a local `contacts` table?
 *
 * Contacts moved to the shared directory (`shared.contacts`, see
 * shared-contacts.ts), so every migration that was written to evolve a
 * per-account contacts table now has nothing to evolve on a database created
 * after the move — and must not try.
 *
 * Two different failures make this a hard guard rather than a tidy-up:
 *  - `PRAGMA table_info(contacts)` and `ALTER TABLE contacts` both resolve
 *    THROUGH the attached schema, so an unguarded migration would quietly
 *    alter the shared directory on behalf of one account.
 *  - `CREATE INDEX … ON contacts(…)` does NOT: an unqualified index is created
 *    in `main`, where the table no longer exists, so it throws `no such table:
 *    main.contacts` — and because migrations abort on the first throw, that one
 *    error would strand the database on a stale schema forever.
 *
 * Scoped to `main` on purpose (`sqlite_master`, not `sqlite_schema` across
 * schemas): the question is whether the table is HERE, not whether it is
 * reachable.
 */
export function hasLocalContactsTable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM main.sqlite_master WHERE type = 'table' AND name = 'contacts'")
    .get() as { present: number } | undefined;
  return !!row;
}

/**
 * `ALTER TABLE <table> ADD COLUMN <column> <definition>`, skipped when the
 * column is already present.
 *
 * A bare ADD COLUMN throws `duplicate column name` — and because migrations run
 * in order and abort on the first throw, that ONE error blocks every later
 * migration for good: the app comes up on a stale schema and every feature
 * added since fails at the SQL layer. The column can legitimately be there
 * already: `schema.sql` for a fresh install carries the current shape, a
 * migration may have been partially applied before a crash, and a DB restored
 * from a newer build is downgraded then re-upgraded.
 *
 * Use this for every ADD COLUMN in a migration instead of a bare `db.exec`.
 */
export function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
  schema = 'main',
): boolean {
  // Both statements name the schema. Every table these migrations widen is a
  // per-account one, but the shared contact directory is ATTACHed to the same
  // connection and an unqualified name resolves THROUGH it once `main` has no
  // table of that name — which would silently alter one account's directory on
  // everyone's behalf. Note the two different placements SQLite requires:
  // `PRAGMA <schema>.table_info(<table>)`, but `ALTER TABLE <schema>.<table>`.
  const cols = db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${schema}.${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/**
 * Migration manager
 */
export class MigrationManager {
  private migrations: Migration[] = [];

  constructor(private db: Database.Database, private context: MigrationContext = {}) {}

  register(migration: Migration): void {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
  }

  getCurrentVersion(): number {
    try {
      const row = this.db
        .prepare('SELECT MAX(version) as version FROM schema_version')
        .get() as { version: number | null };
      return row.version || 0;
    } catch {
      return 0;
    }
  }

  migrate(): void {
    const currentVersion = this.getCurrentVersion();
    const pendingMigrations = this.migrations.filter(m => m.version > currentVersion);

    if (pendingMigrations.length === 0) {
      logger.info('No pending migrations');
      return;
    }

    logger.info(`Running ${pendingMigrations.length} migrations`);

    for (const migration of pendingMigrations) {
      this.runMigration(migration);
    }

    logger.info('All migrations completed');
  }

  private runMigration(migration: Migration): void {
    logger.info(`Running migration ${migration.version}: ${migration.name}`);

    const transaction = this.db.transaction(() => {
      migration.up(this.db, this.context);
      this.db
        .prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)')
        .run(migration.version);
    });

    try {
      transaction();
      logger.info(`Migration ${migration.version} completed`);
    } catch (error) {
      logger.error(`Migration ${migration.version} failed:`, error);
      throw error;
    }
  }

  rollback(targetVersion: number): void {
    const currentVersion = this.getCurrentVersion();
    if (targetVersion >= currentVersion) {
      logger.info('Nothing to rollback');
      return;
    }

    const migrationsToRollback = this.migrations
      .filter(m => m.version > targetVersion && m.version <= currentVersion)
      .reverse();

    // Check the WHOLE ladder before touching the database. Most migrations here
    // have no `down` (SQLite can't drop columns), and throwing part-way through
    // left the schema half-rolled-back with schema_version already decremented
    // for the steps that did run — a state no later `migrate()` can repair.
    // Refusing up front leaves the DB exactly as it was.
    const undoable = migrationsToRollback.filter((m) => !m.down);
    if (undoable.length > 0) {
      throw new Error(
        `Cannot roll back to ${targetVersion}: migration(s) ${undoable.map((m) => m.version).join(', ')} have no down function`,
      );
    }

    for (const migration of migrationsToRollback) {
      const transaction = this.db.transaction(() => {
        migration.down!(this.db, this.context);
        this.db
          .prepare('DELETE FROM schema_version WHERE version = ?')
          .run(migration.version);
      });

      try {
        transaction();
        logger.info(`Migration ${migration.version} rolled back`);
      } catch (error) {
        logger.error(`Rollback of migration ${migration.version} failed:`, error);
        throw error;
      }
    }
  }
}

/**
 * v24: Fresh start with unified tags schema
 * Loads schema.sql which creates all tables, indexes, triggers, and seed data
 */
export const initialTagsSchema: Migration = {
  version: 24,
  name: 'initial_tags_schema',
  up: (db) => {
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    db.exec(schema);
  },
  down: (db) => {
    db.exec(`
      DROP TABLE IF EXISTS conversation_extractions;
      DROP TABLE IF EXISTS ai_processing_queue;
      DROP TABLE IF EXISTS thread_summaries;
      DROP TABLE IF EXISTS pending_operations;
      DROP TABLE IF EXISTS signature_patterns;
      DROP TABLE IF EXISTS spammers;
      DROP TABLE IF EXISTS sender_stats;
      -- main-qualified on purpose. The shared contact directory is ATTACHed as
      -- schema "shared", and an unqualified DROP resolves through it once main
      -- has no such table -- so rolling ONE mailbox back would delete the
      -- address book of EVERY account. The main. prefix keeps the rollback
      -- local, and IF EXISTS makes it a no-op once this mailbox has adopted
      -- the directory and no longer owns a local contacts table.
      DROP TABLE IF EXISTS main.contacts;
      DROP TABLE IF EXISTS ai_category_definitions;
      DROP TABLE IF EXISTS embedding_metadata;
      DROP TABLE IF EXISTS attachments;
      DROP TABLE IF EXISTS emails;
      DROP TABLE IF EXISTS threads;
      DROP TABLE IF EXISTS folders;
      DROP TABLE IF EXISTS accounts;
      DROP TABLE IF EXISTS schema_version;
    `);
  },
};

/**
 * v25: Add chat extraction tracking columns to threads table
 */
export const chatExtractionTracking: Migration = {
  version: 25,
  name: 'chat_extraction_tracking',
  up: (db) => {
    // Add columns for tracking background conversation extraction
    // Check if columns already exist (schema.sql from migration 24 may have created them)
    const cols = db.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has('chat_extracted_at')) {
      db.exec(`ALTER TABLE threads ADD COLUMN chat_extracted_at INTEGER DEFAULT NULL;`);
    }
    if (!colNames.has('chat_email_count')) {
      db.exec(`ALTER TABLE threads ADD COLUMN chat_email_count INTEGER DEFAULT 0;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_threads_chat_extraction ON threads(chat_extracted_at, chat_email_count, message_count);`);
  },
  down: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_threads_chat_extraction;
    `);
    // SQLite doesn't support DROP COLUMN before 3.35.0, but we can leave the columns
  },
};

/**
 * v26: Add status column and unique index to pending_operations for crash-safe batched pipeline
 */
export const pendingOperationsUpgrade: Migration = {
  version: 26,
  name: 'pending_operations_status_and_unique_index',
  up: (db) => {
    const cols = db.prepare("PRAGMA table_info(pending_operations)").all() as { name: string }[];
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has('status')) {
      db.exec(`ALTER TABLE pending_operations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_ops_unique ON pending_operations(type, folder_path, uid);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_ops_status ON pending_operations(status);`);
  },
  down: (db) => {
    db.exec(`DROP INDEX IF EXISTS idx_pending_ops_unique;`);
    db.exec(`DROP INDEX IF EXISTS idx_pending_ops_status;`);
  },
};

/**
 * v27: Add FTS5 full-text search index
 */
export const fts5SearchIndex: Migration = {
  version: 27,
  name: 'fts5_search_index',
  up: (db) => {
    // Create FTS5 virtual table
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
        email_id UNINDEXED,
        subject,
        from_address,
        from_name,
        to_address,
        cc_address,
        attachment_names,
        clean_body,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    // Triggers to keep FTS in sync
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS emails_fts_insert AFTER INSERT ON emails BEGIN
        INSERT INTO emails_fts(email_id, subject, from_address, from_name, to_address, cc_address, attachment_names, clean_body)
        VALUES (new.id, new.subject, new.from_address, new.from_name, new.to_address, new.cc_address, new.attachment_names, new.clean_body);
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS emails_fts_delete AFTER DELETE ON emails BEGIN
        DELETE FROM emails_fts WHERE email_id = old.id;
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS emails_fts_update AFTER UPDATE ON emails BEGIN
        DELETE FROM emails_fts WHERE email_id = old.id;
        INSERT INTO emails_fts(email_id, subject, from_address, from_name, to_address, cc_address, attachment_names, clean_body)
        VALUES (new.id, new.subject, new.from_address, new.from_name, new.to_address, new.cc_address, new.attachment_names, new.clean_body);
      END;
    `);

    // Backfill FTS from existing emails.
    //
    // Only rows NOT already indexed. The table is created with IF NOT EXISTS and
    // may already be populated — schema.sql builds it for a fresh install, and
    // the insert trigger above indexes every row written since. A blind
    // `INSERT ... SELECT FROM emails` then indexed every message a SECOND time,
    // so search returned each hit twice and the "no results" gap could not be
    // told apart from a duplicate.
    logger.info('Backfilling FTS5 index from existing emails...');
    db.exec(`
      INSERT INTO emails_fts(email_id, subject, from_address, from_name, to_address, cc_address, attachment_names, clean_body)
      SELECT id, subject, from_address, from_name, to_address, cc_address, attachment_names, clean_body
      FROM emails
      WHERE NOT EXISTS (SELECT 1 FROM emails_fts WHERE emails_fts.email_id = emails.id);
    `);
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM emails_fts').get() as any).cnt;
    logger.info(`FTS5 index backfilled with ${count} entries`);
  },
  down: (db) => {
    db.exec(`DROP TRIGGER IF EXISTS emails_fts_insert;`);
    db.exec(`DROP TRIGGER IF EXISTS emails_fts_delete;`);
    db.exec(`DROP TRIGGER IF EXISTS emails_fts_update;`);
    db.exec(`DROP TABLE IF EXISTS emails_fts;`);
  },
};

/**
 * v28: Email Agent — behavior tracking, agent decisions, sender metrics, pipeline events
 */
export const emailAgentSchema: Migration = {
  version: 28,
  name: 'email_agent_behavior_tracking',
  up: (db) => {
    // ============================================================
    // User Action Log — every user action on email for learning
    // ============================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_action_log (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL,
        thread_id TEXT,
        action_type TEXT NOT NULL,
        action_value TEXT,
        source TEXT NOT NULL DEFAULT 'user',
        sender_address TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_action_log_email ON user_action_log(email_id);
      CREATE INDEX IF NOT EXISTS idx_action_log_type_time ON user_action_log(action_type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_action_log_sender ON user_action_log(sender_address, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_action_log_timestamp ON user_action_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_action_log_source ON user_action_log(source);
      CREATE INDEX IF NOT EXISTS idx_action_log_thread ON user_action_log(thread_id);
    `);

    // ============================================================
    // Agent Decisions — what agent proposed vs what happened
    // ============================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_decisions (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL,
        thread_id TEXT,
        sender_address TEXT,
        proposed_action TEXT NOT NULL,
        proposed_value TEXT,
        confidence REAL NOT NULL DEFAULT 0,
        reasoning TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        actual_action TEXT,
        user_feedback TEXT,
        proposed_at INTEGER NOT NULL,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_agent_decisions_status ON agent_decisions(status);
      CREATE INDEX IF NOT EXISTS idx_agent_decisions_email ON agent_decisions(email_id);
      CREATE INDEX IF NOT EXISTS idx_agent_decisions_proposed_at ON agent_decisions(proposed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_decisions_confidence ON agent_decisions(confidence DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_decisions_sender ON agent_decisions(sender_address);
    `);

    // ============================================================
    // Sender Daily Metrics — time-series engagement data
    // ============================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS sender_daily_metrics (
        id TEXT PRIMARY KEY,
        sender_email TEXT NOT NULL,
        date INTEGER NOT NULL,
        received_count INTEGER NOT NULL DEFAULT 0,
        read_count INTEGER NOT NULL DEFAULT 0,
        replied_count INTEGER NOT NULL DEFAULT 0,
        deleted_count INTEGER NOT NULL DEFAULT 0,
        archived_count INTEGER NOT NULL DEFAULT 0,
        avg_response_time_sec INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(sender_email, date)
      );

      CREATE INDEX IF NOT EXISTS idx_sender_daily_email_date ON sender_daily_metrics(sender_email, date DESC);
      CREATE INDEX IF NOT EXISTS idx_sender_daily_date ON sender_daily_metrics(date DESC);
    `);

    // ============================================================
    // Pipeline Event Log — persisted events for analysis
    // ============================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_event_log (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        email_id TEXT,
        thread_id TEXT,
        data TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_pipeline_events_type_time ON pipeline_event_log(event_type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_pipeline_events_email ON pipeline_event_log(email_id);
      CREATE INDEX IF NOT EXISTS idx_pipeline_events_timestamp ON pipeline_event_log(timestamp DESC);
    `);

    // ============================================================
    // Missing indexes on emails table for agent queries
    // ============================================================
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_emails_to_address ON emails(to_address);
      CREATE INDEX IF NOT EXISTS idx_emails_updated_at ON emails(updated_at DESC);
    `);

    logger.info('Email Agent schema (v28) applied successfully');
  },
  down: (db) => {
    db.exec(`
      DROP TABLE IF EXISTS pipeline_event_log;
      DROP TABLE IF EXISTS sender_daily_metrics;
      DROP TABLE IF EXISTS agent_decisions;
      DROP TABLE IF EXISTS user_action_log;
      DROP INDEX IF EXISTS idx_emails_to_address;
      DROP INDEX IF EXISTS idx_emails_updated_at;
    `);
  },
};

/**
 * v29: Contact classification — customer/prospect/vendor/colleague identification
 */
export const contactClassification: Migration = {
  version: 29,
  name: 'contact_classification',
  up: (db) => {
    // sender_stats is PER-ACCOUNT and stays that way — it counts what this user
    // did to a sender in this mailbox. It is widened on every database,
    // including one created after contacts moved out, so it must sit OUTSIDE
    // the directory guard below.
    addColumnIfMissing(db, 'sender_stats', 'contact_type', "TEXT DEFAULT 'unknown'");

    // The contacts half. Contacts live in the shared directory now, which is
    // created already carrying these columns; only a mailbox that still owns a
    // local table has anything to widen. See hasLocalContactsTable for why an
    // unguarded run would both alter the wrong table and then throw.
    if (!hasLocalContactsTable(db)) {
      logger.info('Contact classification (v29): contacts live in the shared directory — sender_stats only');
      return;
    }

    for (const [column, definition] of [
      ['contact_type', "TEXT DEFAULT 'unknown'"],
      ['contact_type_confidence', 'REAL DEFAULT 0'],
      ['contact_type_source', "TEXT DEFAULT 'unset'"],
      ['company', 'TEXT'],
      ['last_inbound_at', 'INTEGER'],
      ['last_outbound_at', 'INTEGER'],
      ['avg_response_time_sec', 'INTEGER'],
      ['thread_count', 'INTEGER DEFAULT 0'],
      ['needs_response', 'INTEGER DEFAULT 0'],
    ]) {
      addColumnIfMissing(db, 'contacts', column, definition);
    }

    // Index for classification queries. Schema-qualified on both sides: the
    // index name says which database it lands in, and SQLite then looks for the
    // table in that same schema.
    db.exec(`CREATE INDEX IF NOT EXISTS main.idx_contacts_type ON contacts(contact_type);`);
    db.exec(`CREATE INDEX IF NOT EXISTS main.idx_contacts_needs_response ON contacts(needs_response) WHERE needs_response = 1;`);
    db.exec(`CREATE INDEX IF NOT EXISTS main.idx_contacts_last_inbound ON contacts(last_inbound_at DESC);`);

    logger.info('Contact classification schema (v29) applied');
  },
  down: (db) => {
    // main-qualified: unqualified names resolve through the attached shared
    // directory, so an unqualified rollback of ONE mailbox would drop the
    // directory's indexes for every account.
    db.exec(`DROP INDEX IF EXISTS main.idx_contacts_type;`);
    db.exec(`DROP INDEX IF EXISTS main.idx_contacts_needs_response;`);
    db.exec(`DROP INDEX IF EXISTS main.idx_contacts_last_inbound;`);
    // SQLite <3.35 can't DROP COLUMN, columns remain
  },
};

/**
 * v30: Behavior Intelligence — indexes for multi-signal analysis + sender memory
 */
export const behaviorIntelligence: Migration = {
  version: 30,
  name: 'behavior_intelligence_indexes_and_sender_memory',
  up: (db) => {
    // Indexes for action-sequence queries (read→delete timing)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_action_log_email_time ON user_action_log(email_id, timestamp ASC);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_action_log_sender_time_asc ON user_action_log(sender_address, timestamp ASC);`);

    // Thread participation queries
    db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_thread_from ON emails(thread_id, from_address, date ASC);`);

    // Sender memory columns on sender_stats (compact: 1 value per field)
    const cols = db.prepare("PRAGMA table_info(sender_stats)").all() as { name: string }[];
    const colNames = new Set(cols.map(c => c.name));

    if (!colNames.has('greeting')) {
      db.exec(`ALTER TABLE sender_stats ADD COLUMN greeting TEXT;`);
    }
    if (!colNames.has('closing')) {
      db.exec(`ALTER TABLE sender_stats ADD COLUMN closing TEXT;`);
    }
    if (!colNames.has('tone')) {
      db.exec(`ALTER TABLE sender_stats ADD COLUMN tone TEXT;`);
    }
    if (!colNames.has('key_context')) {
      db.exec(`ALTER TABLE sender_stats ADD COLUMN key_context TEXT;`);
    }
    if (!colNames.has('memory_updated_at')) {
      db.exec(`ALTER TABLE sender_stats ADD COLUMN memory_updated_at INTEGER;`);
    }

    logger.info('Behavior Intelligence schema (v30) applied');
  },
  down: (db) => {
    db.exec(`DROP INDEX IF EXISTS idx_action_log_email_time;`);
    db.exec(`DROP INDEX IF EXISTS idx_action_log_sender_time_asc;`);
    db.exec(`DROP INDEX IF EXISTS idx_emails_thread_from;`);
  },
};

/**
 * v31: Pipeline processing status tracking on emails
 * Tracks where each email is in the two-pipeline flow:
 *   Pipeline 1: conversation extraction (extraction_status)
 *   Pipeline 2: AI agent intelligence (agent_status)
 */
export const pipelineStatusTracking: Migration = {
  version: 31,
  name: 'pipeline_status_tracking',
  up: (db) => {
    const cols = db.prepare("PRAGMA table_info(emails)").all() as { name: string }[];
    const colNames = new Set(cols.map(c => c.name));

    // Pipeline 1 status: conversation extraction
    if (!colNames.has('extraction_status')) {
      db.exec(`ALTER TABLE emails ADD COLUMN extraction_status TEXT DEFAULT 'pending';`);
    }
    if (!colNames.has('extraction_at')) {
      db.exec(`ALTER TABLE emails ADD COLUMN extraction_at INTEGER;`);
    }

    // Pipeline 2 status: AI agent (categorization + priority + relationship + memory)
    if (!colNames.has('agent_status')) {
      db.exec(`ALTER TABLE emails ADD COLUMN agent_status TEXT DEFAULT 'pending';`);
    }
    if (!colNames.has('agent_at')) {
      db.exec(`ALTER TABLE emails ADD COLUMN agent_at INTEGER;`);
    }
    if (!colNames.has('priority_score')) {
      db.exec(`ALTER TABLE emails ADD COLUMN priority_score INTEGER;`);
    }
    if (!colNames.has('priority_tier')) {
      db.exec(`ALTER TABLE emails ADD COLUMN priority_tier TEXT;`);
    }
    if (!colNames.has('priority_reasoning')) {
      db.exec(`ALTER TABLE emails ADD COLUMN priority_reasoning TEXT;`);
    }
    if (!colNames.has('recommended_action')) {
      db.exec(`ALTER TABLE emails ADD COLUMN recommended_action TEXT;`);
    }

    // Indexes for pipeline queries
    db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_extraction_status ON emails(extraction_status) WHERE extraction_status = 'pending';`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_agent_status ON emails(agent_status) WHERE agent_status = 'pending';`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_priority_score ON emails(priority_score DESC) WHERE priority_score IS NOT NULL;`);

    // Mark existing AI-processed emails as done for both pipelines
    db.exec(`UPDATE emails SET agent_status = 'done', agent_at = ai_processed_at WHERE ai_processed_at IS NOT NULL;`);

    // Mark emails with existing thread extractions as extraction done
    db.exec(`
      UPDATE emails SET extraction_status = 'done'
      WHERE thread_id IN (SELECT thread_id FROM conversation_extractions)
    `);

    logger.info('Pipeline status tracking (v31) applied');
  },
  down: (db) => {
    db.exec(`DROP INDEX IF EXISTS idx_emails_extraction_status;`);
    db.exec(`DROP INDEX IF EXISTS idx_emails_agent_status;`);
    db.exec(`DROP INDEX IF EXISTS idx_emails_priority_score;`);
  },
};

/**
 * v32: Contact Knowledge Base — per-contact notes extracted by LLM
 */
export const contactKnowledgeBase: Migration = {
  version: 32,
  name: 'contact_knowledge_base',
  up: (db) => {
    // contact_notes belongs to the shared directory, which creates it itself.
    if (!hasLocalContactsTable(db)) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS main.contact_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        note TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        source_email_id TEXT,
        confidence REAL DEFAULT 0.8,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        is_active INTEGER DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS main.idx_contact_notes_email ON contact_notes(email);
      CREATE INDEX IF NOT EXISTS main.idx_contact_notes_category ON contact_notes(email, category);
      CREATE INDEX IF NOT EXISTS main.idx_contact_notes_active ON contact_notes(email, is_active) WHERE is_active = 1;
    `);
    logger.info('Contact Knowledge Base (v32) applied');
  },
  down: (db) => {
    // main-qualified: notes live in the shared directory now, and an unqualified
    // DROP would resolve through it and delete every account's notes.
    db.exec('DROP TABLE IF EXISTS main.contact_notes;');
  },
};

/**
 * v33: Add Finance category + refine Invoice category
 */
export const financeCategory: Migration = {
  version: 33,
  name: 'finance_category',
  up: (db) => {
    // Add Finance category
    db.prepare(`
      INSERT OR IGNORE INTO ai_category_definitions (slug, name, description, prompt, icon, color, sort_order, is_system, is_enabled) VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'finance', 'Finance', 'Credit cards, bank alerts, payments, expenses',
      `TRUE if the email is about personal/business finances:
  * Credit card statements, alerts, or transactions
  * Bank account notifications (debit, credit, balance)
  * Payment confirmations (UPI, NEFT, RTGS, card payments)
  * Expense reports or reimbursements
  * EMI reminders or loan updates
  * Insurance premium notices
  * Tax-related communications (TDS, GST, ITR)
  * Salary credits or payslip notifications
  * Subscription charges (Netflix, AWS, etc.)
  * Wallet/UPI app notifications (PhonePe, GPay, Paytm)
NOT finance:
  * Invoices from vendors (that is "invoice" category)
  * Marketing emails about credit card offers
  * Spam about crypto/forex`,
      'CreditCard', 'emerald', 7, 1, 1,
    );

    // Refine Invoice to exclude general finance
    db.prepare(`
      UPDATE ai_category_definitions SET prompt = ?, description = ? WHERE slug = 'invoice'
    `).run(
      `TRUE if the email IS an invoice, bill, or receipt for products/services:
  * Invoices from vendors or service providers
  * Bills for services rendered
  * Purchase receipts and order confirmations
  * Subscription renewal invoices
  * Billing statements for services used
NOT invoice (these belong in "finance" category):
  * Credit card transactions or bank alerts
  * Payment confirmations for your own expenses
  * Salary or payslip notifications`,
      'Invoices and bills from vendors',
    );

    logger.info('Finance category (v33) applied');
  },
  down: (db) => {
    db.exec("DELETE FROM ai_category_definitions WHERE slug = 'finance'");
  },
};

/**
 * v34: Add draft_body to agent_decisions for auto-drafted replies
 */
export const agentAutoDraft: Migration = {
  version: 34,
  name: 'agent_auto_draft',
  up: (db) => {
    addColumnIfMissing(db, 'agent_decisions', 'draft_body', 'TEXT');
    addColumnIfMissing(db, 'agent_decisions', 'draft_subject', 'TEXT');
    addColumnIfMissing(db, 'agent_decisions', 'draft_reasoning', 'TEXT');
  },
  down: (_db) => {
    // SQLite can't drop columns easily — recreate would be needed, skip for down
  },
};

/**
 * v35: Remove the `waiting_reply` AI category — it overlaps with `needs_response`.
 */
export const removeWaitingReplyCategory: Migration = {
  version: 35,
  name: 'remove_waiting_reply_category',
  up: (db) => {
    db.exec("DELETE FROM ai_category_definitions WHERE slug = 'waiting_reply'");
    logger.info('Removed waiting_reply category (v35)');
  },
  down: (_db) => {
    // No rollback — tag is considered redundant.
  },
};

/**
 * v36: Add "promotions" category and tighten "needs_response" so cold sales
 * pitches (personalized outreach with a fake CTA question) stop being
 * misclassified as needing a reply.
 */
export const promotionsCategory: Migration = {
  version: 36,
  name: 'promotions_category',
  up: (db) => {
    const needsResponsePrompt = `TRUE only when the sender genuinely needs something back from the user AND
is part of an existing relationship or a transaction the user is already in.
A question in the email is NOT enough on its own — cold sales pitches also
end with questions.

TRUE when:
  * Direct question or request from a known/ongoing contact (colleague,
    existing customer, vendor the user already works with, friend, family)
  * Task, review, decision, or information request tied to work the user
    is actively doing
  * User is in the "To" field AND the email continues a conversation the
    user initiated or is actively part of
  * Personal / human message (not a template) where a reply is expected

FALSE when:
  * User is only CC'd (informational copy, almost never needs a reply)
  * Automated / no-reply senders (noreply@, donotreply@, do-not-reply@,
    notifications@, alerts@, mailer@, bounces@, support-bot@, system@)
  * Newsletters, product announcements, release notes, marketing blasts
    (these go in "promotions" category)
  * COLD SALES / PROMOTIONAL OUTREACH — even when it is personalized, even
    when it ends with a question. The question is a sales prompt, not a
    real ask. These go in the "promotions" category, NOT here.
    Strong signals (any combination = promotional):
      - Sender role is Sales / BD / Account Manager / Growth / Partner /
        Channel / Reseller / SDR / BDR / Outbound / Marketing
      - Sender company has no prior two-way correspondence with the user
      - Classic pitch structure: intro → benefits list → ask for a meeting
      - Promotional language: "special offer", "best rates", "limited time",
        "save X%", "free trial", "exclusive pricing", "discount", "promo"
      - Generic openers: "I hope this email finds you well", "hope your
        [month/week] is going great", "I wanted to reach out", "quick
        question for you"
      - Unsolicited follow-up / nag: "just following up on my previous
        email", "circling back", "bumping this", "did you get a chance to…"
      - Vague/generic ask: "Would you have 10-15 minutes?", "Open to a
        brief chat/demo?", "Are you the right person for this?", "Can I
        share a short deck?"
      - Pitches a product/service/partnership the user never requested
      - Bulk/template content (same body to many recipients, variables
        like "{firstname}" or obvious mail-merge phrasing)
  * Drip / cadence emails — if the user never replied and the sender keeps
    sending follow-ups of their own pitch, still promotional, not needs_response
  * Surveys, feedback requests, and NPS emails from vendors
  * Event / webinar / conference invitations from vendors
  * Recruiter / cold-hiring outreach unless the user is actively job hunting
  * Partnership / guest-post / link-exchange / SEO pitches`;

    const promotionsPrompt = `TRUE for any email whose primary purpose is to sell, market, or promote —
including personalized outreach that looks like a real message but is really
a pitch. Do NOT be fooled by a question at the end; cold sales always asks
for a meeting or demo.

TRUE for:
  * Cold sales outreach / prospecting — unsolicited intro from a vendor the
    user has no prior relationship with, pitching a product, service, or
    partnership
  * Follow-up / drip / cadence emails chasing a prior pitch ("just
    following up", "circling back", "bumping this", "did you get a chance")
  * Newsletters, product announcements, release notes, blog digests
  * Webinar / conference / event invitations from vendors
  * Surveys, feedback requests, NPS from vendors
  * Discount / promo / deal emails ("X% off", "limited time", "best rates")
  * Recruiter / cold-hiring outreach (unless the user is actively job hunting)
  * Partnership / guest-post / link-exchange / SEO / backlink pitches
  * Template / mass-send emails (variables, mail-merge phrasing, identical
    body sent to many recipients)
  * "Are you the right person for this?" / "Who handles X at your company?"
    type discovery emails

Strong signals (any combination → promotions):
  * Sender role: Sales / BD / Account Manager / Growth / SDR / BDR /
    Partner Manager / Channel / Reseller / Marketing
  * Pitch structure: intro → benefits list → CTA (meeting/demo/call)
  * Generic openers: "I hope this email finds you well", "hope your
    [month/week] is going great", "I wanted to reach out", "quick question"
  * Vague ask: "Would you have 10-15 minutes?", "Open to a brief chat?",
    "Can I share a short deck?"
  * Promotional phrases: "special offer", "exclusive pricing", "free trial",
    "save X%", "limited time"
  * Sender domain has no prior two-way email history with the user

FALSE for:
  * Emails from ongoing vendors about orders/invoices/support the user
    has actually transacted with (those go in invoice / needs_response)
  * Personal messages from known contacts even if they mention a product
  * Transactional confirmations (order, shipping, receipt — those are
    invoice or finance)`;

    // Tighten existing needs_response prompt
    db.prepare(
      'UPDATE ai_category_definitions SET prompt = ?, updated_at = unixepoch() WHERE slug = ?'
    ).run(needsResponsePrompt, 'needs_response');

    // Insert promotions (ignore if it already exists, e.g. from a fresh
    // schema.sql seed on a clean install that ran before migrations)
    db.prepare(
      `INSERT OR IGNORE INTO ai_category_definitions
         (slug, name, description, prompt, icon, color, sort_order, is_system, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`
    ).run(
      'promotions',
      'Promotions',
      'Sales outreach, newsletters, product marketing',
      promotionsPrompt,
      'Megaphone',
      'pink',
      8,
    );

    logger.info('Added promotions category + tightened needs_response prompt (v36)');
  },
  down: (db) => {
    db.exec("DELETE FROM ai_category_definitions WHERE slug = 'promotions'");
  },
};

/**
 * User-editable prompt templates for the AI agent.
 * Moves the categorization system prompt, reply-drafter plan prompt, and
 * reply-drafter draft prompt out of code and into the database so users
 * can tune them in Settings without a rebuild. Uses {{placeholders}} for
 * runtime variables (userName, userEmail, aliases, memory fields, etc.)
 * which are substituted by the prompt-loader at call time.
 */
export const agentPromptTemplates: Migration = {
  version: 38,
  name: 'agent_prompt_templates',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_prompt_templates (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT,
        content TEXT NOT NULL,
        default_content TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
  },
  down: (db) => {
    db.exec(`DROP TABLE IF EXISTS agent_prompt_templates;`);
  },
};

/**
 * User-authored categorization rules ("smart rules" in the Settings page).
 * Captured when the user gives a natural-language instruction about a
 * specific email ("don't mark this sender as important"). Rules are scoped
 * to a sender / domain / subject-pattern and injected into the AI
 * categorization prompt at classification time so the model respects them.
 */
export const userCategorizationRules: Migration = {
  version: 37,
  name: 'user_categorization_rules',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_categorization_rules (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('sender', 'domain', 'subject', 'thread')),
        scope_value TEXT NOT NULL,
        sender_address TEXT,
        sender_name TEXT,
        subject TEXT,
        instruction TEXT NOT NULL,
        summary TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_rules_scope_value ON user_categorization_rules(scope, scope_value) WHERE active = 1;
    `);
  },
  down: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_rules_scope_value;
      DROP TABLE IF EXISTS user_categorization_rules;
    `);
  },
};

/**
 * v39: Contact enrichment — LinkedIn/social/phone data mined from signatures,
 * individual↔company linking, and a history table for job-switch tracking.
 *
 * Design choices:
 *   - `kind` distinguishes individuals from auto-synthesized company rows.
 *   - `person_id` groups multiple contact rows (different emails, different
 *     employers over time) that the enrichment pipeline decided are the
 *     same human. Identity merge is driven by mobile_e164 overlap.
 *   - `enrichment` is a JSON blob (LinkedIn, phones, designation, socials,
 *     etc.) so we can add fields without a migration each time.
 *   - `enriched_through_email_at` is the max(email.date) scanned in the
 *     last run. Next eligibility check compares against this, NOT
 *     Date.now() — re-enrich is data-driven, not clock-driven.
 */
export const contactEnrichment: Migration = {
  version: 39,
  name: 'contact_enrichment',
  up: (db) => {
    if (!hasLocalContactsTable(db)) return; // shared directory already has these

    for (const [column, definition] of [
      ['kind', "TEXT NOT NULL DEFAULT 'individual'"],
      ['person_id', 'TEXT'],
      ['company_contact_id', 'TEXT'],
      ['mobile_e164', 'TEXT'],
      ['enrichment', 'TEXT'],
      ['enriched_through_email_at', 'INTEGER'],
      ['enrichment_source', 'TEXT'],
    ]) {
      addColumnIfMissing(db, 'contacts', column, definition);
    }

    db.exec(`CREATE INDEX IF NOT EXISTS main.idx_contacts_kind ON contacts(kind);`);
    db.exec(`CREATE INDEX IF NOT EXISTS main.idx_contacts_person_id ON contacts(person_id) WHERE person_id IS NOT NULL;`);
    db.exec(`CREATE INDEX IF NOT EXISTS main.idx_contacts_company_id ON contacts(company_contact_id) WHERE company_contact_id IS NOT NULL;`);
    db.exec(`CREATE INDEX IF NOT EXISTS main.idx_contacts_mobile ON contacts(mobile_e164) WHERE mobile_e164 IS NOT NULL;`);
    db.exec(`CREATE INDEX IF NOT EXISTS main.idx_contacts_enriched_through ON contacts(enriched_through_email_at);`);

    // Audit trail: one row per detected enrichment change. Closed rows
    // (effective_to set) are the historical record when a person moves
    // jobs; the open row is the current state.
    db.exec(`
      CREATE TABLE IF NOT EXISTS main.contact_enrichment_history (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        person_id TEXT,
        enrichment TEXT NOT NULL,
        company_contact_id TEXT,
        designation TEXT,
        organization TEXT,
        effective_from INTEGER NOT NULL,
        effective_to INTEGER,
        source TEXT NOT NULL DEFAULT 'llm',
        source_email_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS main.idx_enrichment_history_contact ON contact_enrichment_history(contact_id, effective_from DESC);
      CREATE INDEX IF NOT EXISTS main.idx_enrichment_history_person ON contact_enrichment_history(person_id) WHERE person_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS main.idx_enrichment_history_open ON contact_enrichment_history(contact_id) WHERE effective_to IS NULL;
    `);

    logger.info('Contact enrichment schema (v39) applied');
  },
  down: (db) => {
    // main-qualified: see v29/v32 -- rolling one mailbox back must never reach
    // through the ATTACHed shared directory and delete it for the others.
    db.exec('DROP TABLE IF EXISTS main.contact_enrichment_history;');
    db.exec('DROP INDEX IF EXISTS main.idx_contacts_kind;');
    db.exec('DROP INDEX IF EXISTS main.idx_contacts_person_id;');
    db.exec('DROP INDEX IF EXISTS main.idx_contacts_company_id;');
    db.exec('DROP INDEX IF EXISTS main.idx_contacts_mobile;');
    db.exec('DROP INDEX IF EXISTS main.idx_contacts_enriched_through;');
    // SQLite can't DROP COLUMN cleanly; columns stay.
  },
};

/**
 * v40 — track per-email categorization parse failures so the AI
 * service can RETRY emails the LLM dropped or returned malformed JSON
 * for. Without persistence, the in-memory retry counter resets every
 * app restart and we'd never give up on a stuck email. With it, we
 * can also surface "X emails will retry / Y gave up" in the UI.
 */
export const aiParseFailureCount: Migration = {
  version: 40,
  name: 'ai_parse_failure_count',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(emails)').all() as { name: string }[];
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has('ai_parse_failure_count')) {
      db.exec(`ALTER TABLE emails ADD COLUMN ai_parse_failure_count INTEGER NOT NULL DEFAULT 0;`);
    }
  },
};

/**
 * v41: per-sender signature markers cache.
 *
 * Chat-view's marker-based extractor (Phase 2) asks the LLM for the
 * exact text where a signature starts. We cache that text per sender
 * so subsequent emails from the same address skip the LLM call —
 * signatures are stable per sender, and a busy user with 50 frequent
 * correspondents typically drops Phase 2 LLM calls by 80%+ after the
 * first week.
 *
 * Stored on sender_stats (already keyed by email) instead of a new
 * table — keeps related per-sender knowledge in one place.
 *
 * Columns:
 *   signature_marker   the exact substring where the signature starts
 *                      (≤200 chars, plain text — we match it against
 *                      the email's plain-text projection, then cut
 *                      the HTML at the DOM element containing it).
 *   signature_marker_updated_at  when the marker was last refreshed,
 *                      so we can re-validate stale markers later.
 */
export const senderSignatureMarker: Migration = {
  version: 41,
  name: 'sender_signature_marker',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(sender_stats)').all() as { name: string }[];
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has('signature_marker')) {
      db.exec(`ALTER TABLE sender_stats ADD COLUMN signature_marker TEXT;`);
    }
    if (!has('signature_marker_updated_at')) {
      db.exec(`ALTER TABLE sender_stats ADD COLUMN signature_marker_updated_at INTEGER;`);
    }
  },
};

/**
 * Reclassify role/generic mailboxes (info@, no-reply@, sales@, hr@,
 * accounts@…) as automated and strip any PERSON identity they wrongly
 * acquired before role detection existed: a person_id (shared-phone
 * merge) and a mobile_e164 that was really a company switchboard.
 *
 * Detection uses the same isRoleAddress() the runtime now uses, so the
 * repair and prevention stay in lockstep. Never overrides a user/agent
 * contact_type; only touches NULL/'unknown'.
 */
const contactRoleReclassification: Migration = {
  version: 42,
  name: 'contact_role_reclassification',
  up: (db) => {
    // A repair pass over THIS mailbox's own contact rows. Once contacts live in
    // the shared directory every account would re-run it over the same rows, and
    // the strip is destructive (person_id and mobile_e164 to NULL) -- so it runs
    // only while the mailbox still owns the table it was written for.
    if (!hasLocalContactsTable(db)) return;
    // Guard: skip cleanly if the enrichment columns aren't present yet
    // (they arrive in v39 — which always runs first, but be defensive).
    const cols = db.prepare('PRAGMA main.table_info(contacts)').all() as { name: string }[];
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has('person_id') || !has('contact_type')) return;

    const rows = db.prepare(
      'SELECT id, email, person_id, mobile_e164, contact_type FROM main.contacts'
    ).all() as Array<{
      id: string; email: string; person_id: string | null;
      mobile_e164: string | null; contact_type: string | null;
    }>;

    const stripIdentity = db.prepare(
      'UPDATE main.contacts SET person_id = NULL, mobile_e164 = NULL, updated_at = unixepoch() WHERE id = ?'
    );
    const setAutomated = db.prepare(
      "UPDATE main.contacts SET contact_type = 'automated', contact_type_source = 'heuristic', updated_at = unixepoch() WHERE id = ?"
    );

    let stripped = 0;
    let typed = 0;
    for (const r of rows) {
      if (!isRoleAddress(r.email)) continue;
      if (r.person_id || r.mobile_e164) { stripIdentity.run(r.id); stripped++; }
      if (r.contact_type == null || r.contact_type === 'unknown') { setAutomated.run(r.id); typed++; }
    }
    logger.info(`[migration v42] role mailboxes: ${typed} typed automated, ${stripped} stripped of person identity`);
  },
};

/**
 * Re-queue emails that were tagged `needs_response` while the agent was
 * disabled (or before needs_response⟺draft were coupled) and therefore
 * never got a reply decision/draft. Resetting agent_status to 'pending'
 * lets the now-enabled pipeline draft them on its next tick. Scoped to
 * needs_response emails with no existing reply decision, so it can't
 * re-queue the whole mailbox.
 */
const requeueNeedsResponseForDrafting: Migration = {
  version: 43,
  name: 'requeue_needs_response_for_drafting',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(emails)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'agent_status')) return;
    const hasDecisions = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_decisions'"
    ).get();
    if (!hasDecisions) return;

    const res = db.prepare(`
      UPDATE emails
         SET agent_status = 'pending'
       WHERE tags LIKE '%|needs_response|%'
         AND agent_status = 'done'
         AND id NOT IN (
           SELECT email_id FROM agent_decisions
            WHERE proposed_action IN ('reply', 'reply_all')
         )
    `).run();
    logger.info(`[migration v43] re-queued ${res.changes} needs_response emails for drafting`);
  },
};

/**
 * Second pass of the needs_response re-queue (see v43). v43 ran once, but
 * emails synced afterwards in a session where the pipeline had no AI
 * provider (hasAI=false — e.g. a disconnected start before the startup
 * provider-push fix) were marked agent_status='done' with no reply
 * decision and so never drafted. Re-queue those once more now that the
 * pipeline is configured at startup. Idempotent and tightly scoped:
 * only needs_response + done + no reply decision.
 */
const requeueNeedsResponseForDraftingV2: Migration = {
  version: 44,
  name: 'requeue_needs_response_for_drafting_v2',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(emails)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'agent_status')) return;
    const hasDecisions = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_decisions'"
    ).get();
    if (!hasDecisions) return;

    const res = db.prepare(`
      UPDATE emails
         SET agent_status = 'pending'
       WHERE tags LIKE '%|needs_response|%'
         AND agent_status = 'done'
         AND id NOT IN (
           SELECT email_id FROM agent_decisions
            WHERE proposed_action IN ('reply', 'reply_all')
         )
    `).run();
    logger.info(`[migration v44] re-queued ${res.changes} needs_response emails for drafting`);
  },
};

/**
 * Index emails.in_reply_to. reattachOrphans runs
 *   SELECT DISTINCT thread_id FROM emails WHERE in_reply_to = ? AND thread_id != ?
 * once PER inserted email inside the insertEmailBatch transaction. With no
 * index on in_reply_to that's a full 11K-row scan per email (~28ms each →
 * ~2.8s per 100 new emails), all synchronous on the main process — a
 * sync-start freeze contributor. The index turns it into an index probe.
 */
const inReplyToIndex: Migration = {
  version: 45,
  name: 'in_reply_to_index',
  up: (db) => {
    db.exec('CREATE INDEX IF NOT EXISTS idx_emails_in_reply_to ON emails(in_reply_to);');
  },
};

/**
 * Attachment sizes. attachment_names historically stored just filenames (and a
 * parser bug stored the literal "SIZE"); we now also record each attachment's
 * byte size so the chat bubble can show "report.pdf · 1.4 MB". Names + sizes
 * are re-derived from the message source (mailparser) on body fetch.
 */
const attachmentSizes: Migration = {
  version: 46,
  name: 'attachment_sizes',
  up: (db) => {
    addColumnIfMissing(db, 'emails', 'attachment_sizes', 'TEXT DEFAULT NULL');
  },
};

/**
 * Clear the bogus "SIZE" filenames an earlier parser stored (values that are
 * nothing but "SIZE"/"SIZE, SIZE"). Correct names + sizes are re-derived from
 * the message source on the next body fetch. This is a SEPARATE migration from
 * attachment_sizes because that one may already have been applied (column added)
 * before this cleanup existed — a new version guarantees the cleanup runs.
 */
const clearBogusAttachmentNames: Migration = {
  version: 47,
  name: 'clear_bogus_attachment_names',
  up: (db) => {
    db.exec(`
      UPDATE emails SET attachment_names = NULL
      WHERE attachment_names IS NOT NULL
        AND REPLACE(REPLACE(attachment_names, 'SIZE', ''), ', ', '') = '';
    `);
  },
};

/**
 * Force a one-shot re-fetch of emails whose attachment filename came back as
 * the generic placeholder "attachment" (mailparser left `filename` empty). The
 * improved extractor (resolveAttachmentName) recovers the real name from the
 * part headers on the next body fetch, so clear attachment_sizes to trip the
 * `hasAttachments && !attachmentSizes` re-fetch gate. Sizes are re-derived on
 * that fetch, so it self-heals in one pass without looping.
 */
const refetchGenericAttachmentNames: Migration = {
  version: 48,
  name: 'refetch_generic_attachment_names',
  up: (db) => {
    db.exec(`
      UPDATE emails SET attachment_sizes = NULL
      WHERE attachment_names LIKE '%"attachment"%';
    `);
  },
};

/**
 * Outbox / SMTP retry queue. A send is persisted here BEFORE the SMTP submit so
 * an offline or failed send is never lost (mirrors pending_operations for IMAP).
 * Deleted on success; kept as status='failed' after maxRetries as a dead-letter.
 */
const outboxQueue: Migration = {
  version: 49,
  name: 'outbox_queue',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        last_error TEXT,
        next_retry_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
    `);
  },
};

/**
 * Dead-letter support for the IMAP operation queue: previously a non-transient
 * op was hard-deleted after maxRetries (silently dropped). These columns let the
 * queue keep it as status='failed' with the error + a backoff timestamp so it
 * can be surfaced and retried instead of vanishing.
 */
const pendingOperationsDeadLetter: Migration = {
  version: 50,
  name: 'pending_operations_dead_letter',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(pending_operations)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('last_error')) {
      db.exec('ALTER TABLE pending_operations ADD COLUMN last_error TEXT');
    }
    if (!names.has('next_retry_at')) {
      db.exec('ALTER TABLE pending_operations ADD COLUMN next_retry_at INTEGER');
    }
  },
};

/**
 * User-defined inbox filter rules ("if from X → move to Y / mark read / label").
 * conditions/actions stored as JSON arrays; evaluated at ingest.
 */
const filterRules: Migration = {
  version: 51,
  name: 'filter_rules',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS filter_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 0,
        match_type TEXT NOT NULL DEFAULT 'all',
        conditions TEXT NOT NULL DEFAULT '[]',
        actions TEXT NOT NULL DEFAULT '[]',
        stop_processing INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
    `);
  },
};

/**
 * User-defined labels (name + color). A label is applied by adding its name as
 * a tag on an email; this table is the registry of label names and colors.
 */
const labels: Migration = {
  version: 52,
  name: 'labels',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '#2563eb',
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
    `);
  },
};

/**
 * Calendar invite (iCalendar / .ics) raw text. When an email carries a
 * `text/calendar` part or a `.ics` attachment, the invite's raw ICS is captured
 * on body-fetch and stored here so the detail view can render a Gmail-style
 * "event card" (time/title/location/organizer) without re-downloading or
 * re-fetching from IMAP. Small by nature (a few KB); null for non-invite mail.
 */
const calendarIcs: Migration = {
  version: 53,
  name: 'calendar_ics',
  up: (db) => {
    addColumnIfMissing(db, 'emails', 'calendar_ics', 'TEXT DEFAULT NULL');
  },
};

/**
 * Marks that the user added this email's calendar invite to their OS calendar
 * (clicked "Add to calendar"). Persisted per-account so the banner's "Added"
 * state survives reopening the mail and app restarts. 0 = not added, 1 = added.
 */
const calendarAdded: Migration = {
  version: 54,
  name: 'calendar_added',
  up: (db) => {
    addColumnIfMissing(db, 'emails', 'calendar_added', 'INTEGER DEFAULT 0');
  },
};

/**
 * v55: Durable Sent-folder APPEND markers on the outbox row.
 *
 * After SMTP accepts a message we must upload a copy to the IMAP Sent folder —
 * generic IMAP/SMTP servers (e.g. sarv.com) do NOT auto-file SMTP submissions
 * the way Gmail does, so without this the sent message exists only as a local
 * SQLite row and is lost on reinstall / another device. To survive a crash
 * between SMTP-accept and the APPEND, we persist the raw MIME + a marker on the
 * pending_sends row BEFORE deleting it on send success:
 *   smtp_accepted        1 once SMTP accepted → a restart must NOT re-send.
 *   sent_append_pending  1 while a Sent APPEND still needs to run.
 *   raw_mime             the exact MIME submitted to SMTP (reused for the APPEND
 *                        so the Message-ID matches — no rebuild/drift).
 *   sent_message_id      the message's Message-ID (for reconcile + dedupe).
 * All columns are nullable / defaulted, so the ALTERs are safe on existing rows.
 */
const sentAppendDurability: Migration = {
  version: 55,
  name: 'sent_append_durability',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(pending_sends)').all() as Array<{ name: string }>;
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has('smtp_accepted')) db.exec('ALTER TABLE pending_sends ADD COLUMN smtp_accepted INTEGER DEFAULT 0;');
    if (!has('sent_append_pending')) db.exec('ALTER TABLE pending_sends ADD COLUMN sent_append_pending INTEGER DEFAULT 0;');
    if (!has('raw_mime')) db.exec('ALTER TABLE pending_sends ADD COLUMN raw_mime TEXT;');
    if (!has('sent_message_id')) db.exec('ALTER TABLE pending_sends ADD COLUMN sent_message_id TEXT;');
  },
};

/**
 * v56: Guarantee the CONDSTORE sync-state columns exist on the folders table.
 *
 * `uid_validity` and `highest_modseq` live in the current schema.sql (fresh
 * installs get them), but a DB created before those columns were added to the
 * schema would lack them. The folder-list sync UPSERT now writes BOTH as named
 * columns, so a missing column would throw "no such column" on every sync for
 * such an upgrader. This idempotent guard adds whichever is absent and is a
 * no-op on any DB that already has them (fresh installs, restructured DBs).
 * Both are nullable INTEGERs, so the ALTERs are safe on existing rows.
 */
const folderCondstoreColumns: Migration = {
  version: 56,
  name: 'folder_condstore_columns',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(folders)').all() as Array<{ name: string }>;
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has('uid_validity')) db.exec('ALTER TABLE folders ADD COLUMN uid_validity INTEGER;');
    if (!has('highest_modseq')) db.exec('ALTER TABLE folders ADD COLUMN highest_modseq INTEGER;');
  },
};

/**
 * Gate the FTS5 re-index trigger so it only fires when a search-relevant column
 * actually changes. The original `emails_fts_update` (migration 27) fired on
 * EVERY row update and re-tokenized the whole `clean_body` into FTS5 — so a
 * tags-only change (mark read/unread, star, move) paid a full-body re-index per
 * row. Recreate it with a WHEN guard on the indexed columns (`IS NOT` handles
 * NULLs), so flag flips skip FTS entirely. This is the dominant per-row cost of
 * bulk mark-read.
 */
const ftsUpdateTriggerGate: Migration = {
  version: 57,
  name: 'gate_fts_update_trigger_to_content_changes',
  up: (db) => {
    // Only meaningful if the FTS table/trigger exist (they do from migration 27).
    const hasFts = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='emails_fts'")
      .get();
    if (!hasFts) return;
    db.exec('DROP TRIGGER IF EXISTS emails_fts_update;');
    db.exec(`
      CREATE TRIGGER emails_fts_update AFTER UPDATE ON emails
      WHEN new.subject IS NOT old.subject
        OR new.from_address IS NOT old.from_address
        OR new.from_name IS NOT old.from_name
        OR new.to_address IS NOT old.to_address
        OR new.cc_address IS NOT old.cc_address
        OR new.attachment_names IS NOT old.attachment_names
        OR new.clean_body IS NOT old.clean_body
      BEGIN
        DELETE FROM emails_fts WHERE email_id = old.id;
        INSERT INTO emails_fts(email_id, subject, from_address, from_name, to_address, cc_address, attachment_names, clean_body)
        VALUES (new.id, new.subject, new.from_address, new.from_name, new.to_address, new.cc_address, new.attachment_names, new.clean_body);
      END;
    `);
  },
};


/**
 * Watermark for the deterministic phone scan.
 *
 * Without it every scan re-reads every contact's mail from scratch — the whole
 * cost is paid again to rediscover numbers that have not changed. Storing the
 * newest email date the miner has already seen lets a later scan skip any
 * contact with no newer mail, which is nearly all of them after the first run.
 *
 * Deliberately NOT `updated_at`: that is touched by enrichment and by the scan's
 * own contact extraction, so by the time mining runs it always reads as "just
 * now" and would skip everything, including on a first scan.
 */
const contactPhonesMinedWatermark: Migration = {
  version: 58,
  name: 'contact_phones_mined_watermark',
  up: (db) => {
    if (!hasLocalContactsTable(db)) return; // shared directory already has these
    addColumnIfMissing(db, 'contacts', 'phones_mined_through', 'INTEGER');
    // The mined result itself, as JSON {e164: count}. Skipping a contact saves
    // the CPU of re-reading their mail, but the classifier still needs their
    // numbers to judge the DOMAIN — a switchboard is only identifiable by how
    // many colleagues carry it. Without this, an incremental scan would compute
    // org lines from whichever handful of contacts happened to change.
    addColumnIfMissing(db, 'contacts', 'phones_mined', 'TEXT');
  },
};

/**
 * Historical-backfill progress columns on `folders`.
 *
 * The background backfill pages older mail DOWNWARD by UID; it persists the
 * lowest UID reached (`backfill_oldest_uid`, the exclusive floor for the next
 * chunk) so it resumes across restarts, and flips `backfill_complete` once paging
 * reaches the bottom. Guarded PRAGMA check so it's a no-op on fresh installs that
 * already have the columns from schema.sql.
 */
const folderBackfillColumns: Migration = {
  version: 59,
  name: 'folder_backfill_columns',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(folders)').all() as Array<{ name: string }>;
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has('backfill_oldest_uid')) {
      db.exec('ALTER TABLE folders ADD COLUMN backfill_oldest_uid INTEGER;');
    }
    if (!has('backfill_complete')) {
      db.exec('ALTER TABLE folders ADD COLUMN backfill_complete INTEGER NOT NULL DEFAULT 0;');
    }
  },
};

/**
 * Per-email tracking of whether the AI category has been mirrored to the
 * connected account as a LABEL. Categorization used to fire label-mirroring as a
 * fire-and-forget side-effect; if the account's engine was disconnected at that
 * instant (background account / restart burst) the label was silently dropped
 * and — because the mail was then stamped agent_status='done' — never retried.
 * `label_status` records the intent durably so the pipeline poll can drain it:
 *   NULL      = legacy / untracked (only the recent INBOX window is caught up)
 *   'pending' = categorized, connected-account label not yet applied
 *   'done'    = label durably enqueued/applied
 */
export const emailLabelStatus: Migration = {
  version: 60,
  name: 'email_label_status',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(emails)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'label_status')) {
      db.exec('ALTER TABLE emails ADD COLUMN label_status TEXT;');
    }
    // Partial index: the steady-state drain query only ever looks for 'pending'.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_label_status ON emails(label_status) WHERE label_status = 'pending';`);
    logger.info('Email label_status tracking (v60) applied');
  },
  down: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_emails_label_status;');
  },
};

/**
 * Store per-op failure diagnostics so the Outbox "Failed actions" list can show
 * the user WHAT command we sent and WHAT the server replied — not just a
 * flattened error string. `attempted_command` = the IMAP command we issued;
 * `server_response` = the tagged NO/BAD reply text (both NULL for a pure
 * connection failure, where the message alone tells the story).
 */
export const pendingOperationFailureDetail: Migration = {
  version: 61,
  name: 'pending_operation_failure_detail',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(pending_operations)').all() as Array<{ name: string }>;
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has('attempted_command')) db.exec('ALTER TABLE pending_operations ADD COLUMN attempted_command TEXT;');
    if (!has('server_response')) db.exec('ALTER TABLE pending_operations ADD COLUMN server_response TEXT;');
  },
  down: () => { /* columns are additive; nothing to undo */ },
};

/**
 * One-time drift repair. Before category-label mirroring reconciled REMOVALS and
 * covered the bulk/propagation write paths, the connected account's labels drifted
 * from the app's categories — stale "Sarv Inbox/*" labels lingered after a category
 * was removed, and bulk/propagated mail was often never labeled at all. Re-mark the
 * most-recent categorized window 'pending' so the Phase-3 label drain reconciles
 * them ONCE (apply current + strip stale). Bounded to the recent window (NOT all
 * history) for Gmail-rate safety; the drain is idempotent, so re-touching an
 * already-correct mail is a cheap no-op. No effect on a fresh DB (nothing
 * categorized yet at migration time).
 */
export const reconcileLabelDrift: Migration = {
  version: 62,
  name: 'reconcile_label_drift',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(emails)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'label_status')) return; // needs v60
    db.exec(`
      UPDATE emails SET label_status = 'pending'
      WHERE agent_status = 'done'
        AND id IN (SELECT id FROM emails WHERE agent_status = 'done' ORDER BY date DESC LIMIT 500);
    `);
    logger.info('Label-drift reconcile (v62): re-marked recent categorized mail pending for one-time re-mirror');
  },
  down: () => { /* data-only repair; nothing to undo */ },
};

/**
 * v63 — confirm-gated contact avatars. `avatar_url` (existing) holds the cached
 * photo (a data: URI); `avatar_status` gates whether it's shown:
 *   null/absent → never checked · 'pending' → a candidate awaits user review
 *   'confirmed' → user approved, show it · 'rejected' → user declined, keep initials.
 * `avatar_checked_at` throttles the background discovery so we don't refetch.
 */
export const contactAvatarConfirmation: Migration = {
  version: 63,
  name: 'contact_avatar_confirmation',
  up: (db) => {
    if (!hasLocalContactsTable(db)) return; // shared directory already has these
    addColumnIfMissing(db, 'contacts', 'avatar_status', 'TEXT');
    addColumnIfMissing(db, 'contacts', 'avatar_checked_at', 'INTEGER');
  },
  down: () => { /* additive columns; nothing to undo */ },
};

/**
 * v64 — read-model foundation (see docs/READ_MODEL_PLAN.md). Adds the
 * denormalized thread state columns + the per-(folder,thread) materialized index
 * and per-category membership tables so list queries become flat indexed scans
 * instead of GROUP BY + correlated EXISTS. Purely additive: no data is written
 * here — the chunked backfill (a separate runner) populates these, and reads keep
 * using the legacy path until backfill marks `read_model_state.status='complete'`.
 */
export const readModelFoundation: Migration = {
  version: 64,
  name: 'read_model_foundation',
  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(threads)').all() as { name: string }[];
    const have = new Set(cols.map((c) => c.name));
    const add = (name: string, ddl: string) => {
      if (!have.has(name)) db.exec(`ALTER TABLE threads ADD COLUMN ${ddl};`);
    };
    // ADD COLUMN is O(1) metadata in SQLite — no table rewrite even on huge DBs.
    add('has_important', 'has_important INTEGER NOT NULL DEFAULT 0');
    add('has_important_unread', 'has_important_unread INTEGER NOT NULL DEFAULT 0');
    add('has_attachment', 'has_attachment INTEGER NOT NULL DEFAULT 0');
    add('has_draft', 'has_draft INTEGER NOT NULL DEFAULT 0');
    add('has_category', 'has_category INTEGER NOT NULL DEFAULT 0');
    add('max_priority_score', 'max_priority_score INTEGER NOT NULL DEFAULT 0');
    add('first_sender', 'first_sender TEXT');
    add('last_sender', 'last_sender TEXT');
    add('live_message_count', 'live_message_count INTEGER NOT NULL DEFAULT 0');
    add('state_version', 'state_version INTEGER NOT NULL DEFAULT 0');

    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_folders (
        folder_id            TEXT    NOT NULL,
        thread_id            TEXT    NOT NULL,
        last_message_date    INTEGER NOT NULL,
        max_priority_score   INTEGER NOT NULL DEFAULT 0,
        has_unread           INTEGER NOT NULL DEFAULT 0,
        has_important        INTEGER NOT NULL DEFAULT 0,
        has_important_unread INTEGER NOT NULL DEFAULT 0,
        has_flagged          INTEGER NOT NULL DEFAULT 0,
        has_attachment       INTEGER NOT NULL DEFAULT 0,
        has_draft            INTEGER NOT NULL DEFAULT 0,
        has_category         INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (folder_id, thread_id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS thread_categories (
        thread_id TEXT NOT NULL,
        slug      TEXT NOT NULL,
        PRIMARY KEY (thread_id, slug)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS read_model_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tf_list
        ON thread_folders(folder_id, last_message_date DESC, thread_id DESC);
      CREATE INDEX IF NOT EXISTS idx_tf_priority
        ON thread_folders(folder_id, max_priority_score DESC, last_message_date DESC, thread_id DESC);
      CREATE INDEX IF NOT EXISTS idx_tf_unread
        ON thread_folders(folder_id, last_message_date DESC, thread_id DESC) WHERE has_unread = 1;
      CREATE INDEX IF NOT EXISTS idx_tf_unlabelled
        ON thread_folders(folder_id, last_message_date DESC, thread_id DESC) WHERE has_category = 0;
      CREATE INDEX IF NOT EXISTS idx_tc_slug ON thread_categories(slug, thread_id);
    `);

    // Signal the backfill runner that this DB needs populating (unless a prior
    // run already finished). Reads stay on the legacy path until 'complete'.
    const row = db.prepare(`SELECT value FROM read_model_state WHERE key = 'status'`).get() as { value: string } | undefined;
    if (row?.value !== 'complete') {
      db.prepare(`INSERT INTO read_model_state (key, value) VALUES ('status', 'pending')
                  ON CONFLICT(key) DO UPDATE SET value = 'pending'`).run();
    }
    logger.info('Read-model foundation (v64): thread rollup columns + thread_folders/thread_categories ready; backfill pending');
  },
  down: () => { /* additive schema; nothing to undo */ },
};

/**
 * v65 — read-model dirty queue + triggers (see docs/READ_MODEL_PLAN.md). Any
 * write to `emails` records the affected thread_id in read_model_dirty; the TS
 * ReadModelMaintainer drains it. Trigger-based so EVERY write path is captured
 * (repo methods AND ad-hoc `UPDATE emails SET tags`) with no derivation in SQL.
 * The queue doubles as the resumable backfill cursor.
 */
export const readModelDirtyQueue: Migration = {
  version: 65,
  name: 'read_model_dirty_queue',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS read_model_dirty (
        thread_id TEXT PRIMARY KEY
      ) WITHOUT ROWID;

      CREATE TRIGGER IF NOT EXISTS trg_emails_rm_dirty_insert
      AFTER INSERT ON emails BEGIN
        INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (NEW.thread_id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_emails_rm_dirty_update
      AFTER UPDATE OF tags, folder_id, has_attachments, priority_score, date, thread_id ON emails BEGIN
        INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (NEW.thread_id);
        INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (OLD.thread_id);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_emails_rm_dirty_delete
      AFTER DELETE ON emails BEGIN
        INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (OLD.thread_id);
      END;
    `);
    logger.info('Read-model dirty queue (v65): triggers installed; maintainer will seed + drain');
  },
  down: () => { /* additive; nothing to undo */ },
};

/**
 * v66 — user labels can be mirrored to the mail server (opt-in per label), so
 * add a `synced_to_server` flag to the labels table.
 */
export const userLabelServerSync: Migration = {
  version: 66,
  name: 'user_label_server_sync',
  up: (db) => {
    const cols = new Set((db.prepare('PRAGMA table_info(labels)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('synced_to_server')) {
      db.exec('ALTER TABLE labels ADD COLUMN synced_to_server INTEGER NOT NULL DEFAULT 0;');
    }
    logger.info('User-label server sync (v66): labels.synced_to_server added');
  },
  down: () => { /* additive; nothing to undo */ },
};

/**
 * v67 — per-account "always load images from this sender" allowlist. Populated
 * when the user clicks "Load images" on a blocked message.
 */
export const imageAllowedSenders: Migration = {
  version: 67,
  name: 'image_allowed_senders',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS image_allowed_senders (
        email TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    logger.info('Image-allowed senders (v67): image_allowed_senders table created');
  },
  down: () => { /* additive; nothing to undo */ },
};

/**
 * v68 — per-folder sync policy. `sync_enabled` (default on) lets the user stop
 * syncing a folder entirely — the key lever for heavy accounts. `sync_mode`
 * (NULL = use the global setting; 'full' | 'headers') overrides body-download per
 * folder. `keep_days` (NULL = unlimited) is reserved for a future retention prune.
 */
export const folderSyncPolicy: Migration = {
  version: 68,
  name: 'folder_sync_policy',
  up: (db) => {
    addColumnIfMissing(db, 'folders', 'sync_enabled', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing(db, 'folders', 'sync_mode', 'TEXT DEFAULT NULL');
    addColumnIfMissing(db, 'folders', 'keep_days', 'INTEGER DEFAULT NULL');
    logger.info('Folder sync policy (v68): folders.sync_enabled/sync_mode/keep_days added');
  },
  down: () => { /* additive; nothing to undo */ },
};

/**
 * v69: per-email counter of ATTEMPTED-and-failed categorizations.
 *
 * Distinct from `ai_parse_failure_count`, which counts "the LLM answered but
 * this email's entry was unusable". This one counts "the call itself threw" —
 * the path that had no give-up at all, so a permanently doomed email (a body
 * the provider always rejects, a message that always trips a content filter)
 * stayed agent_status='pending' forever and held the progress bar below 100%.
 *
 * Persisted rather than in-memory for the same reason as the parse counter: an
 * in-memory count resets on every restart, and the app restarts often enough
 * that a doomed email would never accumulate enough strikes to be given up on.
 */
export const aiAgentFailureCount: Migration = {
  version: 69,
  name: 'ai_agent_failure_count',
  up: (db) => {
    addColumnIfMissing(db, 'emails', 'ai_agent_failure_count', 'INTEGER NOT NULL DEFAULT 0');
    logger.info('Agent failure counter (v69): emails.ai_agent_failure_count added');
  },
  down: () => { /* additive; nothing to undo */ },
};

/**
 * v70: `email_thread_keys` — the index that turns the thread-resolver's subject
 * fallback from a full table scan into a SEEK.
 *
 * This is the single worst query in the app. `resolveThreadId`'s Path 3 looked
 * for same-subject candidates with:
 *
 *   WHERE id != ? AND ABS(date - ?) <= ? AND LOWER(subject) LIKE '%norm%'
 *   ORDER BY ABS(date - ?) LIMIT 50
 *
 * Every clause defeats indexing — a function on the column, a leading wildcard,
 * an expression comparison, and an expression sort — and there was no index on
 * `subject` at all. So it scanned EVERY row, and it runs once per email: at
 * insert time (making a first sync O(n^2)) and once per email per iteration of
 * `repairThreading`. Profiled 2026-08-26 on a 26,184-email mailbox: 94.5% of
 * all main-thread JS time was this one statement, ~685M row visits per repair
 * iteration, producing a 25-second UI freeze every 30 seconds for as long as
 * the repair ran — and starving the IMAP sockets enough to look like body-fetch
 * timeouts and connection-pool corruption.
 *
 * The key is `normalizeSubject(subject)` — the same value the resolver already
 * compared in JS after the scan ("Re: Foo", "AW: Foo" and "Foo" all normalise
 * to "foo"). Stored in its OWN narrow table rather than as a column on `emails`,
 * because `emails` holds the bodies inline: adding a column there and
 * backfilling it rewrites every spilled record. Measured on the same mailbox —
 * still running after 5 minutes at 100% CPU with a 700 MB WAL and growing, i.e.
 * a worse freeze than the one being fixed. Writing 26k narrow rows instead takes
 * a moment. See src/thread-keys.ts for the whole argument.
 *
 * `created_at` is backfilled as 0 deliberately: it drives the incremental repair
 * window, and every row that exists at migration time is by definition older
 * than any future window. Copying the real `emails.created_at` would mean
 * reading a late-ALTER column that lives out in the overflow pages — the
 * multi-GB read this migration exists to avoid.
 */
export const emailThreadKeys: Migration = {
  version: 70,
  name: 'email_thread_keys',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_thread_keys (
        email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
        subject_norm TEXT NOT NULL,
        date INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    // Equality column first, then date: the resolver looks up one normalised
    // subject and narrows by a date window, so the same index serves both.
    db.exec('CREATE INDEX IF NOT EXISTS idx_email_thread_keys_lookup ON email_thread_keys(subject_norm, date);');
    // Lets the incremental repair ask "anything stored since the last pass?" —
    // by far the most common case, every 10 minutes forever — without a scan.
    db.exec('CREATE INDEX IF NOT EXISTS idx_email_thread_keys_created_at ON email_thread_keys(created_at);');

    // Only `subject` and `date` are read, and both sit BEFORE the bodies in the
    // record, so this walks the table's leaf pages without following any
    // overflow chain. The LEFT JOIN makes it resumable: a launch interrupted
    // part-way picks up exactly where it stopped instead of starting over.
    const pending = db
      .prepare(`SELECT e.id, e.subject, e.date
                FROM emails e
                LEFT JOIN email_thread_keys k ON k.email_id = e.id
                WHERE k.email_id IS NULL`)
      .all() as Array<{ id: string; subject: string | null; date: number }>;
    if (pending.length > 0) {
      const insert = db.prepare(
        'INSERT INTO email_thread_keys (email_id, subject_norm, date, created_at) VALUES (?, ?, ?, 0)',
      );
      db.transaction(() => {
        for (const row of pending) {
          insert.run(row.id, normalizeSubject(row.subject || ''), row.date);
        }
      })();
    }

    logger.info(`Thread keys (v70): email_thread_keys created, ${pending.length} row(s) backfilled`);
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS email_thread_keys;');
  },
};

/**
 * v71: an expression index on `LOWER(from_address)` — the second-worst query in
 * the app, and the one left standing after v70.
 *
 * Every sender lookup in the codebase is case-folded, because addresses arrive
 * in whatever case the sending server used:
 *
 *   INNER JOIN emails e ON LOWER(e.from_address) = LOWER(c.email)
 *   WHERE LOWER(from_address) = LOWER(?)
 *
 * `idx_emails_from_address` cannot serve either — a function on the column
 * defeats it — so the contact-enrichment candidate join fell back to scanning
 * every email once per contact. Profiled 2026-08-26 on a 26,184-email mailbox:
 * 2,222.9ms of blocked main thread per call, and the enrichment scheduler
 * re-runs it 3 seconds after every batch ack, so a rotation meant a 2-second
 * freeze every few seconds. With the index available the same query measured
 * 3.4ms.
 *
 * `date` is the second column so "newest mail from this sender" (the enrichment
 * join's `MAX(e.date)`, the contact activity queries) stays index-only. That
 * matters more than it looks: `emails` carries the bodies inline, so any query
 * that has to visit the row walks the overflow chain.
 *
 * Building it reads only `from_address`, which sits BEFORE the bodies in the
 * record — the index build stays on the table's leaf pages, unlike the
 * late-ALTER-column rewrite v70's header describes.
 */
export const emailsFromAddressLowerIndex: Migration = {
  version: 71,
  name: 'emails_from_address_lower_index',
  up: (db) => {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_emails_from_lower_date ON emails(LOWER(from_address), date);',
    );
    logger.info('Sender index (v71): idx_emails_from_lower_date created');
  },
  down: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_emails_from_lower_date;');
  },
};

/**
 * v72: Body-length columns + covering indexes for the AI pipeline.
 *
 * `clean_body`/`raw_body` are stored inline in `emails` and average ~330 KB on a
 * real mailbox, so every column added by a later `ALTER TABLE` — which is all of
 * `extraction_status`, `agent_status`, `label_status`, `ai_parse_failure_count` —
 * sits BEHIND the bodies in the record and can only be reached by walking that
 * row's overflow chain. Measured 2026-08-27 against this schema's column order at
 * the live mailbox's body sizes: a `COUNT(*)` on `extraction_status` cost 426 ms
 * where the same predicate on `uid` (ahead of the bodies) cost 4 ms, and the full
 * eligibility clause cost 474 ms. See `body-metrics.ts` for the full numbers.
 *
 * Two integers plus indexes that CONTAIN them let those queries be answered
 * without visiting the row at all: 426 ms -> under 1 ms, `SEARCH … USING
 * COVERING INDEX`, with zero data movement.
 *
 * That covering win lands on the COUNTERS — the poll's backlog figures and
 * `getPipelineStats`, which is what the profiler named, and which now plans as
 * `SCAN emails USING COVERING INDEX idx_emails_agent_pipeline`. The row
 * SELECTORS still open records: they project `id`/`uid`/`folder_id`, which no
 * index here carries, so they pay the overflow walk for the length columns too —
 * just a two-integer read instead of materializing and TRIM-ing two multi-KB
 * strings, and only for the LIMIT-bounded batch they actually return. Verified
 * with EXPLAIN QUERY PLAN both on an empty DB and on 4k rows after ANALYZE.
 * Moving the bodies out of `emails` (phase 2) is the categorical fix; this
 * migration deliberately moves no data.
 *
 * The columns are left NULL here ON PURPOSE. Computing them requires reading
 * every body, which on an 8.3 GB table is minutes of blocking work — never
 * acceptable on the startup path a migration runs on. `BodyStorageBackfill`
 * fills them in the background on a time budget, and until it proves no NULL
 * remains, `hasBodyClause` keeps emitting the original body-reading expression.
 * A NULL must never read as "no body": that would drop the row out of AI
 * eligibility, and mail that quietly stops being categorized is invisible for
 * days.
 */
export const emailBodyLengthColumns: Migration = {
  version: 72,
  name: 'email_body_length_columns',
  up: (db) => {
    const colNames = new Set(
      (db.prepare('PRAGMA table_info(emails)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!colNames.has('clean_body_len')) {
      db.exec('ALTER TABLE emails ADD COLUMN clean_body_len INTEGER;');
    }
    if (!colNames.has('raw_body_len')) {
      db.exec('ALTER TABLE emails ADD COLUMN raw_body_len INTEGER;');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS email_body_metrics_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // '0', not absent: an absent key and a '0' key mean the same thing to
    // areBodyLengthsReady, but seeding it makes the state visible to anyone
    // inspecting the DB.
    db.prepare(
      "INSERT INTO email_body_metrics_state(key, value) VALUES ('lengths_backfilled', '0') " +
        'ON CONFLICT(key) DO NOTHING',
    ).run();

    // Drains to empty as the backfill progresses, so it costs nothing in steady
    // state — and makes both "give me the next batch" and "is anything left?"
    // index seeks instead of scans of a multi-GB table.
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_emails_body_len_pending ON emails(id) WHERE clean_body_len IS NULL;',
    );

    // Covering indexes for the two pipeline gates. Every column either clause
    // mentions has to be IN the index: SQLite decides coverage from the columns
    // a query mentions, not the ones it ends up reading, so one stray reference
    // to a body column would put the overflow walk straight back.
    //
    // `date` sits at position 2, ahead of `extraction_status`, and that order is
    // load-bearing for a query this index does NOT serve: the legacy
    // label-backlog drain filters `agent_status = 'done' AND date >= ?` and
    // orders by date, never mentioning extraction_status. Once this index
    // exists SQLite prefers it over idx_emails_date — and with
    // extraction_status in between, the date range and the ORDER BY both become
    // unusable (a TEMP B-TREE over every done row, records visited, which is the
    // overflow walk the profiler already caught once). With date second, that
    // drain gets an equality+range seek with free ordering, and the eligibility
    // clauses still get a fully covering seek: they bind agent_status and date,
    // and extraction_status is filtered from the index entry either way.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_emails_agent_pipeline
        ON emails(agent_status, date, extraction_status, clean_body_len, raw_body_len, tags);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_emails_extraction_pipeline
        ON emails(extraction_status, date, clean_body_len, raw_body_len);
    `);

    // Widening idx_emails_agent_pipeline has a second victim, and this one the
    // planner walks into on its own: the deferred label drain
    // (`label_status = 'pending' AND agent_status = 'done' ORDER BY date DESC`)
    // used to seek the tiny partial index below, which is EMPTY in steady state.
    // With `date` reachable through the new index, SQLite prefers it to avoid a
    // sort — and then has to open every `agent_status='done'` record to read
    // `label_status`, because that column is not in it. Teaching the partial
    // index the other two columns makes it strictly better on every count
    // (drained-empty seek, equality on agent_status, ordering for free), so the
    // planner picks it again. Recreated rather than IF-NOT-EXISTS'd: v60 already
    // made the single-column version.
    db.exec('DROP INDEX IF EXISTS idx_emails_label_status;');
    db.exec(
      "CREATE INDEX idx_emails_label_status ON emails(label_status, agent_status, date) " +
        "WHERE label_status = 'pending';",
    );

    logger.info('Body metrics (v72): length columns + covering indexes created (backfill runs in background)');
  },
  down: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_emails_extraction_pipeline;');
    db.exec('DROP INDEX IF EXISTS idx_emails_agent_pipeline;');
    db.exec('DROP INDEX IF EXISTS idx_emails_body_len_pending;');
    // Put the label partial index back in its v60 shape, so a down/up cycle
    // lands on the same schema either way round.
    db.exec('DROP INDEX IF EXISTS idx_emails_label_status;');
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_emails_label_status ON emails(label_status) " +
        "WHERE label_status = 'pending';",
    );
    db.exec('DROP TABLE IF EXISTS email_body_metrics_state;');
    // The columns themselves are left in place: SQLite's DROP COLUMN rewrites
    // the whole table, which is the multi-GB operation this migration exists to
    // avoid, and two spare integers cost nothing.
  },
};

/**
 * v73: move the bodies out of `emails` into the `email_bodies` side table.
 *
 * The reasoning, the measurements and the read/write contract are all in
 * `repositories/body-storage.ts` — read that first. This migration only builds
 * the destination and re-points the search index at it; NO body is moved here.
 * Moving 8.3 GB is minutes of blocking work, and a migration runs on the startup
 * path, so `BodyStorageBackfill` does it in background slices.
 *
 * ## The trigger relocation is the dangerous part
 *
 * FTS5 is maintained by triggers that read `new.clean_body` ON emails. Once the
 * body stops arriving through that column those triggers still fire, still
 * succeed, and index an empty body — so mail keeps arriving, keeps listing,
 * keeps opening, and quietly stops being FINDABLE. Nobody notices for days, and
 * the only repair is a full re-index. So the triggers are recreated here to read
 * through `email_bodies`, and three more are added ON email_bodies so a body
 * written or changed after its header row still re-indexes.
 *
 * ## Why the triggers carry WHEN guards
 *
 * Relocating a row does not change its body — it changes where the body is
 * stored. Without guards the relocation pass would re-tokenize the whole
 * mailbox TWICE (once when the side row appears, once when the inline column is
 * nulled), which on a 26k-mailbox is far more work than the move itself. Each
 * guard therefore tests whether the EFFECTIVE body changed:
 *
 *  - ON emails: only when no side row exists yet, because if one does it is
 *    already the effective body and nulling the inline column changes nothing.
 *  - ON email_bodies INSERT: only when the arriving body differs from the inline
 *    column it is replacing, which is false for every relocated row and true for
 *    every genuinely new body.
 */
export const emailBodiesSideTable: Migration = {
  version: 73,
  name: 'email_bodies_side_table',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_bodies (
        email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
        clean_body TEXT,
        raw_body TEXT
      );
    `);

    // '0', not absent, for the same reason as the length key: it makes the state
    // visible to anyone inspecting the DB.
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_body_metrics_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO email_body_metrics_state(key, value) VALUES ('bodies_relocated', '0') " +
        'ON CONFLICT(key) DO NOTHING',
    ).run();

    // The relocation cursor: rows that still hold an inline body worth moving.
    // Drains to empty as the backfill progresses, so "give me the next batch" and
    // "is anything left?" are both seeks of an eventually-empty index rather than
    // scans of a multi-GB table.
    //
    // Non-empty, not merely non-NULL. A header-only row — synced but whose body
    // has not been fetched yet — carries `''` in both columns, and there are a lot
    // of them: relocating those would write a side row per email holding two
    // empty strings, which is pure overhead and would keep the cursor churning
    // over rows that have nothing to move. `''` occupies no overflow page, so
    // leaving it inline costs nothing and reads back identically through the
    // COALESCE in body-storage.ts.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_emails_body_inline_pending ON emails(id)
        WHERE (clean_body IS NOT NULL AND clean_body <> '')
           OR (raw_body IS NOT NULL AND raw_body <> '');
    `);

    const hasFts = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='emails_fts'")
      .get();
    if (!hasFts) {
      logger.info('Email bodies (v73): side table created (no FTS table on this DB)');
      return;
    }

    // Every trigger comes from fts-schema.ts, which SearchRepository also uses,
    // so the runtime bootstrap can never recreate an older shape behind this
    // migration's back.
    applyFtsSchema(db);

    logger.info('Email bodies (v73): side table + relocated FTS triggers created (move runs in background)');
  },
  down: (db) => {
    for (const [name] of FTS_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name};`);
    db.exec('DROP INDEX IF EXISTS idx_emails_body_inline_pending;');

    // Put every body back inline before the table goes, or the down migration is
    // data loss. Rows whose body was never relocated already have it inline and
    // must not be overwritten with the side table's copy.
    const hasBodies = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_bodies'")
      .get();
    if (hasBodies) {
      db.exec(`
        UPDATE emails SET
          clean_body = COALESCE((SELECT b.clean_body FROM email_bodies b WHERE b.email_id = emails.id), clean_body),
          raw_body = COALESCE((SELECT b.raw_body FROM email_bodies b WHERE b.email_id = emails.id), raw_body)
        WHERE EXISTS (SELECT 1 FROM email_bodies b WHERE b.email_id = emails.id);
      `);
      db.exec('DROP TABLE IF EXISTS email_bodies;');
    }

    // Restore the v57 shape of the emails triggers.
    const hasFts = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='emails_fts'")
      .get();
    if (!hasFts) return;
    db.exec('DROP TRIGGER IF EXISTS emails_fts_insert;');
    db.exec(`
      CREATE TRIGGER emails_fts_insert AFTER INSERT ON emails BEGIN
        INSERT INTO emails_fts(email_id, subject, from_address, from_name, to_address, cc_address, attachment_names, clean_body)
        VALUES (new.id, new.subject, new.from_address, new.from_name, new.to_address, new.cc_address, new.attachment_names, new.clean_body);
      END;
    `);
    db.exec('DROP TRIGGER IF EXISTS emails_fts_delete;');
    db.exec(`
      CREATE TRIGGER emails_fts_delete AFTER DELETE ON emails BEGIN
        DELETE FROM emails_fts WHERE email_id = old.id;
      END;
    `);
    db.exec('DROP TRIGGER IF EXISTS emails_fts_update;');
    db.exec(`
      CREATE TRIGGER emails_fts_update AFTER UPDATE ON emails
      WHEN new.subject IS NOT old.subject
        OR new.from_address IS NOT old.from_address
        OR new.from_name IS NOT old.from_name
        OR new.to_address IS NOT old.to_address
        OR new.cc_address IS NOT old.cc_address
        OR new.attachment_names IS NOT old.attachment_names
        OR new.clean_body IS NOT old.clean_body
      BEGIN
        DELETE FROM emails_fts WHERE email_id = old.id;
        INSERT INTO emails_fts(email_id, subject, from_address, from_name, to_address, cc_address, attachment_names, clean_body)
        VALUES (new.id, new.subject, new.from_address, new.from_name, new.to_address, new.cc_address, new.attachment_names, new.clean_body);
      END;
    `);
  },
};

/**
 * v74: move inline `data:` images out of `raw_body` into the `inline_images`
 * blob table.
 *
 * The measurements and the storage contract are in
 * `repositories/inline-image-store.ts` — read that first. The headline: 94.6% of
 * all body bytes are base64 image URIs, and 12,392 occurrences of them resolve
 * to 1,086 distinct images. This migration builds the destination only; no body
 * is rewritten here, because rewriting 8.83 GB on the startup path would hang
 * the app for minutes. `InlineImageBackfill` does it in background slices.
 *
 * ## Why there is no FTS work in this one
 *
 * Unlike v73, this migration cannot disturb the search index, and that is worth
 * stating so nobody goes looking. FTS5 indexes `clean_body`, which is plain text
 * derived after the markup is stripped; it has never contained a `data:` URI and
 * this change does not touch it. Only `raw_body` is rewritten, and `raw_body` is
 * deliberately not indexed (it is HTML plus base64 — tokenizing it would fill
 * the index with garbage). So the triggers, their WHEN guards and the rebuild
 * statements all keep working untouched.
 *
 * ## The delete trigger is the load-bearing part
 *
 * An image survives in the blob table for as long as ANY email references it,
 * which at a 10.7x dedup factor is usually thousands of them. Deleting a mail
 * must therefore drop its EDGES, never the bytes. The trigger below does exactly
 * that, and is written explicitly rather than left to `ON DELETE CASCADE` for
 * the same reason the FTS delete trigger is: `PRAGMA foreign_keys` is
 * per-connection and defaults to OFF, so any tool or future code path that opens
 * this database without setting it would leak an edge row per deleted email.
 * Reclaiming the bytes is a separate, explicit sweep
 * (`collectUnreferencedImages`) — never a trigger, because a body rewrite
 * momentarily has zero edges and a trigger would eat the image mid-write.
 */
export const inlineImageBlobTable: Migration = {
  version: 74,
  name: 'inline_image_blob_table',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inline_images (
        hash TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        bytes BLOB NOT NULL,
        byte_length INTEGER NOT NULL,
        first_seen INTEGER NOT NULL
      );
    `);

    // Composite primary key, so re-recording an edge the body already had is a
    // no-op instead of a duplicate row.
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_inline_images (
        email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
        hash TEXT NOT NULL,
        PRIMARY KEY (email_id, hash)
      );
    `);

    // The reverse direction of the composite key: "does any email still
    // reference this image?" is the question the reclaim sweep asks once per
    // candidate blob, and without this index it is a full scan of the edge table
    // per blob.
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_email_inline_images_hash ON email_inline_images(hash);',
    );

    db.exec('DROP TRIGGER IF EXISTS emails_inline_images_delete;');
    db.exec(`
      CREATE TRIGGER emails_inline_images_delete AFTER DELETE ON emails BEGIN
        DELETE FROM email_inline_images WHERE email_id = old.id;
      END;
    `);

    // The extraction cursor: bodies that still hold base64 image data. Drains to
    // empty as the backfill progresses, so both "next batch" and "anything
    // left?" are seeks of an eventually-empty index rather than scans of a
    // multi-gigabyte table.
    //
    // `LIKE` is unindexable as a predicate, but this is a PARTIAL index: the
    // expression is evaluated once per row when the index is built and when a row
    // changes, not per query. That build is the one unavoidable cost of this
    // migration — a single pass over the bodies — and it is what buys every
    // subsequent batch its seek.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_email_bodies_image_pending ON email_bodies(email_id)
        WHERE raw_body LIKE '%;base64,%';
    `);

    db.prepare(
      "INSERT INTO email_body_metrics_state(key, value) VALUES ('inline_images_extracted', '0') " +
        'ON CONFLICT(key) DO NOTHING',
    ).run();

    logger.info('Inline images (v74): blob table created (extraction runs in background)');
  },
  down: (db) => {
    db.exec('DROP TRIGGER IF EXISTS emails_inline_images_delete;');
    db.exec('DROP INDEX IF EXISTS idx_email_bodies_image_pending;');

    // Put every image back inline before the tables go, or this is data loss:
    // the base64 the bodies came from was discarded when the refs were written,
    // so these blobs are the ONLY copy. Done in JS rather than SQL because
    // reassembling `data:<mime>;base64,<bytes>` needs base64 encoding, which
    // SQLite has no built-in for.
    const hasBlobs = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inline_images'")
      .get();
    if (hasBlobs) {
      restoreInlineImagesToBodies(db);
      db.exec('DROP TABLE IF EXISTS email_inline_images;');
      db.exec('DROP TABLE IF EXISTS inline_images;');
    }
    db.prepare("DELETE FROM email_body_metrics_state WHERE key = 'inline_images_extracted'").run();
  },
};

/**
 * A covering index over the inline images' SIZES, so totalling them never reads
 * the blobs.
 *
 * `inlineImageStats` asks `SELECT COUNT(*), SUM(byte_length) FROM inline_images`.
 * That looks like an integer aggregate over a thousand rows, and it is not:
 * `byte_length` sits AFTER the `bytes` BLOB in the record, so reaching it means
 * walking every row's overflow pages — the whole image store, decrypted through
 * SQLCipher on the way. Measured in the running app as one 2613 ms main-thread
 * block, logged by the event-loop monitor at the exact moment the extraction pass
 * finished and logged its summary; measured again on plain SQLite with 1024
 * blobs of 640 KB at 70.7 ms, against 0.0 ms with this index.
 *
 * Same lesson as the extraction cursor's select list, one table over: a column
 * that a query needs and an index does not carry is a full read of the row.
 */
export const inlineImageSizeIndex: Migration = {
  version: 75,
  name: 'inline_image_size_index',
  up: (db) => {
    // Not `WHERE` anything: this index must answer for EVERY row, since the
    // question is a total. It costs one integer per image — a few kilobytes for
    // the measured mailbox's 1024 images.
    //
    // Building it pays the overflow-page walk described above ONCE, here, on the
    // upgrade path, and it is the last time that walk is ever paid. Measured on
    // the 10.5 GB account at 4137 ms — a fresh install builds it over an empty
    // table for nothing, and only a database that already ran the extraction pass
    // pays anything at all. Cheap next to v74's own index build, which is a LIKE
    // over every body in the mailbox.
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_inline_images_byte_length ON inline_images(byte_length);',
    );
    logger.info('Inline image sizes (v75): idx_inline_images_byte_length created');
  },
  down: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_inline_images_byte_length;');
  },
};

/**
 * The AI's own category verdict, recorded per email.
 *
 * Until now the tag string WAS the record of what the AI decided, and the label
 * mirror read its categories back out of it. But the tag string is a shared
 * bucket: Gmail's `\Important` label, the rule-based importance scorer and the
 * user's manual mark all write into it too, and `important` is simultaneously a
 * real AI category slug. So a message Gmail had guessed at came back out of the
 * tag string looking exactly like an AI verdict, and the mirror wrote our own
 * `Sarv Inbox/Important` label onto it in the user's real mailbox — which the
 * label→category recovery then read back as a category, closing the loop.
 *
 * This column is that missing record: written ONLY by the pipeline, from the
 * categorizer's own answer. NULL means "no verdict recorded", which the mirror
 * treats as "do nothing" — never as "the AI returned no categories", because
 * that would strip correct labels off every pre-existing row. An empty string is
 * the distinct, meaningful "the AI ran and chose nothing".
 *
 * Deliberately NOT backfilled from tags: seeding it from the very string the
 * contamination lives in would launder Gmail's guess into a recorded AI verdict
 * and make the bug permanent and untraceable.
 */
export const emailAiCategories: Migration = {
  version: 76,
  name: 'email_ai_categories',
  up: (db) => {
    addColumnIfMissing(db, 'emails', 'ai_categories', 'TEXT DEFAULT NULL');
    logger.info('AI categories (v76): emails.ai_categories added (not backfilled — see migration note)');
  },
  down: (db) => {
    // Clear the values rather than DROP COLUMN: SQLite's DROP COLUMN rewrites
    // the entire table, a multi-GB operation on a real mailbox, and one spare
    // NULL column costs nothing. Nulling it restores the pre-v76 meaning
    // exactly — every row reads as "no verdict recorded".
    db.exec('UPDATE emails SET ai_categories = NULL WHERE ai_categories IS NOT NULL;');
  },
};

/**
 * Inflate every ref in every body back to a `data:` URI. The rollback half of
 * v74, kept out of the migration body so it can be tested directly.
 *
 * Streams one body at a time: the whole point is that these bodies sum to
 * gigabytes, so materialising them all would defeat the purpose of a careful
 * rollback by running the process out of memory.
 */
function restoreInlineImagesToBodies(db: Database.Database): void {
  const update = db.prepare('UPDATE email_bodies SET raw_body = ? WHERE email_id = ?');
  const readBody = db.prepare('SELECT raw_body FROM email_bodies WHERE email_id = ?');
  // The length column describes the stored body, so putting the base64 back has
  // to put the old length back with it — otherwise a rolled-back database reads
  // as though every image-bearing mail were a fortieth of its size.
  const settleLength = db.prepare(
    `UPDATE emails SET raw_body_len = LENGTH(TRIM(${rawBodyExpression('emails')})) WHERE id = ?`,
  );

  // IDs first, bodies one at a time. Selecting the bodies alongside the ids
  // would hold every ref-form body in memory at once, and inflating them
  // in-flight would hold the base64 versions too — which is the multi-gigabyte
  // total this whole change exists to avoid. IDs are 40-odd bytes each.
  //
  // Materialising the id list also decouples the read from the writes below: the
  // UPDATEs change the very column the cursor's LIKE is testing, and iterating a
  // statement while rewriting its rows is not something to rely on.
  const ids = (
    db
      .prepare("SELECT email_id FROM email_bodies WHERE raw_body LIKE '%sarv-inline:%'")
      .all() as Array<{ email_id: string }>
  ).map((row) => row.email_id);

  let restored = 0;
  for (const id of ids) {
    const row = readBody.get(id) as { raw_body: string | null } | undefined;
    if (!row || typeof row.raw_body !== 'string') continue;
    const inflated = inflateInlineImages(db, row.raw_body);
    if (inflated !== row.raw_body) {
      update.run(inflated, id);
      settleLength.run(id);
      restored += 1;
    }
  }
  // The resolved-image LRU is keyed by hash and knows nothing about the tables
  // being dropped out from under it. Left populated, it would answer for images
  // that no longer exist anywhere.
  clearInlineImageCache();
  logger.info(`Inline images (v74 down): ${restored} bodies restored to inline base64`);
}

/**
 * v77 — adopt this mailbox's contacts into the SHARED directory.
 *
 * Contacts used to be per-account, so the same person who emailed two of the
 * user's addresses existed as two rows that never learnt anything from each
 * other. They now live once, in `sarvinbox-contacts.db`, ATTACHed as `shared`
 * (see shared-contacts.ts). This is the one-time pass that folds each existing
 * mailbox in — it runs once per account database, and the SECOND account to run
 * it merges into what the first one left.
 *
 * Three properties it has to have, and how each is obtained:
 *
 *  - **It only ever adds.** Nothing here deletes a directory row. An account
 *    that arrives with an empty or unreadable `contacts` table contributes
 *    nothing rather than emptying the address book — an unreadable store and an
 *    empty store are the same value and opposite facts.
 *  - **It is re-runnable.** A transaction that spans `main` and an attached
 *    database is NOT atomic under WAL, so this can be interrupted with one side
 *    committed. Every statement is therefore idempotent, and counts are
 *    RECOMPUTED from `contact_accounts` rather than accumulated — running it
 *    twice cannot double anyone's email count.
 *  - **It does not destroy the source.** The local tables are renamed aside,
 *    not dropped, so the half-committed case above leaves the mailbox's own
 *    copy intact and recoverable. (They can be dropped by a later release once
 *    the directory has proven itself in the field.)
 *
 * The rename is also what makes the move take effect: SQLite resolves an
 * unqualified `contacts` against `main` first, so while a local table of that
 * name exists it SHADOWS the directory for any statement that forgot to
 * qualify. After this migration `main` has no such table, and
 * {@link hasLocalContactsTable} turns the earlier contact migrations into
 * no-ops for good.
 *
 * Known limitation, deliberately not papered over: `person_id` groups rows that
 * enrichment decided are the same human, and two accounts generated those ids
 * independently. Merging does not attempt to reconcile them, so one person
 * reached at two addresses may stay two groups until enrichment next runs and
 * re-links them by phone. Reconciling here would mean guessing.
 */
export const unifiedContactDirectory: Migration = {
  version: 77,
  name: 'unified_contact_directory',
  up: (db, context) => {
    // No local table means a database created after the move: the directory is
    // already this mailbox's address book and there is nothing to fold in.
    if (!hasLocalContactsTable(db)) return;

    // Never drop a mailbox's contacts into a directory that is not there. The
    // attach is supposed to have happened before migrations run (see
    // SQLiteStorage.initialize); if it did not, stopping leaves the local table
    // exactly where it is, which is the only recoverable outcome.
    if (!hasSharedContacts(db)) {
      throw new Error(
        'unified_contact_directory: the shared contact directory is not attached — ' +
        'refusing to adopt contacts into a schema that does not exist',
      );
    }

    const accountKey = migrationAccountKey(db, context);
    const localCount = (
      db.prepare('SELECT COUNT(*) AS n FROM main.contacts').get() as { n: number }
    ).n;

    // 1. Provenance first, so the directory's totals always have parts to be
    //    derived from. REPLACE rather than accumulate: this account's whole
    //    contribution IS its local table, which makes the write idempotent.
    db.exec(`
      INSERT OR REPLACE INTO ${SHARED('contact_accounts')}
        (email, account_id, first_seen, last_seen, email_count, sent_count, received_count, updated_at)
      SELECT LOWER(email), '${accountKey.replace(/'/g, "''")}',
             first_seen, last_seen,
             COALESCE(email_count, 0), COALESCE(sent_count, 0), COALESCE(received_count, 0),
             unixepoch()
      FROM main.contacts
    `);

    // 2. Addresses the directory has never seen. OR IGNORE covers both the
    //    re-run and the (vanishingly unlikely) case of two accounts having
    //    generated the same row id.
    db.exec(`
      INSERT OR IGNORE INTO ${SHARED('contacts')} (
        id, email, name, display_name, avatar_url, organization, title, phone,
        first_seen, last_seen, email_count, sent_count, received_count,
        is_favorite, notes, tags, metadata, created_at, updated_at,
        contact_type, contact_type_confidence, contact_type_source, company,
        last_inbound_at, last_outbound_at, avg_response_time_sec, thread_count, needs_response,
        kind, person_id, company_contact_id, mobile_e164, enrichment,
        enriched_through_email_at, enrichment_source,
        phones_mined_through, phones_mined, avatar_status, avatar_checked_at
      )
      SELECT
        id, LOWER(email), name, display_name, avatar_url, organization, title, phone,
        first_seen, last_seen, email_count, sent_count, received_count,
        is_favorite, notes, tags, metadata, created_at, updated_at,
        contact_type, contact_type_confidence, contact_type_source, company,
        last_inbound_at, last_outbound_at, avg_response_time_sec, thread_count, needs_response,
        kind, person_id, company_contact_id, mobile_e164, enrichment,
        enriched_through_email_at, enrichment_source,
        phones_mined_through, phones_mined, avatar_status, avatar_checked_at
      FROM main.contacts
    `);

    // 3. Addresses another account already contributed. COALESCE fills gaps
    //    without overwriting: a name, an avatar or an enrichment the directory
    //    already holds was paid for once and stays. The activity window widens
    //    to cover both mailboxes, and the flags are a union — a contact
    //    favourited on one account is favourited everywhere, which is the whole
    //    point of unifying.
    db.exec(`
      UPDATE ${SHARED('contacts')} AS d SET
        name                      = COALESCE(d.name, l.name),
        display_name              = COALESCE(d.display_name, l.display_name),
        avatar_url                = COALESCE(d.avatar_url, l.avatar_url),
        avatar_status             = COALESCE(d.avatar_status, l.avatar_status),
        avatar_checked_at         = COALESCE(d.avatar_checked_at, l.avatar_checked_at),
        organization              = COALESCE(d.organization, l.organization),
        title                     = COALESCE(d.title, l.title),
        phone                     = COALESCE(d.phone, l.phone),
        notes                     = COALESCE(d.notes, l.notes),
        company                   = COALESCE(d.company, l.company),
        person_id                 = COALESCE(d.person_id, l.person_id),
        company_contact_id        = COALESCE(d.company_contact_id, l.company_contact_id),
        mobile_e164               = COALESCE(d.mobile_e164, l.mobile_e164),
        enrichment                = COALESCE(d.enrichment, l.enrichment),
        enrichment_source         = COALESCE(d.enrichment_source, l.enrichment_source),
        enriched_through_email_at = MAX(COALESCE(d.enriched_through_email_at, 0),
                                        COALESCE(l.enriched_through_email_at, 0)),
        phones_mined              = COALESCE(d.phones_mined, l.phones_mined),
        phones_mined_through      = COALESCE(d.phones_mined_through, l.phones_mined_through),
        first_seen                = MIN(d.first_seen, l.first_seen),
        last_seen                 = MAX(d.last_seen, l.last_seen),
        last_inbound_at           = MAX(COALESCE(d.last_inbound_at, 0), COALESCE(l.last_inbound_at, 0)),
        last_outbound_at          = MAX(COALESCE(d.last_outbound_at, 0), COALESCE(l.last_outbound_at, 0)),
        thread_count              = MAX(COALESCE(d.thread_count, 0), COALESCE(l.thread_count, 0)),
        is_favorite               = MAX(COALESCE(d.is_favorite, 0), COALESCE(l.is_favorite, 0)),
        needs_response            = MAX(COALESCE(d.needs_response, 0), COALESCE(l.needs_response, 0)),
        contact_type              = CASE WHEN d.contact_type IS NULL OR d.contact_type = 'unknown'
                                         THEN l.contact_type ELSE d.contact_type END,
        contact_type_source       = CASE WHEN d.contact_type IS NULL OR d.contact_type = 'unknown'
                                         THEN l.contact_type_source ELSE d.contact_type_source END,
        contact_type_confidence   = MAX(COALESCE(d.contact_type_confidence, 0),
                                        COALESCE(l.contact_type_confidence, 0)),
        updated_at                = unixepoch()
      FROM main.contacts AS l
      WHERE d.email = LOWER(l.email) AND d.id != l.id
    `);

    // 4. Counts are the SUM of the parts, never a running total. This is what
    //    makes step 1-3 safe to repeat, and it is also how removing an account
    //    will later be able to subtract exactly what that account contributed.
    db.exec(`
      UPDATE ${SHARED('contacts')} AS d SET
        email_count    = agg.email_count,
        sent_count     = agg.sent_count,
        received_count = agg.received_count
      FROM (
        SELECT email,
               SUM(COALESCE(email_count, 0))    AS email_count,
               SUM(COALESCE(sent_count, 0))     AS sent_count,
               SUM(COALESCE(received_count, 0)) AS received_count
        FROM ${SHARED('contact_accounts')}
        GROUP BY email
      ) AS agg
      WHERE d.email = agg.email
        AND d.email IN (SELECT LOWER(email) FROM main.contacts)
    `);

    // 5. Notes. The id is an AUTOINCREMENT integer, so it cannot carry across —
    //    dedupe on (email, note), the same identity the runtime already uses
    //    when it decides a note is already known.
    if (hasLocalTable(db, 'contact_notes')) {
      db.exec(`
        INSERT INTO ${SHARED('contact_notes')}
          (email, note, category, source_email_id, confidence, created_at, updated_at, is_active)
        SELECT LOWER(l.email), l.note, l.category, l.source_email_id, l.confidence,
               l.created_at, l.updated_at, l.is_active
        FROM main.contact_notes AS l
        WHERE NOT EXISTS (
          SELECT 1 FROM ${SHARED('contact_notes')} AS d
          WHERE d.email = LOWER(l.email) AND d.note = l.note
        )
      `);
    }

    // 6. Enrichment history, with contact_id REMAPPED. The directory may
    //    already hold this address under the id another account generated, and
    //    a history row pointing at an id that no longer exists is a row nothing
    //    can ever read back.
    if (hasLocalTable(db, 'contact_enrichment_history')) {
      db.exec(`
        INSERT OR IGNORE INTO ${SHARED('contact_enrichment_history')} (
          id, contact_id, person_id, enrichment, company_contact_id, designation,
          organization, effective_from, effective_to, source, source_email_id, created_at
        )
        SELECT h.id, COALESCE(d.id, h.contact_id), h.person_id, h.enrichment,
               h.company_contact_id, h.designation, h.organization,
               h.effective_from, h.effective_to, h.source, h.source_email_id, h.created_at
        FROM main.contact_enrichment_history AS h
        LEFT JOIN main.contacts AS l ON l.id = h.contact_id
        LEFT JOIN ${SHARED('contacts')} AS d ON d.email = LOWER(l.email)
      `);
    }

    // 7. Move the originals out of the way. Renamed, not dropped: see the note
    //    above about cross-database commits. The local trigger and indexes go,
    //    because they only cost writes on a table nothing reads any more.
    db.exec('DROP TRIGGER IF EXISTS main.contacts_update_timestamp');
    for (const index of [
      'idx_contacts_email', 'idx_contacts_name', 'idx_contacts_last_seen',
      'idx_contacts_type', 'idx_contacts_needs_response', 'idx_contacts_last_inbound',
      'idx_contacts_kind', 'idx_contacts_person_id', 'idx_contacts_company_id',
      'idx_contacts_mobile', 'idx_contacts_enriched_through',
      'idx_contact_notes_email', 'idx_contact_notes_category', 'idx_contact_notes_active',
      'idx_enrichment_history_contact', 'idx_enrichment_history_person',
      'idx_enrichment_history_open',
    ]) {
      db.exec(`DROP INDEX IF EXISTS main.${index}`);
    }
    renameLocalTableAside(db, 'contacts');
    renameLocalTableAside(db, 'contact_notes');
    renameLocalTableAside(db, 'contact_enrichment_history');

    const directoryCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${SHARED('contacts')}`).get() as { n: number }
    ).n;
    logger.info(
      `Unified contact directory (v77): adopted ${localCount} contacts from account ` +
      `${accountKey}; directory now holds ${directoryCount}`,
    );
  },

  /**
   * Put this mailbox's own address book back where it was.
   *
   * This is an UNDO of the move, not of the merge: the directory rows stay.
   * They have to — once two accounts have contributed to a row there is no
   * record of which half came from where beyond `contact_accounts`, and the
   * older build this rollback exists to serve reads the local table anyway, so
   * leaving the directory populated costs it nothing. The only thing an old
   * build cannot survive is its `contacts` table having vanished, and that is
   * exactly what the rename parked rather than destroyed.
   *
   * A mailbox that never had a local table (any install created after the
   * unification) has nothing parked, and correctly gets nothing back.
   */
  down: (db) => {
    for (const name of DIRECTORY_TABLE_NAMES) {
      // Never overwrite a live table with the parked copy: if one exists, it is
      // newer than what was parked and the parked copy is the stale one.
      if (hasLocalTable(db, `pre_directory_${name}`) && hasLocalTable(db, name)) {
        db.exec(`DROP TABLE IF EXISTS main.pre_directory_${name}`);
      }
    }
    unparkDirectoryTables(db);
  },
};

/**
 * Forget where phone mining last stopped, so every contact is re-read under
 * the current rules on the next scan.
 *
 * Shared by every migration that corrects the extractor or the scorer: mining
 * only ever looks at mail NEWER than this mark, so a fix to how a signature is
 * read reaches nobody until each contact happens to write again — and never at
 * all for one who has gone quiet. Clearing it costs one extra pass over mail
 * already on disk; the mined numbers themselves are kept, and still feed the
 * domain-wide switchboard test on the next scan before re-mining replaces them.
 */
function clearPhoneMiningWatermarks(db: Database.Database, tag: string): void {
  // The watermark lives in the shared directory. No directory attached means
  // no contacts to re-mine, and forcing one open here would be the wrong place
  // to do it — skip, exactly as a fresh install would.
  if (!hasSharedContacts(db)) return;
  const cleared = db
    .prepare(`UPDATE ${SHARED('contacts')} SET phones_mined_through = NULL WHERE phones_mined_through IS NOT NULL`)
    .run().changes;
  if (cleared > 0) logger.info(`Re-mine contact phones (${tag}): cleared the watermark on ${cleared} contacts`);
}

/**
 * v78 — re-mine every contact's signatures once.
 *
 * Phone mining is incremental: `phones_mined_through` records the newest mail a
 * contact had when mining last read them, and a later scan skips anyone with
 * nothing newer. That watermark says "we already looked", which is only a safe
 * thing to believe while the looking itself does not change.
 *
 * It just changed. Mining now converts BOTH ends of a long body instead of the
 * tail alone (a reply is top-posted, so the sender's own signature sits above
 * the quoted chain and a tail-only window never saw it) and no longer reads the
 * `tel:` of a click-to-call href as an "office" label. Contacts whose number
 * was missed for either reason are exactly the ones whose watermark now bars
 * them from being re-read: without this they stay wrong until they happen to
 * send new mail, and a contact who has gone quiet stays wrong forever.
 *
 * Clearing the watermark costs one extra pass over mail already on disk. The
 * mined numbers themselves are kept — they still feed the domain-wide
 * switchboard test on the next scan, before re-mining replaces them.
 */
export const remineContactPhones: Migration = {
  version: 78,
  name: 'remine_contact_phones',
  up: (db) => clearPhoneMiningWatermarks(db, 'v78'),

  /**
   * Nothing to undo. The watermark is a cache of "when we last looked", so the
   * only effect of this migration is one extra scan; restoring the old values
   * is impossible (they were overwritten) and pointless (an older build
   * re-mines and re-sets them itself).
   */
  down: () => {},
};

/**
 * Take colleagues' names off the robot mailboxes that were wearing them.
 *
 * Notification services put the human who triggered the event in the From
 * display name while sending from a machine address, so the directory had
 * entries like "Devendra Rathore <pullrequests-reply@bitbucket.org>" and
 * "Bhupesh Chugh <notifications@atlassian.net>" — a real person's name on an
 * address that is not theirs. Searching for that colleague returned mostly
 * robots. Two things let it happen: the no-reply detector only matched the
 * marker as a PREFIX (so `*-reply@`/`*-noreply@` read as people), and the
 * upsert only ever fills a name when the row has none, so a wrong one written
 * once is never corrected by a later scan. This repairs the rows already
 * stored; contactNameForAddress prevents new ones.
 *
 * Idempotent: it rewrites a name to a value derived from the address, so a
 * re-run computes the same answer and changes nothing.
 */
export const machineMailboxNames: Migration = {
  version: 79,
  name: 'machine_mailbox_names',
  up: (db) => {
    // Contacts live in the shared directory now. No directory attached means
    // there is nothing to repair — exactly as on a fresh install.
    if (!hasSharedContacts(db)) return;

    const rows = db.prepare(
      `SELECT id, email, name, contact_type FROM ${SHARED('contacts')}`
    ).all() as Array<{ id: string; email: string; name: string | null; contact_type: string | null }>;

    const rename = db.prepare(
      `UPDATE ${SHARED('contacts')} SET name = ?, updated_at = unixepoch() WHERE id = ?`
    );
    // Never override a type a user or the agent chose; only fill in the ones
    // that were never classified, mirroring v42.
    const setAutomated = db.prepare(
      `UPDATE ${SHARED('contacts')} SET contact_type = 'automated', contact_type_source = 'heuristic', updated_at = unixepoch() WHERE id = ?`
    );

    let renamed = 0;
    let typed = 0;
    for (const row of rows) {
      if (!isNoReplyAddress(row.email)) continue;
      const service = contactNameForAddress(row.email, row.name);
      if (service && row.name !== service) { rename.run(service, row.id); renamed += 1; }
      if (row.contact_type == null || row.contact_type === 'unknown') { setAutomated.run(row.id); typed += 1; }
    }
    if (renamed > 0 || typed > 0) {
      logger.info(`Machine mailbox names (v79): renamed ${renamed}, typed ${typed} automated`);
    }
  },

  /**
   * Nothing to undo. The names being replaced were the wrong person's, and the
   * originals are not recoverable from the row — an older build simply leaves
   * the service name in place, which is still accurate.
   */
  down: () => {},
};

/**
 * v80 — re-mine every contact's signatures again, under the corrected scorer.
 *
 * Same reasoning as v78, for a different correction: the scorer was reading a
 * job title on the line ABOVE a number as an office label ("VP Support" docked
 * a personal mobile), and ranking ignored how often a number had been seen, so
 * one tidy forwarded signature could outrank a contact's own number. Both
 * verdicts are computed at mining time and stored, so the fix only reaches a
 * contact whose signatures are read again — and v78 has already run on installs
 * that took the previous build, leaving their watermarks set.
 */
export const remineContactPhonesAfterLabelFix: Migration = {
  version: 80,
  name: 'remine_contact_phones_label_fix',
  up: (db) => clearPhoneMiningWatermarks(db, 'v80'),

  /** Nothing to undo — see v78. */
  down: () => {},
};

/** Does `main` still hold a table of this name? (See hasLocalContactsTable.) */
function hasLocalTable(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM main.sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { present: number } | undefined;
  return !!row;
}

/**
 * v81 — put the address book back when the startup sweep deleted it.
 *
 * `sarvinbox-contacts.db` is the shared directory, not an account database,
 * but the orphan-DB sweep matched it as a raw-named legacy per-account file
 * and deleted it — with its sidecars — on the first boot after the directory
 * shipped. The next boot recreated it empty, so the user's whole address book
 * (names, favourites, notes, paid-for enrichment) was simply gone from the UI.
 * The sweep no longer touches it (see cleanupOrphanedAccountDbs), but that
 * only stops the NEXT loss; this repairs the one already taken.
 *
 * Recovery is possible because v77 PARKED each mailbox's contacts as
 * `pre_directory_*` rather than dropping them — exactly the "rename, never
 * drop" rule that migration was written under. Bringing them back under their
 * live names lets v77's own adoption run again, unchanged, and re-park them.
 *
 * Deliberately narrow, and per MAILBOX rather than per directory. The test is
 * "the directory has lost this account's contribution": it holds provenance for
 * fewer than half the rows this mailbox parked. With two accounts connected,
 * only the first one to run would see an EMPTY directory — the second would
 * find the first's 954 rows, call the directory healthy, and leave its own 895
 * parked forever.
 *
 * Half, rather than "any row missing", because deleting a contact removes its
 * provenance too: an exact test would resurrect the handful of contacts a user
 * has deliberately deleted since the move. Wholesale loss and a few deletions
 * are not the same shape, and only the first one is worth repairing.
 */
/**
 * v82 — partial indexes for the folder-less flag views (Starred / Important).
 *
 * Those two views page and count by CONVERSATION off `threads.has_flagged` /
 * `has_important`, which had no index: every page was a full scan of `threads`
 * plus a sort. Partial (`WHERE flag = 1`) so the index holds only the flagged
 * conversations — a few hundred rows in a mailbox of hundreds of thousands —
 * and its column order matches the queries' ORDER BY, so the page is a plain
 * range scan with no sort step at all.
 */
export const flagViewThreadIndexes: Migration = {
  version: 82,
  name: 'flag_view_thread_indexes',
  up: (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_threads_flagged
        ON threads(last_message_date DESC, id DESC) WHERE has_flagged = 1;
      CREATE INDEX IF NOT EXISTS idx_threads_important
        ON threads(max_priority_score DESC, last_message_date DESC, id DESC) WHERE has_important = 1;
    `);
    logger.info('Flag views (v82): idx_threads_flagged + idx_threads_important created');
  },
  down: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_threads_flagged;
      DROP INDEX IF EXISTS idx_threads_important;
    `);
  },
};

/**
 * v83 — indexes for the folder-less "All Email" view, now paged by CONVERSATION.
 *
 * Membership is "the conversation lists in at least one non-special folder",
 * asked as an EXISTS over `thread_folders`. That table is WITHOUT ROWID keyed
 * (folder_id, thread_id), so the by-thread direction had no seekable key and
 * every page scanned the whole projection; idx_tf_thread supplies it. The
 * `threads` date index gains `id` so the page's ORDER BY
 * (last_message_date DESC, id DESC) is served entirely by the index instead of
 * a temp b-tree over every conversation in the mailbox.
 */
export const allMailThreadIndexes: Migration = {
  version: 83,
  name: 'all_mail_thread_indexes',
  up: (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tf_thread ON thread_folders(thread_id, folder_id);
      DROP INDEX IF EXISTS idx_threads_last_message_date;
      CREATE INDEX IF NOT EXISTS idx_threads_last_message_date ON threads(last_message_date DESC, id DESC);
    `);
    logger.info('All Email (v83): idx_tf_thread + composite idx_threads_last_message_date created');
  },
  down: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_tf_thread;
      DROP INDEX IF EXISTS idx_threads_last_message_date;
      CREATE INDEX IF NOT EXISTS idx_threads_last_message_date ON threads(last_message_date DESC);
    `);
  },
};

/**
 * v85 — the user's trust/block rules for deceptive-looking links.
 *
 * The phishing check flags an anchor whose text names one domain while its
 * href goes to another. Legitimate senders do this constantly (a bank's
 * "paypal.com" text behind a tracking redirect), and until now the only way
 * to stop the warning was to stop reading the warning. One row records a
 * verdict on one (sender domain, shown domain, actual domain) triple.
 *
 * Scoped to the SENDER on purpose. Trusting "x.com → y.com" for everyone
 * would let any sender use that redirect unflagged, and a compromised
 * familiar account is the usual way phishing arrives from a known name.
 */
export const linkDomainRules: Migration = {
  version: 85,
  name: 'link_domain_rules',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS link_domain_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_domain TEXT NOT NULL,
        shown_domain TEXT NOT NULL,
        actual_domain TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('trust', 'block')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(sender_domain, shown_domain, actual_domain)
      );
    `);
    logger.info('link_domain_rules (v85): table created');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS link_domain_rules;');
  },
};

/**
 * v86 — the spam filter's header-stage verdict and the connecting IP.
 *
 * `spam_score` / `spam_reasons` are written once at ingest by the processor
 * (core utils/spam-signals) and read by the shield to say WHY a message was
 * filed. `origin_ip` is the address that handed the message to the recipient's
 * mail system, recorded now so the reputation stage (blocklists, reverse DNS)
 * has something to look up without re-fetching headers. All three are NULL on
 * rows synced before this version — "not scored", which is distinct from a
 * score of 0 and is what a later backfill selects on. ADD COLUMN is O(1)
 * metadata in SQLite; no rewrite of the mail table.
 */
export const emailSpamColumns: Migration = {
  version: 86,
  name: 'email_spam_columns',
  up: (db) => {
    const colNames = new Set(
      (db.prepare('PRAGMA table_info(emails)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!colNames.has('spam_score')) db.exec('ALTER TABLE emails ADD COLUMN spam_score REAL;');
    if (!colNames.has('spam_reasons')) db.exec('ALTER TABLE emails ADD COLUMN spam_reasons TEXT;');
    if (!colNames.has('origin_ip')) db.exec('ALTER TABLE emails ADD COLUMN origin_ip TEXT;');
    logger.info('email spam columns (v86): spam_score, spam_reasons, origin_ip ready');
  },
  down: () => {
    // Dropping columns rewrites the table on older SQLite builds; the columns
    // are harmless when unused, so leave them.
  },
};

/**
 * v84 — re-key the search index by rowid so maintaining it stops scanning it.
 *
 * `emails_fts.email_id` is UNINDEXED and fts5 has no secondary indexes, so every
 * maintenance statement written as `WHERE email_id = ?` planned as a full scan
 * of the entire index to reach ONE row — on the DELETE path and, because the
 * update trigger deletes before re-inserting, on the UPDATE path too. Measured
 * on a 27k-message index: 410 deletes took 9,165ms by `email_id` and 44ms by
 * `rowid`, for the same resulting index. On a real mailbox it showed up as a
 * 194-second main-process freeze while a folder reconciled 410 deletions.
 *
 * The triggers now address rows by fts5's own `rowid`, holding it equal to the
 * `emails` rowid the entry mirrors (see the rowid contract in fts-schema.ts).
 * Existing indexes were built without that alignment, so their rowids are
 * arbitrary and the new statements would address the wrong row — the index has
 * to be rebuilt, not just re-triggered.
 *
 * The rebuild re-tokenizes every message, so it is not cheap on a large mailbox
 * (seconds, once, at startup). It runs inside the migration's transaction: a
 * half-rebuilt index would silently return partial search results, which is far
 * worse than a slower launch, and an interrupted run rolls back to the old index
 * and retries on the next boot.
 */
export const ftsRowidAlignment: Migration = {
  version: 84,
  name: 'fts_rowid_alignment',
  up: (db) => {
    const hasFts = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='emails_fts'")
      .get();
    if (!hasFts) {
      logger.info('FTS rowid (v84): no FTS table on this DB — nothing to re-key');
      return;
    }

    // DROP rather than DELETE: this discards the old index wholesale, and
    // applyFtsSchema recreates the table (its DDL is IF NOT EXISTS) together
    // with every trigger in its current shape.
    db.exec('DROP TABLE IF EXISTS emails_fts;');
    applyFtsSchema(db);
    db.exec(FTS_REBUILD_SQL);

    const indexed = (db.prepare('SELECT COUNT(*) AS n FROM emails_fts').get() as { n: number }).n;
    logger.info(`FTS rowid (v84): search index re-keyed by rowid (${indexed} message(s) re-indexed)`);
  },
  down: (db) => {
    // The old shape is simply the same index without the rowid alignment; the
    // rebuild is what matters, so re-run it. Triggers are restored by whichever
    // earlier migration owns them.
    const hasFts = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='emails_fts'")
      .get();
    if (!hasFts) return;
    db.exec('DROP TABLE IF EXISTS emails_fts;');
    applyFtsSchema(db);
    db.exec(FTS_REBUILD_SQL);
  },
};

export const restoreLostContactDirectory: Migration = {
  version: 81,
  name: 'restore_lost_contact_directory',
  up: (db, context) => {
    // No directory attached: nothing to compare against, nothing to adopt into.
    if (!hasSharedContacts(db)) return;
    // A live `contacts` table means v77 has not moved this mailbox yet; it will
    // adopt on its own, and unparking underneath it would fight that.
    if (hasLocalTable(db, 'contacts')) return;
    if (!hasLocalTable(db, 'pre_directory_contacts')) return;

    const parkedCount = (
      db.prepare('SELECT COUNT(*) AS n FROM main.pre_directory_contacts').get() as { n: number }
    ).n;
    if (parkedCount === 0) return;
    const accountKey = migrationAccountKey(db, context);
    const contributed = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM ${SHARED('contact_accounts')} WHERE account_id = ?`)
        .get(accountKey) as { n: number }
    ).n;
    if (contributed * 2 >= parkedCount) return;

    const restored = unparkDirectoryTables(db);
    if (!restored.includes('contacts')) return;
    logger.warn(
      `Restore contact directory (v81): the directory holds ${contributed} of this mailbox's ` +
      `${parkedCount} parked contacts — re-adopting them (${restored.join(', ')})`,
    );
    // v77's adoption, unchanged: it reads the live tables, folds them into the
    // directory and parks them again, so a second run finds nothing to do.
    unifiedContactDirectory.up(db, context);

    // The rows coming back are the ones v77 first adopted, so they predate the
    // two repairs above — and those are recorded as applied, so they will not
    // run again by themselves. Re-run them here, against the restored rows:
    // both are idempotent, and skipping them would hand the user back an
    // address book with the robot names and the stale mining marks they had
    // before.
    machineMailboxNames.up(db, context);
    clearPhoneMiningWatermarks(db, 'v81');
  },

  /**
   * Nothing to undo. The rows are back where v77 puts them and the parked
   * copies are parked again — the same state an install that never lost its
   * directory is in, which is what v77's own rollback expects to find.
   */
  down: () => {},
};

/** The three tables the directory owns, in adoption order. */
const DIRECTORY_TABLE_NAMES = ['contacts', 'contact_notes', 'contact_enrichment_history'] as const;

/**
 * Bring parked `pre_directory_*` tables back under their live names, and say
 * which ones moved.
 *
 * Only ever renames into a name that is FREE — a live table is this mailbox's
 * current truth and the parked copy is the stale one, so the caller decides
 * what to do about that before calling. Used both to undo the move (v77's
 * rollback) and to re-adopt from the parked copies when the directory itself
 * was lost (v81).
 */
function unparkDirectoryTables(db: Database.Database): string[] {
  const restored: string[] = [];
  for (const name of DIRECTORY_TABLE_NAMES) {
    const parked = `pre_directory_${name}`;
    if (!hasLocalTable(db, parked) || hasLocalTable(db, name)) continue;
    db.exec(`ALTER TABLE main.${parked} RENAME TO ${name}`);
    restored.push(name);
  }
  return restored;
}

/**
 * Park a per-account table under a `pre_directory_` name.
 *
 * Deliberately a rename and not a drop — the adopted rows are the user's own
 * address book and the commit that moved them into the directory spans two
 * database files, which WAL does not make atomic.
 */
function renameLocalTableAside(db: Database.Database, name: string): void {
  if (!hasLocalTable(db, name)) return;
  const parked = `pre_directory_${name}`;
  // A previous interrupted run may already have parked a copy; the live table
  // is the newer truth, so keep it and discard the older parking space.
  db.exec(`DROP TABLE IF EXISTS main.${parked}`);
  db.exec(`ALTER TABLE main.${name} RENAME TO ${parked}`);
}

/**
 * Which account is this database? Used only to record contact provenance.
 *
 * Falls back to the database's file name, which is derived from the account in
 * the first place (`sarvinbox-<hash>.db`), and finally to a constant — the
 * adoption must still run for a storage opened with no account behind it (the
 * seed script, the test fixtures), it just cannot say whose contacts these are.
 */
function migrationAccountKey(db: Database.Database, context: MigrationContext): string {
  if (context.accountId) return context.accountId;
  const rows = db.pragma('database_list') as Array<{ name: string; file: string }>;
  const file = rows.find((r) => r.name === 'main')?.file;
  return file ? basename(file) : 'unknown-account';
}

/**
 * Create migration manager with the fresh schema
 */
export function createMigrationManager(
  db: Database.Database,
  context: MigrationContext = {},
): MigrationManager {
  const manager = new MigrationManager(db, context);
  manager.register(initialTagsSchema);
  manager.register(chatExtractionTracking);
  manager.register(pendingOperationsUpgrade);
  manager.register(fts5SearchIndex);
  manager.register(emailAgentSchema);
  manager.register(contactClassification);
  manager.register(behaviorIntelligence);
  manager.register(pipelineStatusTracking);
  manager.register(contactKnowledgeBase);
  manager.register(financeCategory);
  manager.register(agentAutoDraft);
  manager.register(removeWaitingReplyCategory);
  manager.register(promotionsCategory);
  manager.register(userCategorizationRules);
  manager.register(agentPromptTemplates);
  manager.register(contactEnrichment);
  manager.register(aiParseFailureCount);
  manager.register(senderSignatureMarker);
  manager.register(contactRoleReclassification);
  manager.register(requeueNeedsResponseForDrafting);
  manager.register(requeueNeedsResponseForDraftingV2);
  manager.register(inReplyToIndex);
  manager.register(attachmentSizes);
  manager.register(clearBogusAttachmentNames);
  manager.register(refetchGenericAttachmentNames);
  manager.register(outboxQueue);
  manager.register(pendingOperationsDeadLetter);
  manager.register(filterRules);
  manager.register(labels);
  manager.register(calendarIcs);
  manager.register(calendarAdded);
  manager.register(sentAppendDurability);
  manager.register(folderCondstoreColumns);
  manager.register(ftsUpdateTriggerGate);
  manager.register(contactPhonesMinedWatermark);
  manager.register(folderBackfillColumns);
  manager.register(emailLabelStatus);
  manager.register(pendingOperationFailureDetail);
  manager.register(reconcileLabelDrift);
  manager.register(contactAvatarConfirmation);
  manager.register(readModelFoundation);
  manager.register(readModelDirtyQueue);
  manager.register(userLabelServerSync);
  manager.register(imageAllowedSenders);
  manager.register(folderSyncPolicy);
  manager.register(aiAgentFailureCount);
  manager.register(emailThreadKeys);
  manager.register(emailsFromAddressLowerIndex);
  manager.register(emailBodyLengthColumns);
  manager.register(emailBodiesSideTable);
  manager.register(inlineImageBlobTable);
  manager.register(inlineImageSizeIndex);
  manager.register(emailAiCategories);
  manager.register(unifiedContactDirectory);
  manager.register(remineContactPhones);
  manager.register(machineMailboxNames);
  manager.register(remineContactPhonesAfterLabelFix);
  manager.register(restoreLostContactDirectory);
  manager.register(flagViewThreadIndexes);
  manager.register(allMailThreadIndexes);
  manager.register(ftsRowidAlignment);
  manager.register(linkDomainRules);
  manager.register(emailSpamColumns);
  return manager;
}
