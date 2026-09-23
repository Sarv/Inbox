// Core data models for Sarv Inbox

/**
 * Email record stored in database
 */
export interface EmailRecord {
  id: string; // Unique identifier (generated)
  messageId: string; // IMAP Message-ID header
  threadId: string; // Thread identifier
  folderId: string; // Primary IMAP folder for sync reference
  uid: number; // IMAP UID for this message in folder

  // Owning account id. Only populated in-memory for cross-account (unified
  // "All Inboxes") views, where rows from different per-account DBs are merged
  // and need to be attributed/colored by account. Not persisted per-DB (each
  // account's rows already live in that account's own database).
  accountId?: string;

  // Unified tags: folders + flags + categories all in one
  // Format: '|INBOX|read|starred|important|needs_response|'
  // Replaces: flags[], labels[], is_starred, is_important, email_folders, email_category_assignments
  tags: string;

  // Headers
  subject: string | null;
  fromAddress: string; // Email address
  fromName: string | null; // Display name
  toAddress: string; // Comma-separated
  toNames: string | null;
  ccAddress: string | null;
  ccNames: string | null;
  bccAddress: string | null;
  bccNames: string | null;
  replyTo: string | null;

  // Timestamps
  date: number; // Unix timestamp (seconds)
  receivedDate: number | null; // When we synced it

  // Content
  cleanBody: string; // Cleaned Markdown (reply/forward stripped). LIST queries
                     // return only a bounded SNIPPET here (preview); full body
                     // comes from getById / getByThreadId / fetchBody.
  rawBody: string; // Original HTML or text. Absent on LIST rows (excluded for
                   // weight) — use `hasBody` to tell "body is in the DB" apart
                   // from "not loaded"; the full body loads on open (DB-first).
  /** True when the DB holds a body for this row. Set on LIST rows (where rawBody
   *  is omitted); on full rows it reflects rawBody presence. */
  hasBody?: boolean;
  contentType: 'text' | 'html' | 'multipart';
  contentHash: string; // SHA-256 hash for deduplication

  // Threading
  inReplyTo: string | null; // Message-ID of parent
  references: string | null; // Space-separated Message-IDs

  // Metadata
  priority: 'low' | 'normal' | 'high' | null;

  // Attachments
  hasAttachments: boolean;
  attachmentCount: number;
  attachmentNames: string | null; // JSON array of filenames
  attachmentSizes: string | null; // JSON array of byte sizes, parallel to attachmentNames

  // Calendar invite (iCalendar / .ics). Raw ICS text captured on body-fetch when
  // the message carries a text/calendar part or a .ics attachment; null otherwise.
  // Rendered as a Gmail-style event card in the detail view (see parseCalendarInvite).
  calendarIcs?: string | null;
  // True once the user added this invite to their OS calendar ("Add to calendar").
  // Drives the banner's persisted "Added to calendar" state.
  calendarAdded?: boolean;

  // AI features
  hasEmbedding: boolean;
  embeddingLastGenerated: number | null; // Unix timestamp

  // Importance scoring
  importanceScore?: number;
  importanceSource?: 'none' | 'provider' | 'ai' | 'user' | 'rule';
  authStatus?: string; // JSON string of AuthStatus (SPF/DKIM/DMARC)

  // Spam filter, header stage (see core utils/spam-signals). Scored once at
  // ingest; NULL means "not scored" (synced before the filter existed, or the
  // user's own outgoing mail), which is distinct from a score of 0.
  spamScore?: number | null;
  spamReasons?: string | null; // JSON array of SpamReason
  // The address that handed the message to the recipient's mail system, for
  // the reputation stage (blocklists, reverse DNS). NULL when no header names
  // a public one.
  originIp?: string | null;
  // The user's own verdict, which outranks every score: 'ham' = never file it
  // again, 'spam' = spam whatever the score. NULL when they have not said.
  spamUserVerdict?: 'spam' | 'ham' | null;

