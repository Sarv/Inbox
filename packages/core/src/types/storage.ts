// Storage interfaces for Sarv Inbox

import type { FilterRule, FilterRuleInput } from './filters';
import type { Label, LabelInput } from './labels';
import type {
  EmailRecord,
  FolderRecord,
  ThreadRecord,
  AttachmentRecord,
  EmbeddingMetadata,
  SearchQuery,
  PaginationOptions,
  StorageStats,
  ViewFilter,
} from './models';

// IAgentStorage is exported at the package root via the agent types barrel
// (`export * from './types/agent'`); re-exporting it here too produced a
// duplicate export at the root. Import it from '@sarvinbox/core' as usual.

/**
 * Email storage interface - implemented by platform-specific packages
 */
export interface IEmailStorage {
  // ========== Connection & Lifecycle ==========

  /**
   * Initialize storage (open database, run migrations)
   */
  initialize(): Promise<void>;

  /**
   * Close storage connection
   */
  close(): Promise<void>;

  /**
   * Check if storage is initialized
   */
  isInitialized(): boolean;

  // ========== Email Operations ==========

  /**
   * Insert a single email
   */
  insertEmail(email: EmailRecord): Promise<void>;

  /**
   * Insert multiple emails (batch operation)
   */
  insertEmailBatch(emails: EmailRecord[]): Promise<void>;

  /**
   * Update an email
   */
  updateEmail(id: string, updates: Partial<EmailRecord>): Promise<void>;

  /**
   * Register the mailbox owner's own address(es) so thread resolution can exclude
   * "self" from same-subject participant overlap. Optional; when omitted the
   * resolver falls back to its owner-inclusive heuristic.
   */
  setSelfAddresses?(addresses: string[]): void;

  /**
   * Get email by ID
   */
  getEmail(id: string): Promise<EmailRecord | null>;

  /**
   * Get email by Message-ID
   */
  getEmailByMessageId(messageId: string): Promise<EmailRecord | null>;

  /**
   * Get email by folder and UID
   * Used for efficient flag sync and deletion detection
   */
  getEmailByFolderAndUid(folderId: string, uid: number): Promise<EmailRecord | null>;

  /**
   * Batched (id, uid) lookup for a set of UIDs in ONE folder. Used by the QRESYNC
   * VANISHED reconcile, which can resolve thousands of UIDs at once — a point lookup
   * per UID would be N sequential queries. The caller chunks the UID list well under
   * SQLite's variable limit. Returns only rows that exist; order is not guaranteed.
   */
  getEmailIdsByFolderAndUids(folderId: string, uids: number[]): Promise<Array<{ id: string; uid: number }>>;

  /** Batch existence lookup by Message-ID (avoids per-message N+1 during sync). */
  getEmailsByMessageIds(messageIds: string[]): Promise<EmailRecord[]>;

  /** Batch fetch by primary id via a single chunked `IN (...)` query. Order is not guaranteed. */
  getEmailsByIds(ids: string[]): Promise<EmailRecord[]>;

  /**
   * Emails stored with an incomplete envelope (blank sender/subject or a
   * synthesized "<missing-...>" Message-ID). Used by the repair pass.
   */
  getIncompleteEmails(limit: number): Promise<EmailRecord[]>;

  /**
   * Delete an email
   */
  deleteEmail(id: string): Promise<void>;

  /**
   * Delete multiple emails
   */
  deleteEmails(ids: string[]): Promise<void>;

  /**
   * Delete all emails in a folder
   * Used when UIDVALIDITY changes (all cached UIDs become invalid)
   */
  deleteEmailsByFolder(folderId: string): Promise<number>;

  /**
   * Mark all emails in sent folders as read
   * Call this on startup to fix sent emails showing as unread
   */
  markSentEmailsAsRead(): Promise<number>;

  /**
   * Link an email to a folder (for multi-folder support)
   * Same email can exist in multiple folders (e.g., INBOX, All Mail, Important)
   */
  linkEmailToFolder(emailId: string, folderId: string, uid?: number, flags?: string[]): Promise<void>;

  /**
   * A batch of messages VANISHED from `folderId` on the server (expunged/moved).
   * For each: if the message still belongs to another folder (its tags carry
   * another real folder's path), drop only THIS folder's membership (repointing
   * the primary if needed); otherwise delete the row. Prevents a webmail move
   * (e.g. Trash → Inbox) from erasing the message from both folders.
   */
  unlinkOrDeleteEmailsFromFolder(emailIds: string[], folderId: string): Promise<{ unlinked: number; deleted: number }>;

