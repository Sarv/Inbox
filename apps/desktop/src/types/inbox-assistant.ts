import type { InboxAssistantReview, InboxAssistantReviewAction, InboxAssistantReviewApplyResult, InboxAssistantReviewKind } from './inbox-assistant-actions';
import type { LocalCalendarAvailability, LocalCalendarAvailabilityRequest } from './local-calendar';

export type InboxAssistantActionMode = 'review' | 'approve_for_me';

/** Type-only contract shared by the isolated renderer and main-process agent. */
export interface InboxAssistantAccount {
  id: string;
  email: string;
  name?: string;
}

export interface InboxAssistantSource {
  id: string;
  kind: 'message' | 'attachment';
  accountId: string;
  accountEmail: string;
  emailId: string;
  threadId?: string;
  subject: string;
  from: string;
  to: string[];
  date: number; // Unix seconds, matching EmailRecord.
  folder: string;
  sent: boolean;
  attachmentId?: string;
  filename?: string;
  location?: string;
  excerpt: string;
}

/** Full bounded evidence stays in the main process, not conversation storage. */
export interface InboxAssistantEvidence extends InboxAssistantSource {
  text: string;
}

export interface InboxAssistantAccountCoverage {
  accountId: string;
  email: string;
  status: 'searched' | 'unavailable';
  matchedMessages: number;
  reviewedMessages: number;
  missingBodies: number;
  attachmentsRead: number;
  attachmentsSkipped: number;
  truncated: boolean;
  warnings: string[];
}

export interface InboxAssistantAnswer {
  text: string;
  sources: InboxAssistantSource[];
  coverage: InboxAssistantAccountCoverage[];
  warnings: string[];
}

/** Observable work only: never model reasoning or private thinking tokens. */
export interface InboxAssistantProgress {
  stage: 'context' | 'search' | 'body' | 'attachment' | 'answer' | 'action' | 'complete';
  status: 'running' | 'done' | 'warning';
  message: string;
  detail?: string;
  accountId?: string;
  emailId?: string;
  filename?: string;
}

export interface InboxAssistantActivity extends InboxAssistantProgress {
  requestId: string;
  chatId?: string;
  sequence: number;
  at: number;
}

/** Provider-reported accounting only. Prompts and API credentials are excluded. */
export interface InboxAssistantAIUsage {
  id: string;
  provider: string;
  model: string;
  status: 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt: number;
  attempts: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  tokenSource: 'provider' | 'unavailable';
  /** False when one or more provider attempts did not report both counts. */
  usageComplete: boolean;
  estimatedCostUsd?: number;
  /** False when counts or the exact provider/model rate are unavailable. */
  costComplete: boolean;
  pricingSource?: string;
  pricingAsOf?: string;
}

export interface InboxAssistantUsage {
  calls: InboxAssistantAIUsage[];
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  tokenCountsComplete: boolean;
  estimatedCostUsd?: number;
  costComplete: boolean;
  currency: 'USD';
}

export type InboxAssistantRunStatus = 'pending' | 'running' | 'completed' | 'stopped' | 'failed';

export interface InboxAssistantRunRecord {
  requestId: string;
  chatId: string;
  kind: 'question' | 'draft' | 'action';
  question: string;
  accountIds: string[];
  exchangeId?: string;
  status: InboxAssistantRunStatus;
  startedAt: number;
  updatedAt: number;
  activities: InboxAssistantActivity[];
  error?: string;
  usage?: InboxAssistantUsage;
  draft?: InboxAssistantDraft;
}

export interface InboxAssistantExchange {
  id: string;
  chatId?: string;
  question: string;
  accountIds: string[];
  answer: InboxAssistantAnswer;
  createdAt: number; // Unix milliseconds for conversation ordering.
  activities?: InboxAssistantActivity[];
  review?: InboxAssistantReview;
  reviewResult?: InboxAssistantReviewApplyResult;
  requestId?: string;
  status?: InboxAssistantRunStatus;
  updatedAt?: number;
  error?: string;
  usage?: InboxAssistantUsage;
}