  // AI processing metadata
  aiProcessedAt?: number | null;
  aiConfidence?: number;
  aiReasoning?: string | null;

  // Agent priority score (0-100, from BehaviorIntelligence)
  priorityScore?: number;

  // Snooze
  snoozeUntil?: number | null;
  snoozeOriginalTags?: string | null;

  // Computed/joined fields (optional)
  threadMessageCount?: number; // Total messages in thread, Trash/Spam excluded (from subquery)
  threadFirstSender?: string; // Oldest sender name in full thread (from subquery)
  threadLastSender?: string; // Newest sender name in full thread (from subquery)

  // Timestamps
  createdAt: number; // Unix timestamp
  updatedAt: number; // Unix timestamp

  // ===== Compatibility helpers (computed from tags, not stored) =====
  // These are derived at read-time from the tags column for backward compat
  flags?: string[]; // Derived: tags → IMAP flags
  labels?: string[]; // Derived: tags → label names
  isImportant?: boolean; // Derived: tags contains |important|
  isStarred?: boolean; // Derived: tags contains |starred|
}

/**
 * Folder (mailbox) record
 */
export interface FolderRecord {
  id: string; // Unique identifier (generated)
  name: string; // Display name (e.g., "INBOX")
  path: string; // Full IMAP path
  parentId: string | null; // Parent folder ID (for nested folders)

  // IMAP sync state
  uidValidity: number | null; // IMAP UIDVALIDITY
  lastSyncUid: number | null; // Last synced UID
  lastSyncTime: number | null; // Unix timestamp
  highestModseq?: number | null; // CONDSTORE: highest MODSEQ for efficient flag sync

  // Counts
  totalCount: number;          // Rows TAGGED with this folder (a shared message counts under every name)
  unreadCount: number;         // Local DB unread count for this folder
  serverMessageCount?: number; // IMAP server message count (for "load more")

  // Rows FILED here (primary folder_id), counted once. Not stored: attached in
  // memory by withFiledCounts for contested roles only, so it survives the IPC
  // trip to the renderer's findFolderByType. Absent means "not measured".
  ownedCount?: number | null;

  // Historical backfill progress. The background scheduler pages older mail
  // DOWNWARD by UID; backfillOldestUid is the lowest UID reached so far (the
  // exclusive floor for the next chunk), and backfillComplete flips true once
  // paging reaches UID 1. Null/false = not started / still in progress.
  backfillOldestUid?: number | null;
  backfillComplete?: boolean;

  // Metadata
  specialUse: string | null; // '\\Inbox', '\\Sent', '\\Drafts', etc.
  subscribed: boolean;

  // Per-folder sync policy (v68). syncEnabled=false skips this folder entirely;
  // syncMode undefined/null = use the global setting, else 'full' | 'headers';
  // keepDays null = unlimited retention (reserved for a future prune).
  syncEnabled?: boolean;
  syncMode?: 'full' | 'headers' | null;
  keepDays?: number | null;

  // Timestamps
  createdAt: number;
  updatedAt: number;
}

/**
 * Thread (conversation) record
 */
export interface ThreadRecord {
  id: string; // Unique thread identifier (generated)
  subject: string; // Normalized subject (without Re:, Fwd:)

  // Thread metadata
  firstMessageId: string; // ID of first email
  lastMessageId: string; // ID of most recent email
  lastMessageDate: number; // Unix timestamp
  messageCount: number;

  // Participants
  participants: string; // Comma-separated email addresses

  // Thread state
  hasUnread: boolean;
  hasFlagged: boolean;
  labels: string[]; // Aggregate of all email labels

  // Timestamps
  createdAt: number;
  updatedAt: number;
}

/**
 * Attachment record (stored separately, not as blob)
 */
export interface AttachmentRecord {
  id: string;
  emailId: string;
  filename: string;
  contentType: string;
  size: number; // Bytes
  filePath: string; // Path to file on disk

  createdAt: number;
}

/**
 * Embedding metadata
 */