  /**
   * Re-key a whole folder after a UIDVALIDITY change without destroying rows that
   * still live in other folders: unlink-or-delete every row tagged with this
   * folder (multi-folder rows keep their other memberships with uid cleared;
   * single-folder rows are deleted). Optional — folder-sync falls back to a plain
   * per-folder wipe when a storage impl omits it.
   */
  invalidateFolderMembership?(folderId: string): Promise<{ unlinked: number; deleted: number }>;

  /**
   * Get all folders an email belongs to (with UIDs)
   */
  getEmailFolders(emailId: string): Promise<{ folderId: string; uid: number | null; flags: string[] }[]>;

  // ========== Query Operations ==========

  /**
   * Search emails with complex query
   */
  searchEmails(query: SearchQuery): Promise<EmailRecord[]>;

  /**
   * Get emails in a folder
   */
  getEmailsByFolder(
    folderId: string,
    // `collapseThreads` opts into the read-model (thread_folders) fast path,
    // which returns thread-collapsed pages (indexed, no full-table scan). Only
    // the interactive folder view sets it — bulk callers (contact extraction,
    // unified-inbox merge) need raw per-message, folder-scoped rows and stay on
    // the legacy path.
    options: PaginationOptions & { categoryTag?: string; collapseThreads?: boolean }
  ): Promise<EmailRecord[]>;

  /**
   * How many messages `getEmailsByFolder` would return under the same filter —
   * the "of N" for a per-message folder listing (no thread collapsing).
   *
   * Optional: storages that can't count cheaply simply omit it, and callers
   * fall back to "unknown total" rather than a wrong one.
   */
  countEmailsInFolder?(
    folderId: string,
    options?: { filter?: ViewFilter; categoryTag?: string }
  ): Promise<number>;

  /**
   * Get emails in a thread
   */
  getEmailsByThread(threadId: string): Promise<EmailRecord[]>;

  /**
   * Full-text search
   */
  fullTextSearch(
    query: string,
    options?: SearchQuery
  ): Promise<EmailRecord[]>;

  // ========== Folder Operations ==========

  /**
   * Sync folders (upsert)
   */
  syncFolders(folders: FolderRecord[]): Promise<void>;

  /**
   * Get all folders
   */
  getFolders(): Promise<FolderRecord[]>;

  /**
   * Get folder by ID
   */
  getFolder(id: string): Promise<FolderRecord | null>;

  /**
   * Get folder by path
   */
  getFolderByPath(path: string): Promise<FolderRecord | null>;

  /**
   * Update folder
   */
  updateFolder(id: string, updates: Partial<FolderRecord>): Promise<void>;

  /**
   * Delete folder
   */
  deleteFolder(id: string): Promise<void>;

  /**
   * Recalculate totalCount and unreadCount for all folders from actual email data
   */
  recalculateFolderCounts(folderPaths?: string[]): Promise<void>;

  /**
   * Scan-free `unread_count` maintenance for a batch of read-flag flips (bulk
   * mark-read/unread, realtime flag sync): an indexed, thread-scoped ±1 delta per
   * affected folder instead of a full-table recount. Above an internal threshold
   * it falls back to a full recount. Optional — callers fall back to
   * recalculateFolderCounts when a storage impl omits it.
   */
  applyReadFlagToFolderCountsBatch?(flips: Array<{ emailId: string; nowRead: boolean }>): Promise<void>;

  /**
   * {id, uid} for every email whose PRIMARY folder is `folderId` with a server
   * UID. Optional: powers whole-folder deletion detection (non-CONDSTORE); when
   * a storage impl omits it, deletion detection falls back to a recent window.
   */
  getEmailUidsInFolder?(folderId: string): Promise<Array<{ id: string; uid: number }>>;

  /**
   * Lowest server UID among emails whose PRIMARY folder is `folderId`, or null
   * when the folder holds no UID-bearing mail. Optional: the historical backfill
   * uses it as the starting floor to page older mail downward.
   */
  getOldestUidInFolder?(folderId: string): Promise<number | null>;

