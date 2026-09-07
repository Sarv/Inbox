import type { EmailRecord, FolderRecord, Label, SyncStatus, RealtimeEvent, SMTPConfig, SendEmailOptions, ViewFilter } from '@sarvinbox/core';
import type { StateCreator } from 'zustand';

import type { InboxType, InboxSection } from '../config/inbox-types';
import type { SearchQuery } from '../services/ai-service';
import type { EmailThread } from '../utils/thread-utils';

// Compose email types
export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface ComposeState {
  isOpen: boolean;
  mode: ComposeMode;
  replyToEmail?: {
    id: string;
    /** Owning account of the replied mail (unified view) — reply sends AS it. */
    accountId?: string;
    subject: string;
    fromAddress: string;
    fromName: string | null;
    toAddress: string;
    ccAddress: string | null;
    date: number;
    cleanBody: string | null;
    rawBody: string | null;
  };
  /** AI-drafted reply body (plain text) — prefilled when agent suggests reply */
  draftBody?: string;
  /** Full existing draft being EDITED in the composer (standalone/new-compose
   *  draft opened from the Drafts list). Carries its own subject/recipients plus
   *  the message-id/thread/account needed to replace + delete it correctly. */
  draft?: {
    to?: string; cc?: string; bcc?: string; subject?: string;
    htmlContent?: string; attachments?: any[];
    draftMessageId?: string; threadId?: string; accountId?: string;
  };
}

// Connection status types
export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

// View mode types
export type ViewMode = 'no-split' | 'vertical' | 'horizontal';

// AI Processing detailed progress
export interface AIProcessingProgress {
  current: number;
  total: number;
  startTime: number;
  mode: 'bulk' | 'realtime';
  categorized: Record<string, number>;
  recentActivity: Array<{
    emailId: string;
    subject: string;
    fromAddress: string;
    categories: string[];
    confidence: number;
    timestamp: number;
  }>;
  failed: number;
  retried: number;
  lastError: string | null;
  currentBatch: number;
  batchSize: number;
  queueSize: number;
}

// --- Slice interfaces ---

/**
 * A configured mail account. Stage 1 of multi-account: the app keeps a list of
 * these (migrated from the legacy single-account credentials); the ACTIVE
 * account drives the existing flat folders/emails state. Data isolation is
 * per-account DB files in the main process (added in a later stage).
 */
export interface StoredAccount {
  id: string;
  email: string;
  name?: string;
  imapConfig: any;            // IMAPConfig
  smtpConfig: SMTPConfig | null;
  smtpConfigured: boolean;
  /** Stable display color (hex) for this account's dot/badge in the unified
   *  view and sidebar. Assigned on add; backfilled for legacy accounts. */
  color?: string;
  /** Include this account's mail in the unified "All Inboxes" view.
   *  Treated as true when undefined (legacy accounts). */
  includeInUnified?: boolean;
  /** Keep this account connected + IDLE in the background even when it isn't the
   *  active account, so new mail and notifications arrive live. True by default. */
  backgroundSync?: boolean;
  /** Show OS notifications for new mail in this account. True by default. */
  notify?: boolean;
  /** Send-as identities: the account's own address plus any aliases the server
   *  lets it send under. Normalised (own address first, deduped) on every
   *  load/upsert; the compose "From" picker offers these. Legacy accounts get
   *  `[email]` backfilled. */
  identities?: string[];
}