export interface EmbeddingMetadata {
  emailId: string;
  contentHash: string; // Hash of content that was embedded
  modelName: string; // e.g., "text-embedding-ada-002"
  dimensions: number; // e.g., 1536
  provider: string; // e.g., "openai"

  createdAt: number;
}

/**
 * Account configuration
 */
export interface AccountConfig {
  id: string;
  name: string; // Display name
  email: string;

  // IMAP settings
  imap: {
    host: string;
    port: number;
    secure: boolean; // Use TLS/SSL
    username: string;
    password: string; // Encrypted in storage
    authMethod: 'password' | 'oauth2';
  };

  // SMTP settings (for future compose feature)
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
  };

  // AI provider settings
  aiProvider?: {
    embeddings: {
      provider: string; // e.g., "openai"
      apiBaseUrl: string;
      apiKey: string; // Encrypted
      modelName: string;
    };
    llm: {
      provider: string;
      apiBaseUrl: string;
      apiKey: string;
      modelName: string;
    };
  };

  // Sync settings
  syncEnabled: boolean;
  syncInterval: number | null; // Minutes

  createdAt: number;
  updatedAt: number;
}

/**
 * Search query options
 */
export interface SearchQuery {
  query: string;
  folderIds?: string[];
  folderPath?: string;       // Direct folder path for tag-based filtering (e.g. 'INBOX')
  scope?: 'all' | 'folder';  // 'all' = exclude Trash/Spam/Sent/Drafts; 'folder' = scope to folderPath
  aiCategory?: string;       // AI category slug filter
  noCategory?: boolean;      // Only mail with NO AI category (unlabelled)
  /**
   * Arbitrary tag names that must ALL be present (`tag:vip tag:receipt`).
   *
   * The only search surface for a tag an extension applied: those are written
   * straight into `emails.tags` and never become a folder, an AI category or an
   * IMAP flag, so without this they exist in the database and are reachable
   * from nowhere in the UI. Folder/category/flag tags happen to be matchable
   * here too, but each already has its own dedicated field above.
   */
  tags?: string[];
  threadIds?: string[];
  from?: string;
  to?: string;
  subject?: string;
  hasAttachments?: boolean;
  isUnread?: boolean;
  isFlagged?: boolean;
  labels?: string[];
  dateFrom?: number; // Unix timestamp
  dateTo?: number;
  limit?: number;
  offset?: number;
  doesntHave?: string;    // NOT text match (exclude emails containing these words)
  sizeMin?: number;       // Minimum size in bytes (uses length of raw_body as proxy)
  sizeMax?: number;       // Maximum size in bytes
  cc?: string;            // cc_address LIKE match
  sortBy?: 'date' | 'from' | 'subject' | 'relevance';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Pagination options
 */
/** A lightweight view filter ANDed onto list queries (unread/starred/attachment),
 *  so folder + unified/All-Inboxes lists can honor an active search filter. */
export interface ViewFilter {
  isUnread?: boolean;      // true = only unread, false = only read
  isFlagged?: boolean;     // true = only starred/flagged
  hasAttachments?: boolean; // true = only with attachments
  noCategory?: boolean;    // true = only mail with NO AI category (unlabelled)
}

export interface PaginationOptions {
  limit: number;
  offset: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  filter?: ViewFilter;
}

/**
 * Storage statistics
 */
export interface StorageStats {
  totalEmails: number;
  totalThreads: number;
  totalFolders: number;
  totalAttachments: number;
  totalEmbeddings: number;
  databaseSize: number; // Bytes
  attachmentsSize: number; // Bytes
  lastSyncTime: number | null;
}

/**
 * Contact record - extracted from email communications
 */
// Re-export agent types for convenience
export type {
  UserActionLog,
  UserActionType,
  ActionSource,
  AgentDecision,
  AgentDecisionStatus,
  SenderDailyMetrics,
  PipelineEventLog,
  AgentConfig,
  BehaviorProfile,
  AgentProposal,
  AgentReplyDraft,
  IAgentStorage,
  ActionStats,
} from './agent';

/**
 * Contact record - extracted from email communications
 */
export interface ContactRecord {
  id: string;
  email: string; // Unique email address
  name: string | null; // Name from email header
  displayName: string | null; // User-edited display name
  avatarUrl: string | null; // Cached photo (a data: URI) once discovered
  /** Confirm-gate for `avatarUrl`: null=never checked, 'pending'=candidate
   *  awaiting user review, 'confirmed'=show it, 'rejected'=keep initials. */
  avatarStatus: 'pending' | 'confirmed' | 'rejected' | null;
  /** When the background discovery last checked for a photo (throttle). */
  avatarCheckedAt: number | null;
  organization: string | null;
  title: string | null;
  phone: string | null;