  /**
   * Lightweight `{id, uid, tags}` for every email whose PRIMARY folder is
   * `folderId` (same row set as `getEmailUidsInFolder`). The cheap counterpart
   * to `getEmailsByFolder` for IMAP flag reconciliation: an index-driven keyset
   * scan with no thread metadata and no body columns, where the paginated
   * `getEmailsByFolder` sweep was quadratic and materialised every message body
   * just to read a tag string.
   */
  getEmailTagsInFolder?(folderId: string): Promise<Array<{ id: string; uid: number | null; tags: string }>>;

  /**
   * Count every email carrying `folderPath` as a folder-membership TAG — the same
   * membership the folder view renders (`instr(tags, '|path|')`), which includes
   * cross-folder messages whose PRIMARY folder is elsewhere (a reply that lives in
   * both Inbox and Sent). This differs from the primary-`folder_id` count and is
   * what the addition reconcile checks to decide whether anything is GENUINELY
   * missing — a tag-linked message already shows in the view, so it must not be
   * re-fetched every sync. Optional: when omitted, the reconcile falls back to the
   * folder_id UID diff.
   */
  countEmailsWithFolderTag?(folderPath: string): Promise<number>;

  /**
   * Count every email FILED in `folderId` — rows whose PRIMARY folder is this
   * one (`emails.folder_id`), each message counted once.
   *
   * The counterpart to {@link countEmailsWithFolderTag}, and the only one of
   * the two that can tell two names for a single mailbox apart. A message that
   * belongs to two folders is one row carrying both membership tags, so the tag
   * count reads the full mailbox under BOTH names of an aliased Sent while the
   * filed count reads the truth: everything under the name it was synced from,
   * nothing under the alias. Optional: when omitted, callers fall back to the
   * stored tag count.
   */
  countEmailsFiledIn?(folderId: string): Promise<number>;

  /**
   * Every email carrying `folderPath` as a membership TAG whose PRIMARY folder is
   * a DIFFERENT folder (`folder_id != folderId`): a Trash/Junk copy of a message
   * that still carries |INBOX|, a Gmail label mirror, a reply in both Inbox and
   * Sent. Such a row has no uid in this folder's UID space, so the deletion
   * reconcile (which diffs primary uids) can never see its membership here
   * vanish; the stale-membership sweep verifies them by Message-ID instead.
   * `folderId`/`uid` are the row's PRIMARY folder + uid, so the caller can skip
   * rows with a pending local op there. Rows whose primary IS this folder but
   * with a NULL uid (a local restore awaiting its first sync) are excluded — they
   * are in transition, not stale. Optional: when omitted, the sweep is skipped.
   */
  getFolderMembersOutsideUidSpace?(
    folderId: string,
    folderPath: string,
  ): Promise<Array<{ id: string; messageId: string; folderId: string; uid: number | null }>>;

  /**
   * Apply many tag updates in chunked transactions, yielding between chunks.
   * Vastly cheaper than a loop of `updateEmail` (which re-SELECTs each row —
   * bodies included — and commits per row). Used by flag reconciliation, where
   * one pass can legitimately touch thousands of rows.
   */
  bulkUpdateTags?(updates: Array<{ id: string; tags: string }>): Promise<void>;

  // ========== Thread Operations ==========

  /**
   * Upsert thread
   */
  upsertThread(thread: ThreadRecord): Promise<void>;

  /**
   * Get thread by ID
   */
  getThread(id: string): Promise<ThreadRecord | null>;

  /**
   * Get all threads (with pagination)
   */
  getThreads(options: PaginationOptions): Promise<ThreadRecord[]>;

  /**
   * Update thread
   */
  updateThread(id: string, updates: Partial<ThreadRecord>): Promise<void>;

  /**
   * Delete thread
   */
  deleteThread(id: string): Promise<void>;

  /**
   * Rebuild threads (recompute threading for all emails)
   * Returns statistics about the rebuild operation
   */
  rebuildThreads(): Promise<{ emailsUpdated: number; threadsCreated: number }>;

  // ========== Attachment Operations ==========

  /**
   * Insert attachment metadata
   */
  insertAttachment(attachment: AttachmentRecord): Promise<void>;

  /**
   * Get attachments for an email
   */
  getAttachments(emailId: string): Promise<AttachmentRecord[]>;