export interface ConnectionSlice {
  connected: boolean;
  imapConfig: any | null;
  /** All configured accounts (multi-account registry). */
  accounts: StoredAccount[];
  /** The account whose mailbox is currently shown; null when none configured. */
  activeAccountId: string | null;
  /** Ids currently being removed. Their rows show "Deleting…" and are disabled
   *  for the whole (often slow, when the connection is wedged) teardown, so the
   *  user can't click a half-torn-down account. Cleared on success or failure. */
  deletingAccountIds: string[];
  /** Set when a removal FAILS: `{ id, message }`. The row re-enables and shows
   *  the message; cleared when that account's removal is retried or succeeds. */
  accountActionError: { id: string; message: string } | null;
  checkingConnection: boolean;
  connectionStatus: ConnectionStatus;
  showConnectedMessage: boolean;
  /** Active account's mailbox storage quota in bytes; null when unknown/unavailable
   *  (disconnected, or the server doesn't advertise QUOTA). */
  quota: { used: number; limit: number } | null;
  /** Last-known quota per account id (persisted). Lets a switch or a cold start
   *  paint the bar immediately, with the live lookup refreshing it behind. A
   *  `null` value means "asked, this server has no quota"; a missing key means
   *  "never asked" — only the latter warrants a placeholder. */
  quotaByAccount: Record<string, { used: number; limit: number } | null>;
  /** True while a quota lookup for the active account is in flight. The bar uses
   *  it to hold its place — as a placeholder when there's no figure to show yet —
   *  so the sidebar never reflows around it. */
  quotaLoading: boolean;
  /** Refresh a quota (best-effort; no-op when disconnected). Defaults to the
   *  active account; pass an id when switching, so a slow reply for the account
   *  being left can't overwrite the one being entered. */
  loadQuota: (accountId?: string) => Promise<void>;
  smtpConnected: boolean;
  smtpConfig: SMTPConfig | null;
  /** True once the user has explicitly set up + verified SMTP (sending). Gates
   *  the app: an IMAP-connected account without verified SMTP is prompted for it. */
  smtpConfigured: boolean;

  checkConnection: () => Promise<boolean>;
  connect: (config: any) => Promise<void>;
  disconnect: () => Promise<void>;
  reconnect: () => Promise<void>;
  needsReauth: boolean;
  handleDisconnection: () => void;
  handleReconnection: () => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  /** Connect + verify SMTP. Pass an explicit config (from the SMTP setup form);
   *  otherwise falls back to the saved SMTP config or one derived from IMAP. */
  connectSmtp: (config?: SMTPConfig) => Promise<void>;
  disconnectSmtp: () => Promise<void>;
  markSmtpConfigured: (value?: boolean) => void;
  /** Remove sending (SMTP) for the ACTIVE account: drop the live session, clear
   *  its saved config, and mark it unconfigured (store + registry). IMAP stays;
   *  outgoing mail queues in the Outbox until SMTP is set up again. */
  removeSmtp: () => Promise<void>;
  /** Switch the active account: point the main process at it, then reconnect +
   *  reload that account's mailbox. No-op if it's already active. */
  selectAccount: (accountId: string) => Promise<void>;
  /** Connect a brand-new account (its own DB) and make it active. SMTP setup is
   *  then prompted by the usual overlay. */
  /** Verifies the credentials before persisting anything. Pass
   *  `{ alreadyVerified: true }` ONLY when the caller has just probed this exact
   *  config (the OAuth flow probes first so it can prompt before overwriting) —
   *  it skips the duplicate connection, never the safety. */
  addAccount: (imapConfig: any, opts?: { alreadyVerified?: boolean }) => Promise<void>;
  /** Remove an account from the registry; if active, switch to another (or none). */
  removeAccountById: (accountId: string) => Promise<void>;
  /** Set an account's send-as aliases (the extra From addresses; the account's own
   *  address is always kept). Normalised + persisted to the registry. */
  setAccountIdentities: (accountId: string, aliases: string[]) => void;
  /** Re-hydrate OAuth mail accounts from the main-process store into the local
   *  registry (self-heal a dropped Gmail/Outlook/Yahoo account). Idempotent. */
  reconcileOAuthAccounts: () => Promise<void>;
  /** Merge accounts from the durable DB registry (the main-owned source of
   *  truth) into the local registry, so a lost/corrupt localStorage can't drop
   *  an account. Runs once at startup, before reconcile/auto-connect. */
  hydrateAccountsFromDb: () => Promise<void>;
}

export interface SyncSlice {
  syncing: boolean;
  syncStatus: SyncStatus | null;
  syncingFolders: Map<string, number>;
  idleActive: boolean;
  idleFolder: string | null;