export interface InboxAssistantRequest {
  requestId: string;
  chatId: string;
  question: string;
  accountIds: string[];
  previousExchangeId?: string;
  reviewKind?: InboxAssistantReviewKind;
  continueReviewId?: string;
  /** Prepare/refresh a review without applying saved delegated approval. */
  reviewOnly?: boolean;
}

export interface InboxAssistantReviewActionRequest {
  requestId: string;
  chatId: string;
  exchangeId: string;
  reviewId: string;
  itemIds: string[];
  undo?: boolean;
  /** Set only by a user's explicit selection, never by delegated approval. */
  manualSelection?: boolean;
  /** Manual mail actions never alter the review's automatic recommendation. */
  action?: InboxAssistantReviewAction;
}

export interface InboxAssistantChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  exchangeCount: number;
  pinned?: boolean;
  actionMode?: InboxAssistantActionMode;
  /** An earlier conversation branch can be restored after rewinding. */
  rewindAvailable?: boolean;
  /** Live metadata only; the persisted summary index does not duplicate runs. */
  activeRun?: InboxAssistantRunRecord;
}

export interface InboxAssistantChat extends InboxAssistantChatSummary {
  exchanges: InboxAssistantExchange[];
  runs?: InboxAssistantRunRecord[];
  usage?: InboxAssistantUsage;
}

export interface InboxAssistantChatList {
  chats: InboxAssistantChatSummary[];
  activeChatId: string | null;
}

export interface InboxAssistantRewind {
  chat: InboxAssistantChat;
  question: string;
  accountIds: string[];
}

export interface InboxAssistantCancellation {
  requestId: string;
  cancelled: boolean;
}

export interface InboxAssistantDraftRequest {
  requestId: string;
  chatId: string;
  accountId: string;
  instructions?: string;
  meeting?: LocalCalendarAvailabilityRequest;
}

/** A reviewable plain-text draft; opening it never sends email. */
export interface InboxAssistantDraft {
  chatId: string;
  accountId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  calendarAvailability?: LocalCalendarAvailability;
}

export type InboxAssistantResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export interface InboxAssistantAPI {
  accounts(): Promise<InboxAssistantResult<InboxAssistantAccount[]>>;
  chats(): Promise<InboxAssistantResult<InboxAssistantChatList>>;
  chat(chatId: string): Promise<InboxAssistantResult<InboxAssistantChat>>;
  createChat(): Promise<InboxAssistantResult<InboxAssistantChat>>;
  renameChat(request: { chatId: string; title: string }): Promise<InboxAssistantResult<InboxAssistantChatSummary>>;
  updateChat(request: { chatId: string; pinned?: boolean; actionMode?: InboxAssistantActionMode }): Promise<InboxAssistantResult<InboxAssistantChatSummary>>;
  deleteChat(chatId: string): Promise<InboxAssistantResult<InboxAssistantChatList>>;
  rewindChat(request: { chatId: string; exchangeId: string }): Promise<InboxAssistantResult<InboxAssistantRewind>>;
  restoreRewindChat(request: { chatId: string }): Promise<InboxAssistantResult<InboxAssistantChat>>;
  draftEmail(request: InboxAssistantDraftRequest): Promise<InboxAssistantResult<InboxAssistantDraft>>;
  history(): Promise<InboxAssistantResult<InboxAssistantExchange[]>>;
  ask(request: InboxAssistantRequest): Promise<InboxAssistantResult<InboxAssistantExchange>>;
  applyReview(request: InboxAssistantReviewActionRequest): Promise<InboxAssistantResult<InboxAssistantExchange>>;
  cancel(requestId: string): Promise<InboxAssistantResult<InboxAssistantCancellation>>;
  clearHistory(): Promise<InboxAssistantResult<null>>;
  onActivity(listener: (activity: InboxAssistantActivity) => void): () => void;
  source(request: Pick<InboxAssistantSource, 'accountId' | 'emailId' | 'filename'>): Promise<InboxAssistantResult<{ emailId: string; threadId: string; filename?: string }>>;
}