  /**
   * Delete attachment
   */
  deleteAttachment(id: string): Promise<void>;

  // ========== Spammer Check ==========

  /**
   * Check if an email address is a known spammer
   */
  isSpammer(email: string): Promise<boolean>;

  // ========== Remote-image sender allowlist (per account) ==========

  /** Remember a sender so their future mail auto-loads remote images
   *  (idempotent). Called when the user clicks "Load images" on a message. */
  allowSenderImages(email: string): Promise<void>;

  /** Every sender the user has allowed images from — the renderer loads this
   *  into an in-memory set for its synchronous block-vs-load decision. */
  getImageAllowedSenders(): Promise<string[]>;

  // ========== Statistics & Maintenance ==========

  /**
   * Get storage statistics
   */
  getStats(): Promise<StorageStats>;

  /**
   * Vacuum database (compact and optimize)
   */
  vacuum(): Promise<void>;

  /**
   * Run integrity check
   */
  checkIntegrity(): Promise<boolean>;

  // ========== Pending Operations (Retry Queue) ==========

  /**
   * Save a pending operation (INSERT OR REPLACE by type+folder+uid)
   * Returns the numeric rowid
   */
  savePendingOperation(op: {
    type: string;
    folderPath: string;
    uid: number;
    data?: any;
    retryCount: number;
  }): Promise<number>;

  /**
   * Save multiple pending operations in a single transaction
   * Returns array of numeric rowids
   */
  savePendingOperationsBatch(ops: Array<{
    type: string;
    folderPath: string;
    uid: number;
    data?: any;
    retryCount: number;
  }>): Promise<number[]>;

  /**
   * Get all pending operations
   */
  getPendingOperations(): Promise<Array<{
    id: number;
    type: string;
    folderPath: string;
    uid: number;
    data?: any;
    status: string;
    retryCount: number;
  }>>;

  /**
   * Durable backstop for `getPendingUids`: UIDs in `folderPath` that still have
   * a persisted pending operation (status pending/executing/failed). Covers the
   * windows where the in-memory queue is empty but SQLite is not — a dead-lettered
   * op or a mid-drain (queue cleared for the batch). Read-only; no migration.
   */
  getPendingOperationUidsByFolder(folderPath: string): Promise<number[]>;

  /**
   * Update the status of a pending operation
   */
  updatePendingOperationStatus(id: number, status: string): Promise<void>;

  /**
   * Update retry count of a pending operation
   */
  updatePendingOperationRetry(id: number, retryCount: number): Promise<void>;

  /**
   * Delete a pending operation
   */
  deletePendingOperation(id: number): Promise<void>;

  /**
   * Delete multiple pending operations in a single transaction
   */
  deletePendingOperationsBatch(ids: number[]): Promise<void>;

  /**
   * Clear all pending operations
   */
  clearPendingOperations(): Promise<void>;

  // ---- Dead-letter (failed) operations ----

  /**
   * Mark a pending operation as permanently failed (dead-letter) instead of
   * dropping it. Records the error and stamps updated_at.
   */
  markPendingOperationFailed(
    id: number,
    lastError: string,
    detail?: { attemptedCommand?: string; serverResponse?: string },
  ): Promise<void>;

  /**
   * List operations in the 'failed' (dead-letter) state.
   */
  getFailedOperations(): Promise<PendingOperationRecord[]>;

  /**
   * Reset a failed operation back to 'pending' so the queue retries it.
   */
  resetFailedOperation(id: number): Promise<void>;

  /**
   * Discard every dead-lettered operation (status='failed'). Returns the count
   * removed. Pending/executing operations are left untouched.
   */
  deleteFailedOperations(): Promise<number>;

  /**
   * Counts of pending (retryable) and failed (dead-letter) operations.
   */
  getPendingOperationCounts(): Promise<{ pending: number; failed: number }>;

  // ========== Pending Sends (Outbox / Retry Queue) ==========

  /**
   * Persist an SMTP send BEFORE it is submitted. Returns the numeric rowid.
   * `nextRetryAt` (unix seconds) optionally HOLDS the send until that time — the
   * drain (getDueSends) skips a future next_retry_at. Used by the undo-send hold:
   * the send is durable in the outbox immediately, but not transmitted until the
   * short undo window elapses (or it's cancelled). Omit/undefined = due now.
   */
  savePendingSend(payload: unknown, nextRetryAt?: number): Promise<number>;