  /** True when mail sync has FAILED repeatedly on a socket that still looks
   *  connected — i.e. the app can't fetch new mail even though the connection
   *  dot would otherwise read "Live". Drives the sync-trouble banner and the
   *  amber "Sync issue" dot, so the user is never left silently waiting. */
  syncTrouble: boolean;
  /** Consecutive sync failures; `syncTrouble` flips on once this reaches the
   *  threshold (so a single blip stays silent, matching the anti-flicker design). */
  syncFailStreak: number;
  /** Epoch ms of the last SUCCESSFUL sync this session (null = none yet). */
  lastSyncOkAt: number | null;

  setSyncStatus: (status: SyncStatus) => void;
  /** Record a successful sync — resets the failure streak and clears trouble. */
  noteSyncOk: () => void;
  /** Record a failed sync — bumps the streak and raises trouble past threshold. */
  noteSyncFailure: (error?: unknown) => void;
  /** Clear trouble optimistically (on reconnect or a user-initiated retry). */
  clearSyncTrouble: () => void;
  syncEmails: (options?: { folders?: string[]; skipRecentMinutes?: number }) => Promise<void>;
  syncSingleFolder: (folderPath: string) => Promise<void>;
  ensureConnectionAndSync: () => Promise<void>;
  mergeNewEmails: (folderId: string) => Promise<void>;
  mergeNewEmailsVirtualAll: () => Promise<void>;
  mergeNewEmailsVirtualStarred: () => Promise<void>;
  startIdle: (folderPath: string) => Promise<void>;
  stopIdle: () => Promise<void>;
  handleRealtimeEvent: (event: RealtimeEvent) => void;
  handleFoldersUpdated: (accountId?: string, folderPath?: string) => void;
}

export interface EmailsSlice {
  folders: FolderRecord[];
  labels: Label[];
  selectedFolderId: string | null;
  loadingFolders: boolean;

  emails: EmailRecord[];
  selectedEmailId: string | null;
  highlightedEmailId: string | null;
  loadingEmails: boolean;
  loadingMoreEmails: boolean;
  hasMoreEmails: boolean;
  emailsOffset: number;
  /** 0-based current page for Gmail-style discrete pagination (flat/unified/AI). */
  emailsPage: number;
  /** "of N" denominator for the paginator (0 when the total is unknown). */
  emailsTotal: number;

  threadEmails: EmailRecord[];
  loadingThread: boolean;

  // Ids of messages that arrived (via IMAP IDLE) into the currently-open
  // thread AFTER it was opened. The reading pane is snapshotted at open time
  // and does not live-append, so these drive a "new message" banner the user
  // can dismiss or click to fold the new messages into the open conversation.
  pendingThreadEmailIds: string[];

  selectedVirtualFolder: string | null;
  viewingSnoozed: boolean;
  manuallyMarkedUnreadId: string | null;
  /** Account of the currently-open email. Only meaningful in the unified "All
   *  Inboxes" view, where the open message can belong to a non-active account —
   *  thread-load / body-fetch / actions route to this account's DB + engine. */
  viewAccountId: string | null;

  // Per-section data (DB-backed section queries)
  sectionData: Record<string, {
    emails: EmailRecord[];
    threads: EmailThread[];
    offset: number;
    hasMore: boolean;
    total: number;
    loading: boolean;
    /** 0-based current page for Gmail-style per-section pagination. */
    page?: number;
  }>;
  sectionLoading: Set<string>;

  loadingBodies: Set<string>;
  failedBodies: Set<string>;

  // Raw RFC822 source cache for "Show Original" — prefetched in the background
  // when a mail is opened so the modal opens instantly instead of showing a
  // loader. Keyed by email id; entries are the full source string.
  rawSourceCache: Record<string, string>;
  rawSourceLoading: Set<string>;
  prefetchRawSource: (emailId: string) => Promise<void>;

  setFolders: (folders: FolderRecord[]) => void;
  selectFolder: (folderId: string) => void;
  loadFolders: () => Promise<void>;
  loadLabels: () => Promise<void>;
  setEmailLabel: (emailId: string, label: string, on: boolean) => Promise<void>;
  showLabel: (label: string) => void;

  setEmails: (emails: EmailRecord[]) => void;
  selectEmail: (emailId: string) => void;
  loadEmails: (folderId: string) => Promise<void>;
  loadMoreEmails: () => Promise<void>;
  /** Jump to a 0-based page, REPLACING the visible rows (Gmail-style paging). */
  goToEmailPage: (page: number) => Promise<void>;
  loadEmail: (emailId: string) => Promise<void>;

