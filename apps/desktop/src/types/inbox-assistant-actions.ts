import type { InboxAssistantAccount } from './inbox-assistant';

export type InboxAssistantReviewKind = 'unread' | 'uncategorized' | 'mark_read' | 'mark_unread';
export type InboxAssistantReviewRecommendation = 'mark_read' | 'mark_unread' | 'keep_unread' | 'needs_review';
export type InboxAssistantReviewAction = 'mark_read' | 'mark_unread' | 'archive' | 'trash';
export interface InboxAssistantReviewScope {
  query: string;
  field: 'any' | 'sender' | 'subject' | 'body';
}
export interface InboxAssistantReadCommand {
  kind: 'mark_read' | 'mark_unread';
  scope: InboxAssistantReviewScope;
}
export type InboxAssistantReviewItemStatus = 'pending' | 'applied' | 'queued' | 'failed' | 'skipped' | 'undone';

/** Display metadata only. Authoritative mutation snapshots stay in main memory. */
export interface InboxAssistantReviewItem {
  id: string;
  accountId: string;
  accountEmail: string;
  threadId: string;
  emailId: string;
  subject: string;
  from: string;
  date: number;
  unreadCount: number;
  messageCount: number;
  unreadEmailIds: string[];
  /** Exact matched messages whose original flag differs from the requested flag. */
  targetEmailIds?: string[];
  targetRead?: boolean;
  uncategorized: boolean;
  categories: string[];
  recommendation: InboxAssistantReviewRecommendation;
  reason: string;
  confidence: number;
  protectedReasons: string[];
  bodyUnavailable: boolean;
  attachmentsUnknown: boolean;
  /** A user may explicitly override the recommendation for this stable snapshot. */
  manualSelectionAllowed?: boolean;
  /** Explicit archive/Trash actions are available for this host-held snapshot. */
  mailActionsAllowed?: boolean;
  status: InboxAssistantReviewItemStatus;
  /** The host-confirmed action, distinct from the AI recommendation. */
  appliedAction?: InboxAssistantReviewAction;
  undoAvailable?: boolean;
}

export interface InboxAssistantReviewCoverage {
  accountId: string;
  email: string;
  status: 'reviewed' | 'unavailable';
  reviewedThreads: number;
  scannedThreads: number;
  truncated: boolean;
  hasMore: boolean;
  /** Uncached originals skipped because no indexed evidence made them candidates. */
  skippedUncachedBodies?: number;
  /** Verified recommendations reused after fresh source and safety checks. */
  cachedRecommendations?: number;
  aiReviewedThreads?: number;
  /** Diagnostic scan position only. Continuation rescans with account-scoped exclusions. */
  nextOffset?: number;
  warnings: string[];
}

/** Explicit, bounded automatic review; never enables background mail rules. */
export interface InboxAssistantReviewAutomation {
  reviewId: string;
  status: 'running' | 'completed' | 'stopped' | 'failed';
  batchesReviewed: number;
  reviewedConversations: number;
  markedConversations: number;
  markedEmails: number;
  queuedEmails: number;
  maxBatches: number;
  maxAICalls: number;
  reason?: string;
}

export interface InboxAssistantReview {
  id: string;
  kind: InboxAssistantReviewKind;
  scope?: InboxAssistantReviewScope;
  createdAt: number;
  expiresAt: number;
  status: 'ready' | 'partial' | 'completed' | 'expired';
  accounts: InboxAssistantAccount[];
  items: InboxAssistantReviewItem[];
  coverage: InboxAssistantReviewCoverage[];
  truncated: boolean;
  automation?: InboxAssistantReviewAutomation;
}

export interface InboxAssistantReviewItemResult {
  itemId: string;
  accountId: string;
  threadId: string;
  status: Exclude<InboxAssistantReviewItemStatus, 'pending'>;
  action?: InboxAssistantReviewAction;
  appliedIds: string[];
  queuedIds: string[];
  failedIds: string[];
  reason?: string;
}

export interface InboxAssistantReviewApplyResult {
  reviewId: string;
  items: InboxAssistantReviewItemResult[];
  appliedCount: number;
  queuedCount: number;
  failedCount: number;
  skippedCount: number;
}