  /**
   * Cancel a send that is still HELD for the undo window: delete it only when it
   * is 'pending' with a future next_retry_at (never yet attempted). Returns true
   * if a row was removed. A send already committed/executing/failed is left
   * untouched (returns false) — once transmission has begun, "undo" is too late,
   * which is the safe failure (a delivered mail beats a lost one).
   */
  cancelHeldSend(id: number): Promise<boolean>;

  /**
   * Release an undo-hold: clear next_retry_at so the send becomes due now. Called
   * when the undo window elapses so the next drain transmits it immediately.
   */
  clearSendHold(id: number): Promise<void>;

  /**
   * Sends that are due to be (re)attempted now: status='pending' and
   * next_retry_at is null or in the past. Ordered oldest-first.
   */
  getDueSends(now: number): Promise<PendingSendRecord[]>;

  /**
   * Every send in the outbox (pending + failed) for display.
   */
  getAllSends(): Promise<PendingSendRecord[]>;

  /**
   * Record a failed-but-retryable attempt: bump retry_count, store the error,
   * schedule the next attempt, and keep status='pending'.
   */
  updatePendingSendAttempt(id: number, retryCount: number, lastError: string, nextRetryAt: number): Promise<void>;

  /**
   * Set a send's status ('pending' | 'executing' | 'failed').
   */
  updatePendingSendStatus(id: number, status: string): Promise<void>;

  /**
   * Move a send to the 'failed' (dead-letter) state, recording the error.
   */
  markPendingSendFailed(id: number, lastError: string): Promise<void>;

  /**
   * Record that a send's SMTP submission was accepted but its Sent-folder APPEND
   * still needs to run. Persists the raw MIME + Message-ID and sets
   * smtp_accepted=1 / sent_append_pending=1 so the APPEND can be completed — or
   * redone after a crash — WITHOUT ever re-submitting the message to SMTP.
   */
  markSendAppendPending(id: number, rawMime: string, messageId: string): Promise<void>;

  /**
   * Sends whose SMTP submission already succeeded but whose Sent-folder APPEND
   * still needs to run (crash recovery / retry). These must NEVER be re-sent —
   * only appended — because smtp_accepted is already set.
   */
  getAppendPendingSends(): Promise<PendingSendRecord[]>;

  /**
   * Reset a send back to 'pending' for an immediate manual retry.
   */
  resetPendingSend(id: number): Promise<void>;

  /**
   * Delete a send from the outbox (on success or user discard).
   */
  deletePendingSend(id: number): Promise<void>;

  /**
   * Discard every failed send (status='failed'). Returns the count removed.
   * Pending/executing/append-pending sends are left untouched so a queued or
   * already-accepted message is never dropped.
   */
  deleteFailedSends(): Promise<number>;

  /**
   * Clear the entire outbox.
   */
  clearPendingSends(): Promise<void>;

  /**
   * Counts of pending (retryable) and failed (dead-letter) sends.
   */
  getPendingSendCounts(): Promise<{ pending: number; failed: number }>;

  // ========== Filter Rules ==========

  /** All filter rules, highest priority first. */
  getFilterRules(): Promise<FilterRule[]>;

  /** Only enabled rules (used by the ingest evaluation path). */
  getEnabledFilterRules(): Promise<FilterRule[]>;

  /** Create a rule; returns the persisted rule with id/timestamps. */
  createFilterRule(input: FilterRuleInput): Promise<FilterRule>;

  /** Patch a rule; returns the updated rule, or null if it doesn't exist. */
  updateFilterRule(id: string, updates: Partial<FilterRuleInput>): Promise<FilterRule | null>;

  /** Delete a rule. */
  deleteFilterRule(id: string): Promise<void>;

  /** Reassign rule priorities from a top-to-bottom ordering of rule ids. */
  reorderFilterRules(orderedIds: string[]): Promise<void>;

  // ========== Labels ==========

  /** All labels, alphabetical. */
  getLabels(): Promise<Label[]>;

  /** Create a label; returns the persisted label. */
  createLabel(input: LabelInput): Promise<Label>;

  /** Patch a label; returns the updated label, or null if it doesn't exist. */
  updateLabel(id: string, updates: Partial<LabelInput>): Promise<Label | null>;