  loadThread: (threadId: string) => Promise<void>;

  // Called on each IMAP IDLE 'new' event. If the arriving email resolves to
  // the currently-open thread, it is queued into pendingThreadEmailIds (banner)
  // instead of silently leaving the reading pane stale. No-op when no thread
  // is open or the message is already loaded/queued.
  noteNewEmailForOpenThread: (emailId?: string) => Promise<void>;
  // Fold the queued new messages into the open thread (re-fetches the thread)
  // and clear the banner.
  showPendingThreadMessages: () => Promise<void>;
  // Dismiss the banner without folding the messages in. They still appear the
  // next time the thread is opened (nothing is deleted — only the queue clears).
  dismissPendingThreadMessages: () => void;

  loadAllEmails: () => Promise<void>;
  loadImportantEmails: () => Promise<void>;
  loadStarredEmails: () => Promise<void>;
  refreshVirtualFolder: (type: 'all' | 'starred' | 'important' | 'snoozed' | 'unified') => Promise<void>;
  clearVirtualFolder: () => void;

  /** Unified "All Inboxes": merged INBOX across accounts that opted in. */
  selectUnifiedInbox: () => void;
  /** Per-account INBOX unread counts for the sidebar badges (accountId -> count). */
  accountUnread: Record<string, number>;
  refreshUnreadSummary: () => Promise<void>;
  /** Tier B: sync every opted-in INACTIVE account's INBOX once (serially),
   *  refreshing badges + the merged view. Overlap-guarded; safe to call on an
   *  interval. No-op with 0/1 accounts. */
  runBackgroundSyncCycle: () => Promise<void>;

  loadSnoozedEmails: () => Promise<void>;
  clearSnoozedView: () => void;
  showOutbox: () => void;

  loadSectionEmails: (sectionId: string, filter: string, folderPath?: string) => Promise<void>;
  loadMoreSectionEmails: (sectionId: string, filter: string, folderPath?: string) => Promise<void>;
  /** Jump a section to a 0-based page, REPLACING its rows (Gmail-style paging). */
  goToSectionPage: (sectionId: string, filter: string, page: number, folderPath?: string) => Promise<void>;
  /** Open a section as a full paginated page (its filter as a flat list). The
   *  page size = the section's "Show up to" (maxItems). */
  openSectionFullPage: (filter: string, label: string) => Promise<void>;
  /** Leave the full-page section view and return to the sectioned inbox. */
  closeSectionFullPage: () => Promise<void>;
  loadAllSections: (folderPath?: string) => Promise<void>;
  clearSectionData: () => void;

  _reloadCurrentView: () => Promise<void>;

  fetchEmailBody: (emailId: string) => Promise<void>;
  fetchBodiesForVisibleEmails: (emailIds: string[]) => Promise<void>;

  usesSectionNav: () => boolean;
  getNavigationThreads: () => import('../utils/thread-utils').EmailThread[];
  getNavigationTotalCount: () => number;
}

export interface PendingDelete {
  emailId: string;
  email: any;
  folderId: string | null;
  timeoutId: number;
  inTrash: boolean;
}