  // Activity tracking
  firstSeen: number; // Unix timestamp - first email
  lastSeen: number; // Unix timestamp - most recent email
  emailCount: number; // Total emails with this contact
  sentCount: number; // Emails sent to this contact
  receivedCount: number; // Emails received from this contact

  // User preferences
  isFavorite: boolean;
  notes: string | null;
  tags: string[]; // User-defined tags
  metadata: Record<string, any>; // Extensible metadata

  // Agent classification (single source of truth — agent dashboard and
  // the main Contacts view both read these off the contacts table).
  // `contactType` is the assigned category (existing_customer, vendor,
  // newsletter, …); `contactTypeSource` distinguishes user-edited vs.
  // heuristic vs. LLM-classified so overwrites know what to respect.
  contactType?: string | null;
  contactTypeConfidence?: number | null;
  contactTypeSource?: string | null;

  // Enrichment (v39) — individual vs company, identity grouping, and
  // LinkedIn/social/phone data mined from email signatures. See
  // ContactEnrichment below for the blob shape. `personId` groups rows
  // that are the same human across different employers. `companyContactId`
  // points at the auto-synthesized company contact row.
  kind?: 'individual' | 'company' | null;
  personId?: string | null;
  companyContactId?: string | null;
  mobileE164?: string | null;
  enrichment?: ContactEnrichment | null;
  enrichedThroughEmailAt?: number | null;
  enrichmentSource?: 'llm' | 'user' | null;

  // Timestamps
  createdAt: number;
  updatedAt: number;
}

/**
 * Enrichment blob stored on the contact row. LLM-populated from email
 * signatures. Personal-vs-company distinction lives inside the blob
 * (two phone fields, two URL sets) so the UI can surface both without
 * extra joins.
 */
export interface ContactEnrichment {
  /**
   * The person's full name as written in their signature.
   *
   * `contacts.name` otherwise comes only from the From display name, so a
   * sender whose header is a bare `<pkh@sarv.com>` is stuck with a local-part
   * fallback ("Pkh") even when every one of their mails signs off "Pooja
   * Khatri". Enrichment already reads the signature block, so it can supply
   * the real name.
   */
  fullName?: string | null;
  designation?: string | null;
  department?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  companyWebsite?: string | null;
  companyAddress?: string | null;
  linkedinUrl?: string | null;
  twitterUrl?: string | null;
  githubUrl?: string | null;
  personalPhone?: string | null;
  companyPhone?: string | null;
  whatsappNumber?: string | null;
  personalEmail?: string | null;
  location?: string | null;
  pronouns?: string | null;
  otherSocials?: Array<{ platform: string; url: string }>;
  notes?: string | null;
}

/**
 * One row per detected enrichment change. The row with `effectiveTo = null`
 * is the current state; closed rows (effectiveTo set) are the audit trail
 * — most useful when someone switches jobs and we want to remember the
 * old company/title without dropping them.
 */
export interface ContactEnrichmentHistoryRecord {
  id: string;
  contactId: string;
  personId: string | null;
  enrichment: ContactEnrichment;
  companyContactId: string | null;
  designation: string | null;
  organization: string | null;
  effectiveFrom: number;
  effectiveTo: number | null;
  source: 'llm' | 'user';
  sourceEmailId: string | null;
  createdAt: number;
}
