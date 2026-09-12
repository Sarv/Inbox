-- Sarv Inbox Database Schema (v2 — Unified Tags System)
-- Fresh start: no migrations, no junction tables, no duplicate columns
-- Everything is a tag: folders, flags, AI categories

-- ============================================================
-- Core Tables
-- ============================================================

-- Emails table — single source of truth
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  message_id TEXT UNIQUE NOT NULL,
  thread_id TEXT NOT NULL,

  -- IMAP sync reference (primary folder this was synced from)
  folder_id TEXT NOT NULL,
  uid INTEGER,

  -- ============================================================
  -- UNIFIED TAGS: folders + flags + categories all in one column
  -- Format: '|INBOX|read|starred|important|needs_response|'
  -- Pipe-delimited with leading/trailing pipes for safe instr() matching
  -- ============================================================
  tags TEXT NOT NULL DEFAULT '||',

  -- Headers
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

  -- Timestamps (Unix timestamp in seconds)
  date INTEGER NOT NULL,
  received_date INTEGER,

  -- Content
  --
  -- The two `_len` columns are declared AHEAD of the bodies deliberately. A row
  -- is one record and the overflow chain a large body spills onto is a
  -- singly-linked list, so a column placed after the bodies can only be reached
  -- by walking that chain — measured at 426ms vs 4ms for the same predicate on a
  -- pre-body column. Everything that only needs to know WHETHER (or how big) a
  -- body is reads these instead. See repositories/body-metrics.ts.
  clean_body_len INTEGER,
  raw_body_len INTEGER,
  clean_body TEXT NOT NULL,
  raw_body TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK(content_type IN ('text', 'html', 'multipart')),
  content_hash TEXT NOT NULL,

  -- Threading
  in_reply_to TEXT,
  "references" TEXT,

  -- Priority
  priority TEXT CHECK(priority IN ('low', 'normal', 'high')),

  -- Attachments
  has_attachments INTEGER NOT NULL DEFAULT 0 CHECK(has_attachments IN (0, 1)),
  attachment_count INTEGER NOT NULL DEFAULT 0,
  attachment_names TEXT,

  -- Importance scoring
  importance_score INTEGER DEFAULT 0,
  importance_source TEXT DEFAULT 'none',
  auth_status TEXT,

  -- AI processing metadata
  ai_processed_at INTEGER,
  ai_confidence REAL DEFAULT 0,
  ai_reasoning TEXT,

  -- Snooze (replaces snoozed_emails table)
  snooze_until INTEGER,
  snooze_original_tags TEXT,

  -- Embeddings
  has_embedding INTEGER NOT NULL DEFAULT 0 CHECK(has_embedding IN (0, 1)),
  embedding_last_generated INTEGER,

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

-- Folders table — IMAP sync state only
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT UNIQUE NOT NULL,
  parent_id TEXT,

  -- IMAP sync state
  uid_validity INTEGER,
  last_sync_uid INTEGER,
  last_sync_time INTEGER,
  highest_modseq INTEGER,

  -- Counts
  total_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER DEFAULT 0,

  -- Sync optimization
  last_known_uidnext INTEGER,
  last_known_message_count INTEGER,
  sync_status TEXT DEFAULT 'idle',

  -- Historical backfill progress (paging older mail downward by UID)
  backfill_oldest_uid INTEGER,
  backfill_complete INTEGER NOT NULL DEFAULT 0 CHECK(backfill_complete IN (0, 1)),

  -- Metadata
  special_use TEXT,
  subscribed INTEGER NOT NULL DEFAULT 1 CHECK(subscribed IN (0, 1)),
  provider TEXT DEFAULT 'generic',

  -- Per-folder sync policy (v68). sync_enabled off = don't sync this folder at
  -- all; sync_mode NULL = use the global setting ('full' | 'headers'); keep_days
  -- NULL = unlimited (reserved for a future retention prune).
  sync_enabled INTEGER NOT NULL DEFAULT 1 CHECK(sync_enabled IN (0, 1)),
  sync_mode TEXT DEFAULT NULL,
  keep_days INTEGER DEFAULT NULL,

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

  FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
);