export interface EmailActionsSlice {
  pendingDeletes: PendingDelete[];
  /** Resolve an email's owning account (unified view routing). Internal helper. */
  _accountIdFor: (id: string) => string | undefined;
  markAsRead: (emailId: string, read: boolean) => Promise<void>;
  markAsStarred: (emailId: string, starred: boolean) => Promise<void>;
  /** Per-message star (chat/bubble view) — stars one email, not the whole thread. */
  markMessageStarred: (emailId: string, starred: boolean) => Promise<void>;
  markImportant: (emailId: string, important: boolean) => Promise<void>;
  snoozeEmail: (emailId: string, snoozeUntil: number) => Promise<void>;
  unsnoozeEmail: (emailId: string) => Promise<void>;
  deleteEmail: (emailId: string) => Promise<void>;
  archiveEmail: (emailId: string) => Promise<void>;
  moveToSpam: (emailId: string) => Promise<void>;
  moveFromSpam: (emailId: string) => Promise<void>;
  /** Move one email to an arbitrary folder (optimistically leaves the current view). */
  moveEmailToFolder: (emailId: string, destFolderId: string) => Promise<void>;
  /** Copy one email to a folder — it stays in the current view too. */
  copyEmailToFolder: (emailId: string, destFolderId: string) => Promise<void>;
  /** Move a selection to a folder in one bulk op. */
  bulkMoveToFolder: (emailIds: string[], destFolderId: string) => Promise<void>;
  /** Copy a selection to a folder in one bulk op (originals stay). */
  bulkCopyToFolder: (emailIds: string[], destFolderId: string) => Promise<void>;
  bulkRemoveEmails: (emailIds: string[], action: 'delete' | 'archive' | 'spam' | 'notspam') => Promise<void>;
  /** Batched optimistic mark read/unread — one state update + one bulk IPC. */
  bulkMarkRead: (emailIds: string[], read: boolean) => void;
  /** Batched optimistic star/unstar — one state update + one bulk IPC. */
  bulkMarkStarred: (emailIds: string[], starred: boolean) => void;
  clearSelectedEmail: () => void;
  removeDraftFromViews: (emailId: string) => void;
  discardDraft: (messageId: string, threadId?: string, accountId?: string) => Promise<void>;
  undoDelete: (emailId?: string) => void;
  commitDelete: (emailId: string) => Promise<void>;
}

export interface SearchAISlice {
  searchQuery: string;
  searchResults: EmailRecord[];
  searching: boolean;
  searchInterpretation: string | null;
  searchSuggestions: string[];
  /** Parsed predicate for the active search — kept so the list can re-check the
   *  live state tokens (is:unread / is:starred) after an optimistic action and
   *  instantly drop rows that no longer match. Null when no search is active. */
  searchFilter: SearchQuery | null;
  /** Discrete pagination for search results (mirrors emailsPage/hasMoreEmails):
   *  current 0-based page and whether a full page came back (i.e. there's more). */
  searchPage: number;
  searchHasMore: boolean;
  /** True total of all matches (a COUNT over the whole mailbox) for the "of N"
   *  paginator label. 0 = unknown (falls back to searchHasMore). */
  searchTotal: number;
  /** A server-side search (IMAP UID SEARCH → pull missing matches into the local
   *  index) is in flight for the active query. */
  searchingServer: boolean;
  /** A server search already ran for the active query — gates auto-escalation so
   *  it never re-fires for the same query (the manual button still can). */
  serverSearchRan: boolean;
  /** One-line human summary of the last server search, for the status chip.
   *  Null = nothing to show. */
  serverSearchStatus: string | null;

  viewingAICategory: string | null;
  /** When set, the list shows ONE inbox section's filter as a full paginated
   *  page (Gmail: click a section's "X–Y of Z" count). Holds the DB filter. */
  viewingSection: string | null;
  /** Display label of the section being viewed full-page (for the page header). */
  viewingSectionLabel: string | null;
  /** Page size for the full-page section view = that section's "Show up to". */
  viewingSectionPageSize: number;
  aiBoxActiveTab: string;
  aiProcessing: boolean;
  aiProcessingProgress: AIProcessingProgress | null;
  aiCategoryCountsLastUpdate: number;

  /** Active quick-filter applied to the sectioned inbox (unread / read / starred /
   *  attachment / unlabelled). Null = no filter. Unlike a text search this keeps
   *  the sectioned layout and its pagination — it's just ANDed into every section
   *  query. Set via a quick-filter chip; cleared by re-clicking it or clearSearch. */
  activeInboxFilter: ViewFilter | null;
  /** Human label of the active inbox filter, for the "Filtered: X" indicator. */
  activeInboxFilterLabel: string | null;