  /** Delete a label. */
  deleteLabel(id: string): Promise<void>;
}

/**
 * A row from the pending_operations (IMAP retry) queue.
 */
export interface PendingOperationRecord {
  id: number;
  type: string;
  folderPath: string;
  uid: number;
  data: unknown;
  status: string;
  retryCount: number;
  lastError?: string | null;
  /** The IMAP command we sent (dead-lettered ops). Null for connection failures. */
  attemptedCommand?: string | null;
  /** The server's raw NO/BAD reply. Null when there was no server response. */
  serverResponse?: string | null;
  nextRetryAt?: number | null;
  createdAt: number;
}

/**
 * A row from the pending_sends (SMTP outbox) queue.
 */
export interface PendingSendRecord {
  id: number;
  payload: unknown;
  status: string;
  retryCount: number;
  lastError?: string | null;
  nextRetryAt?: number | null;
  createdAt: number;
  updatedAt: number;
  /** 1 once SMTP accepted the message — such a row must NEVER be re-sent. */
  smtpAccepted?: boolean;
  /** 1 while a Sent-folder APPEND still needs to run for this send. */
  sentAppendPending?: boolean;
  /** The exact raw MIME submitted to SMTP, reused for the Sent APPEND. */
  rawMime?: string | null;
  /** The message's Message-ID, used to reconcile / dedupe the Sent copy. */
  messageId?: string | null;
}

/**
 * Vector storage interface for embeddings
 */
export interface IVectorStorage {
  // ========== Connection & Lifecycle ==========

  /**
   * Initialize vector storage
   */
  initialize(): Promise<void>;

  /**
   * Close vector storage
   */
  close(): Promise<void>;

  // ========== Embedding Operations ==========

  /**
   * Insert a single embedding
   */
  insertEmbedding(
    emailId: string,
    embedding: number[],
    metadata: EmbeddingMetadata
  ): Promise<void>;

  /**
   * Insert multiple embeddings (batch)
   */
  insertEmbeddingBatch(
    embeddings: Array<{
      emailId: string;
      embedding: number[];
      metadata: EmbeddingMetadata;
    }>
  ): Promise<void>;

  /**
   * Check if embedding exists for email with specific content hash
   */
  hasEmbedding(emailId: string, contentHash: string): Promise<boolean>;

  /**
   * Get embedding metadata
   */
  getEmbeddingMetadata(emailId: string): Promise<EmbeddingMetadata | null>;

  /**
   * Delete embedding
   */
  deleteEmbedding(emailId: string): Promise<void>;

  /**
   * Delete multiple embeddings
   */
  deleteEmbeddings(emailIds: string[]): Promise<void>;

  // ========== Vector Search ==========

  /**
   * Search for similar emails by vector similarity
   */
  searchSimilar(
    queryEmbedding: number[],
    limit: number,
    threshold?: number
  ): Promise<SimilarityResult[]>;

  /**
   * Get embedding count
   */
  getEmbeddingCount(): Promise<number>;
}

/**
 * Result from vector similarity search
 */
export interface SimilarityResult {
  emailId: string;
  distance: number; // Cosine distance (0 = identical, 2 = opposite)
  similarity: number; // Similarity score (1 = identical, 0 = opposite)
}

/**
 * File storage interface (for attachments)
 */
export interface IFileStorage {
  /**
   * Save an attachment to disk
   */
  saveAttachment(
    emailId: string,
    filename: string,
    data: Buffer
  ): Promise<string>; // Returns file path

  /**
   * Get attachment data
   */
  getAttachment(filePath: string): Promise<Buffer>;

  /**
   * Delete attachment file
   */
  deleteAttachment(filePath: string): Promise<void>;

  /**
   * Get total attachments size
   */
  getTotalSize(): Promise<number>;

  /**
   * Clean up orphaned attachments (no corresponding email)
   */
  cleanupOrphaned(): Promise<number>; // Returns number of files deleted
}

/**
 * Transaction support for atomic operations
 */
export interface IStorageTransaction {
  /**
   * Begin transaction
   */
  begin(): Promise<void>;

  /**
   * Commit transaction
   */
  commit(): Promise<void>;

  /**
   * Rollback transaction
   */
  rollback(): Promise<void>;

  /**
   * Execute callback within transaction
   */
  execute<T>(callback: () => Promise<T>): Promise<T>;
}