-- Threads table
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,

  -- Thread metadata
  first_message_id TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  last_message_date INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 1,

  -- Participants (comma-separated email addresses)
  participants TEXT,

  -- Thread state
  has_unread INTEGER NOT NULL DEFAULT 0 CHECK(has_unread IN (0, 1)),
  has_flagged INTEGER NOT NULL DEFAULT 0 CHECK(has_flagged IN (0, 1)),
  labels TEXT NOT NULL DEFAULT '[]',

  -- ============================================================
  -- DENORMALIZED READ-MODEL STATE (see docs/READ_MODEL_PLAN.md)
  -- Conversation-wide, LIVE (Trash/Spam/Junk/Deleted excluded) booleans, kept in
  -- sync on the write path by thread-rollup.ts so list queries are flat indexed
  -- scans instead of GROUP BY + correlated EXISTS. `has_unread`/`has_flagged`
  -- above are part of this set (pre-existing).
  -- ============================================================
  has_important INTEGER NOT NULL DEFAULT 0 CHECK(has_important IN (0, 1)),
  has_important_unread INTEGER NOT NULL DEFAULT 0 CHECK(has_important_unread IN (0, 1)),
  has_attachment INTEGER NOT NULL DEFAULT 0 CHECK(has_attachment IN (0, 1)),
  has_draft INTEGER NOT NULL DEFAULT 0 CHECK(has_draft IN (0, 1)),
  has_category INTEGER NOT NULL DEFAULT 0 CHECK(has_category IN (0, 1)),
  max_priority_score INTEGER NOT NULL DEFAULT 0,
  first_sender TEXT,
  last_sender TEXT,
  live_message_count INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 0,

  -- Background conversation extraction tracking
  chat_extracted_at INTEGER DEFAULT NULL,
  chat_email_count INTEGER DEFAULT 0,

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- READ-MODEL: per-(folder, thread) materialized index (fan-out on write).
-- One row per folder a thread appears in; flags are replicated here so a
-- folder/section listing is a covering range scan that never touches `threads`
-- until hydration. `last_message_date`/`max_priority_score` are FOLDER-LOCAL
-- (this folder's view of the thread, matching the legacy per-folder ORDER BY);
-- the flags are conversation-wide LIVE (matching the legacy thread-level EXISTS).
-- `last_message_date` is Unix SECONDS, copied verbatim from emails.date.
-- WITHOUT ROWID: the PK is the sole access path, so skip the rowid indirection.
-- ============================================================
CREATE TABLE IF NOT EXISTS thread_folders (
  folder_id            TEXT    NOT NULL,
  thread_id            TEXT    NOT NULL,
  last_message_date    INTEGER NOT NULL,
  max_priority_score   INTEGER NOT NULL DEFAULT 0,
  has_unread           INTEGER NOT NULL DEFAULT 0 CHECK(has_unread IN (0, 1)),
  has_important        INTEGER NOT NULL DEFAULT 0 CHECK(has_important IN (0, 1)),
  has_important_unread INTEGER NOT NULL DEFAULT 0 CHECK(has_important_unread IN (0, 1)),
  has_flagged          INTEGER NOT NULL DEFAULT 0 CHECK(has_flagged IN (0, 1)),
  has_attachment       INTEGER NOT NULL DEFAULT 0 CHECK(has_attachment IN (0, 1)),
  has_draft            INTEGER NOT NULL DEFAULT 0 CHECK(has_draft IN (0, 1)),
  has_category         INTEGER NOT NULL DEFAULT 0 CHECK(has_category IN (0, 1)),
  PRIMARY KEY (folder_id, thread_id)
) WITHOUT ROWID;

-- READ-MODEL: normalized per-category thread membership. Drives the materialized
-- `has_category` boolean AND per-category browse (the AI tabs) via join.
CREATE TABLE IF NOT EXISTS thread_categories (
  thread_id TEXT NOT NULL,
  slug      TEXT NOT NULL,
  PRIMARY KEY (thread_id, slug)
) WITHOUT ROWID;

-- READ-MODEL: per-account backfill/progress + read-cutover flag.
-- keys: 'status' ('pending'|'running'|'complete'), 'threads_done',
--       'threads_total', 'updated_at'.
CREATE TABLE IF NOT EXISTS read_model_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- BODY METRICS: whether this database's `clean_body_len`/`raw_body_len` columns
-- are complete. A fresh database is complete by construction — the columns are
-- declared above and every write path sets them — so it is seeded to '1' and the
-- background backfill never has anything to do. An UPGRADED database gets '0'
-- from migration v72 and flips to '1' once the backfill drains.
CREATE TABLE IF NOT EXISTS email_body_metrics_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO email_body_metrics_state(key, value)
VALUES ('lengths_backfilled', '1')
ON CONFLICT(key) DO NOTHING;

-- READ-MODEL: the dirty queue. Any write to `emails` records the affected
-- thread_id here via the triggers below; the TS ReadModelMaintainer drains it
-- (rebuild + delete) in chunks. Trigger-based so EVERY write path — repo methods
-- AND ad-hoc `UPDATE emails SET tags` — is captured, with zero derivation in SQL
-- (the trigger only records WHICH thread changed; the rollup stays in TS). The
-- queue IS the backfill cursor: seeding it with every thread + draining to empty
-- is the one-time backfill, and it resumes after a crash because drained rows are
-- only deleted once their rebuild commits.
CREATE TABLE IF NOT EXISTS read_model_dirty (
  thread_id TEXT PRIMARY KEY
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS trg_emails_rm_dirty_insert
AFTER INSERT ON emails BEGIN
  INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (NEW.thread_id);
END;
-- Only the columns that feed the rollup — avoids marking dirty on incidental
-- updates (updated_at, ai_processed_at, embeddings, ...).
CREATE TRIGGER IF NOT EXISTS trg_emails_rm_dirty_update
AFTER UPDATE OF tags, folder_id, has_attachments, priority_score, date, thread_id ON emails BEGIN
  INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (NEW.thread_id);
  INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (OLD.thread_id);
END;
CREATE TRIGGER IF NOT EXISTS trg_emails_rm_dirty_delete
AFTER DELETE ON emails BEGIN
  INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (OLD.thread_id);
END;

-- Attachments table
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  file_path TEXT NOT NULL,

  created_at INTEGER NOT NULL DEFAULT (unixepoch()),

  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

-- Embedding metadata table
CREATE TABLE IF NOT EXISTS embedding_metadata (
  email_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  model_name TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  provider TEXT NOT NULL,

  created_at INTEGER NOT NULL DEFAULT (unixepoch()),

  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

-- Accounts table
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,

  -- IMAP settings
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_secure INTEGER NOT NULL CHECK(imap_secure IN (0, 1)),
  imap_username TEXT NOT NULL,
  imap_password TEXT NOT NULL,
  imap_auth_method TEXT NOT NULL DEFAULT 'password',

  -- Sync settings
  sync_enabled INTEGER NOT NULL DEFAULT 1 CHECK(sync_enabled IN (0, 1)),
  sync_interval INTEGER,

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- AI Category Definitions
-- Defines what categories exist (user can add more without schema changes)
-- The actual assignment is just a tag on the emails.tags column
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_category_definitions (
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

-- ============================================================
-- Supporting Tables
-- ============================================================

-- Contacts live in the SHARED contact directory (`sarvinbox-contacts.db`,
-- attached as the schema `shared`), NOT in a mailbox — one address book for
-- every account instead of one per account. See src/shared-contacts.ts.
--
-- Deliberately absent here rather than merely unused: SQLite resolves an
-- unqualified `contacts` against `main` first, so re-creating an empty local
-- table would silently shadow the directory and the app would show an empty
-- address book with no error anywhere.

-- Sender statistics
CREATE TABLE IF NOT EXISTS sender_stats (
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

-- Spammers
CREATE TABLE IF NOT EXISTS spammers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  domain TEXT,
  name TEXT,
  reason TEXT,
  reported_count INTEGER DEFAULT 1,
  first_reported_at INTEGER DEFAULT (unixepoch()),
  last_reported_at INTEGER DEFAULT (unixepoch()),
  created_at INTEGER DEFAULT (unixepoch())
);

-- Senders the user has chosen to always load remote images from (per account).
-- Populated when they click "Load images" on a blocked message; the renderer
-- caches the set for its synchronous block-vs-load decision.
CREATE TABLE IF NOT EXISTS image_allowed_senders (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Signature patterns
CREATE TABLE IF NOT EXISTS signature_patterns (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  html_selector TEXT NOT NULL,
  sample_html TEXT,
  email_ids TEXT DEFAULT '[]',
  confidence TEXT NOT NULL CHECK(confidence IN ('high', 'medium', 'low')),
  usage_count INTEGER DEFAULT 1,
  last_used INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Pending IMAP operations (retry queue)
-- status: 'pending' | 'executing' | 'failed' (dead-letter after maxRetries)
CREATE TABLE IF NOT EXISTS pending_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  uid INTEGER NOT NULL,
  data TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  -- Diagnostics for the Outbox "Failed actions" list: the IMAP command we sent
  -- and the server's raw reply, so the user sees WHAT we tried vs what came back.
  attempted_command TEXT,
  server_response TEXT,
  next_retry_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Pending SMTP sends (outbox / retry queue)
-- Persist-first: a send is written here BEFORE the SMTP submit so a failed or
-- offline send is never lost. Deleted on success; kept as status='failed'
-- (dead-letter) after maxRetries so the user can see/retry it.
-- status: 'pending' | 'executing' | 'failed'
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

-- User-defined inbox filter rules: match incoming mail on conditions, apply actions.
-- conditions/actions are JSON arrays (see @sarvinbox/core types/filters).
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

-- User-defined labels. Applying a label adds its name as a tag on an email;
-- this table records which tag names are labels and their display color.
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#2563eb',
  -- 1 when the label was mirrored to the mail server (an IMAP folder created for
  -- it) so it shows in the provider's webmail; 0 = local-only.
  synced_to_server INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Thread summaries
CREATE TABLE IF NOT EXISTS thread_summaries (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  key_points TEXT,
  participants TEXT,
  last_email_date INTEGER,
  email_count INTEGER,
  processed_at INTEGER NOT NULL,
  model_used TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Conversation extractions
CREATE TABLE IF NOT EXISTS conversation_extractions (
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

-- ============================================================
-- Indexes
-- ============================================================

-- Email indexes
CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_folder_id ON emails(folder_id);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_from_address ON emails(from_address);
-- Sender lookups are ALWAYS case-folded (`LOWER(from_address) = LOWER(?)`) —
-- addresses arrive in whatever case the sending server used, so a plain
-- `from_address` index can never serve them: a function on the column defeats
-- every index. This expression index is what SQLite can actually seek, and
-- `date` rides along so the "newest mail from this sender" queries stay
-- covering (no row read, so the inline bodies are never touched).
-- Measured 2026-08-26 on a 26k mailbox: the contact-enrichment candidate join
-- went from 2,223ms of blocked main thread to 3.4ms.
CREATE INDEX IF NOT EXISTS idx_emails_from_lower_date ON emails(LOWER(from_address), date);
CREATE INDEX IF NOT EXISTS idx_emails_has_embedding ON emails(has_embedding);
CREATE INDEX IF NOT EXISTS idx_emails_content_hash ON emails(content_hash);
CREATE INDEX IF NOT EXISTS idx_emails_uid ON emails(uid);
CREATE INDEX IF NOT EXISTS idx_emails_folder_uid ON emails(folder_id, uid);
CREATE INDEX IF NOT EXISTS idx_emails_importance ON emails(importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_emails_ai_processed ON emails(ai_processed_at);
CREATE INDEX IF NOT EXISTS idx_emails_snooze ON emails(snooze_until) WHERE snooze_until IS NOT NULL;

-- The AI-pipeline covering indexes (idx_emails_agent_pipeline,
-- idx_emails_extraction_pipeline) are deliberately NOT here: they index
-- `agent_status`/`extraction_status`, which this file does not declare — those
-- columns arrive in migration 31, and this file IS migration 24. They are
-- created in migration 72, which runs for fresh and upgraded databases alike.
-- Backfill cursor for upgraded databases; permanently empty on a fresh one.
CREATE INDEX IF NOT EXISTS idx_emails_body_len_pending ON emails(id) WHERE clean_body_len IS NULL;

-- Thread-resolver lookup keys. Narrow on purpose: `emails` rows carry the bodies
-- inline (~250 KB each on a real mailbox), so a `subject_norm` column there could
-- not be backfilled or indexed without rewriting/reading every byte of the table.
-- See src/thread-keys.ts for the full reasoning and the write path.
CREATE TABLE IF NOT EXISTS email_thread_keys (
  email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  -- normalizeSubject(subject): reply/forward prefixes stripped, lowercased.
  subject_norm TEXT NOT NULL,
  -- Copies of the email's fields so the window filter never touches `emails`.
  date INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Equality column first, then date: the resolver looks up one normalised subject
-- and narrows by a date window, so SQLite can seek and walk instead of scanning.
CREATE INDEX IF NOT EXISTS idx_email_thread_keys_lookup ON email_thread_keys(subject_norm, date);
-- Lets the incremental thread repair ask "anything stored since the last pass?"
-- without scanning to find out that the answer is no.
CREATE INDEX IF NOT EXISTS idx_email_thread_keys_created_at ON email_thread_keys(created_at);

-- Folder indexes
CREATE INDEX IF NOT EXISTS idx_folders_path ON folders(path);
CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id);

-- Thread indexes
CREATE INDEX IF NOT EXISTS idx_threads_last_message_date ON threads(last_message_date DESC);
CREATE INDEX IF NOT EXISTS idx_threads_has_unread ON threads(has_unread);
CREATE INDEX IF NOT EXISTS idx_threads_chat_extraction ON threads(chat_extracted_at, chat_email_count, message_count);

-- Read-model indexes (see docs/READ_MODEL_PLAN.md).
-- Base date-ordered listing (normal folder + date-sorted sections). Serves BOTH
-- keyset directions via reverse scan; cursor is (last_message_date, thread_id).
CREATE INDEX IF NOT EXISTS idx_tf_list
  ON thread_folders(folder_id, last_message_date DESC, thread_id DESC);
-- Important-first sections order by priority then date -> its own cursor tuple.
CREATE INDEX IF NOT EXISTS idx_tf_priority
  ON thread_folders(folder_id, max_priority_score DESC, last_message_date DESC, thread_id DESC);
-- Partial indexes ONLY for the hot + SELECTIVE filters (keeps write amplification
-- bounded). Weakly-selective flags ride idx_tf_list as residual filters instead.
CREATE INDEX IF NOT EXISTS idx_tf_unread
  ON thread_folders(folder_id, last_message_date DESC, thread_id DESC) WHERE has_unread = 1;
CREATE INDEX IF NOT EXISTS idx_tf_unlabelled
  ON thread_folders(folder_id, last_message_date DESC, thread_id DESC) WHERE has_category = 0;
-- Per-category browse ("all threads in category X").
CREATE INDEX IF NOT EXISTS idx_tc_slug ON thread_categories(slug, thread_id);

-- Attachment indexes
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);

-- Contact indexes
-- (contacts indexes live with the table, in the shared directory)

-- Sender stats indexes
CREATE INDEX IF NOT EXISTS idx_sender_stats_email ON sender_stats(email);
CREATE INDEX IF NOT EXISTS idx_sender_stats_domain ON sender_stats(domain);

-- Spammer indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_spammers_email ON spammers(email);
CREATE INDEX IF NOT EXISTS idx_spammers_domain ON spammers(domain);

-- Signature pattern indexes
CREATE INDEX IF NOT EXISTS idx_signature_patterns_email ON signature_patterns(email);

-- Pending operations indexes
CREATE INDEX IF NOT EXISTS idx_pending_ops_type ON pending_operations(type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_ops_unique ON pending_operations(type, folder_path, uid);
CREATE INDEX IF NOT EXISTS idx_pending_ops_status ON pending_operations(status);

-- Conversation extraction indexes
CREATE INDEX IF NOT EXISTS idx_conversation_extractions_thread ON conversation_extractions(thread_id);

-- ============================================================
-- Triggers
-- ============================================================

-- Update emails.updated_at timestamp
CREATE TRIGGER IF NOT EXISTS emails_update_timestamp
AFTER UPDATE ON emails
FOR EACH ROW
BEGIN
  UPDATE emails SET updated_at = unixepoch() WHERE id = NEW.id;
END;

-- Update folders.updated_at timestamp
CREATE TRIGGER IF NOT EXISTS folders_update_timestamp
AFTER UPDATE ON folders
FOR EACH ROW
BEGIN
  UPDATE folders SET updated_at = unixepoch() WHERE id = NEW.id;
END;

-- Update threads.updated_at timestamp
CREATE TRIGGER IF NOT EXISTS threads_update_timestamp
AFTER UPDATE ON threads
FOR EACH ROW
BEGIN
  UPDATE threads SET updated_at = unixepoch() WHERE id = NEW.id;
END;

-- (contacts' updated_at trigger lives with the table, in the shared directory)

-- Update sender_stats.updated_at on update
CREATE TRIGGER IF NOT EXISTS sender_stats_update_timestamp
AFTER UPDATE ON sender_stats
FOR EACH ROW
BEGIN
  UPDATE sender_stats SET updated_at = unixepoch() WHERE id = NEW.id;
END;

-- ============================================================
-- Seed Data: Default AI Category Definitions
-- ============================================================

INSERT OR IGNORE INTO ai_category_definitions (slug, name, description, prompt, icon, color, sort_order, is_system, is_enabled) VALUES
('important', 'Important', 'Urgent emails needing immediate attention',
'TRUE ONLY if the email requires the user''s IMMEDIATE attention or action TODAY.
IMPORTANT means URGENT — not just relevant or from a known person.
Mark TRUE ONLY when:
  * Deadline is TODAY or OVERDUE
  * Escalation from a customer or boss
  * Production outage, security incident, or critical system alert
  * Legal/compliance matter requiring immediate response
  * Time-sensitive decision that cannot wait
Mark FALSE for:
  * Regular work emails even from important people (use needs_response instead)
  * Invoices and finance emails (they have their own categories)
  * Meeting invites (use meeting category)
  * CC emails — almost never important for CC recipient
  * Emails that can wait until tomorrow = NOT important',
'Star', 'yellow', 1, 1, 1),

('needs_response', 'Needs Response', 'Emails that require your reply',
'TRUE only when the sender genuinely needs something back from the user AND
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
  * User is only CC''d (informational copy, almost never needs a reply)
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
  * Partnership / guest-post / link-exchange / SEO pitches',
'MessageCircle', 'orange', 2, 1, 1),

('reminders', 'Reminders', 'Action items, deadlines, and tasks',
'TRUE if the email contains tasks, action items, or deadlines for the user.
Includes: due dates, "please do X", follow-up requests, action required notices.
FALSE if tasks are for other people or the user is just CC''d.
FALSE for meeting invites (those go in "meeting" category).',
'Bell', 'blue', 4, 1, 1),

('meeting', 'Meetings', 'Meeting requests and calendar events',
'TRUE if the email is about meetings, calendar events, or scheduling.
Includes: calendar invites, meeting requests, scheduling discussions, video call links, time/date proposals, .ics attachments.
FALSE for general emails that merely mention a date in passing.',
'Calendar', 'green', 5, 1, 1),

('invoice', 'Invoices', 'Invoices and bills from vendors',
'TRUE if the email IS an invoice, bill, or receipt for products/services:
  * Invoices from vendors or service providers
  * Bills for services rendered
  * Purchase receipts and order confirmations
  * Subscription renewal invoices
  * Billing statements for services used
NOT invoice (these belong in "finance" category):
  * Credit card transactions or bank alerts
  * Payment confirmations for your own expenses
  * Salary or payslip notifications',
'Receipt', 'cyan', 6, 1, 1),

('finance', 'Finance', 'Credit cards, bank alerts, payments, expenses',
'TRUE if the email is about personal/business finances:
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
  * Spam about crypto/forex',
'CreditCard', 'emerald', 7, 1, 1),

('promotions', 'Promotions', 'Sales outreach, newsletters, product marketing',
'TRUE for any email whose primary purpose is to sell, market, or promote —
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
    invoice or finance)',
'Megaphone', 'pink', 8, 1, 1);

-- ============================================================
-- User-Authored Categorization Rules ("Smart Rules")
-- ============================================================
-- Captured when the user gives a natural-language instruction about an
-- email ("don't mark this sender as important"). Scoped by sender /
-- domain / subject / thread. Injected into the AI categorization prompt
-- so the model respects user preferences.

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

CREATE INDEX IF NOT EXISTS idx_rules_scope_value
  ON user_categorization_rules(scope, scope_value)
  WHERE active = 1;

-- ============================================================
-- Agent Prompt Templates (user-editable)
-- ============================================================
-- Three prompt keys drive the AI agent:
--   - categorization_system  (classify + needs_response + should_auto_draft)
--   - agent_plan             (decide whether to search before drafting)
--   - agent_draft            (produce the reply body)
-- Seeded with defaults on first run by the TS layer; users can edit the
-- `content` column from Settings → AI → Agent → Prompt Templates.

CREATE TABLE IF NOT EXISTS agent_prompt_templates (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  default_content TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- Database Metadata
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Mark this as version 24 (fresh start)
INSERT OR IGNORE INTO schema_version (version) VALUES (24);