  search: (query: string, context?: { folderId?: string; aiCategory?: string; skipAI?: boolean }) => Promise<void>;
  /** Apply (or toggle off) a quick-filter over the sectioned inbox. Passing the
   *  same label again, or null, clears it. Reloads the sections with the filter. */
  setInboxFilter: (filter: ViewFilter | null, label?: string | null) => Promise<void>;
  /** Jump to a discrete page of the current search (prev/next). */
  goToSearchPage: (page: number) => Promise<void>;
  /** Internal: load one page of the active search (offset = page * pageSize). */
  _loadSearchPage: (page: number, query: string) => Promise<void>;
  /** Escalate the active search to the server: run an IMAP UID SEARCH, pull the
   *  newest missing matches into the local index, then re-show the local page.
   *  The explicit "Search server" affordance; also invoked automatically when a
   *  local search comes back thin. */
  searchServer: () => Promise<void>;
  /** Internal: the shared server-search worker (manual + auto escalation). */
  _runServerSearch: (query: string, manual: boolean) => Promise<void>;
  clearSearch: () => void;
  fetchSearchSuggestions: (partial: string) => Promise<void>;

  /** Bump aiCategoryCountsLastUpdate so category badges refetch immediately.
   *  Call after any DB write that changes unread-per-category counts. */
  refreshCategoryCounts: () => void;

  loadAICategoryEmails: (category: string) => Promise<void>;
  clearAICategoryView: () => void;
  setAIBoxActiveTab: (tab: string) => void;
  stopAIProcessing: () => void;

  processRecentEmailsForSignatures: () => Promise<void>;
  processEmailsForAICategorization: () => Promise<void>;
  startAutoAICategorization: () => void;
  autoExtractRecentConversations: () => Promise<void>;
}

export type SendingStatus = 'idle' | 'sending' | 'sent';

/** Identity for deleting a thread's draft(s) after the send is durably persisted
 *  (never before — see the persist-first undo-send flow). Mirrors the drafts:delete
 *  IPC shape; the handler resolves priority threadId → messageId → subject+to. */
export interface DraftCleanup {
  threadId?: string;
  messageId?: string;
  subject?: string;
  to?: string;
  accountId?: string;
}

export interface PendingSend {
  options: Omit<SendEmailOptions, 'inReplyTo'> & { inReplyTo?: string };
  timeoutId: number;
  optimisticEmailId: string;
  /** Outbox rowid of the HELD send (persisted, awaiting commit-or-cancel). */
  sendId: number | null;
  /** Owning account (send-as), for routing commit/cancel to the right outbox. */
  accountId?: string;
  /** Draft to remove once the send commits (deferred so a crash never loses it). */
  draftCleanup?: DraftCleanup;
  draft: {
    to: string;
    cc: string;
    bcc?: string;
    subject?: string;
    htmlContent: string;
    attachments: any[];
    replyToEmail: any;
    mode: ComposeMode;
    isInline?: boolean;
  };
}

export interface RestoreDraft {
  to: string;
  cc: string;
  bcc?: string;
  subject?: string;
  htmlContent: string;
  attachments: any[];
  replyToEmail: any;
  mode: ComposeMode;
  isInline?: boolean;
}

export interface ComposeSlice {
  compose: ComposeState;
  sendingStatus: SendingStatus;
  pendingSend: PendingSend | null;
  restoreDraft: RestoreDraft | null;

  openCompose: (mode: ComposeMode, replyToEmail?: ComposeState['replyToEmail'], draftBody?: string) => void;
  /** Open the full composer to EDIT an existing standalone draft (with subject). */
  editDraftInComposer: (draft: NonNullable<ComposeState['draft']>) => void;
  closeCompose: () => void;
  sendEmail: (options: Omit<SendEmailOptions, 'inReplyTo'> & { inReplyTo?: string; draft?: PendingSend['draft']; draftCleanup?: DraftCleanup }) => Promise<void>;
  undoSend: () => void;
  clearRestoreDraft: () => void;
}

export interface UISlice {
  viewMode: ViewMode;
  inboxType: InboxType;
  showImportanceMarkers: boolean;
  inboxSections: InboxSection[];

  setViewMode: (mode: ViewMode) => void;
  reloadInboxSettings: () => void;
}

// Combined store type
export type EmailStore =
  ConnectionSlice &
  SyncSlice &
  EmailsSlice &
  EmailActionsSlice &
  SearchAISlice &
  ComposeSlice &
  UISlice;

// Slice creator type — each slice gets access to the full EmailStore via get/set
export type SliceCreator<T> = StateCreator<EmailStore, [], [], T>;
