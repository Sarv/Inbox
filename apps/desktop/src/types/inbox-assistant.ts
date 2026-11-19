import type { InboxAssistantReview, InboxAssistantReviewAction, InboxAssistantReviewApplyResult, InboxAssistantReviewAutomation, InboxAssistantReviewKind } from './inbox-assistant-actions';
import type { InboxAgentChangeSet, InboxAgentChangeSetRequest, InboxAgentSettingChange } from './inbox-assistant-changes';
import type { InboxAssistantDashboard, InboxAssistantDashboardRequest } from './inbox-assistant-dashboard';
import type { LocalCalendarAvailability, LocalCalendarAvailabilityRequest } from './local-calendar';

export type { InboxAssistantDashboard, InboxAssistantDashboardRequest } from './inbox-assistant-dashboard';

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
  /** Host-selected display timezone; never supplied by the model or persisted as mail content. */
  dateTimeZone?: string;
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
  /** Related originals can be offered without implying a verified AI answer. */
  sourceStatus?: 'verified' | 'related';
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
  reviewAutomation?: InboxAssistantReviewAutomation;
}

export interface InboxAssistantActivity extends InboxAssistantProgress {
  requestId: string;
  chatId?: string;
  sequence: number;
  at: number;
}

/** Host-recorded work represented by one unread-review classifier call. Character counts are not token estimates. */
export interface InboxAssistantAIWorkload {
  operation: 'unread_review';
  conversationCount: number;
  messageCount: number;
  originalContentChars: number;
  submittedContentChars: number;
  reusedQuotedTurns: number;
  /** Bounded account-local behavior evidence, separate from email content. */
  behaviorContextChars?: number;
}

export type InboxAssistantAIPurpose = 'plan' | 'answer' | 'repair' | 'review' | 'draft' | 'agent' | 'classify';

/** Provider-reported accounting, with optional host-recorded workload. Prompts and API credentials are excluded. */
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
  workload?: InboxAssistantAIWorkload;
  /** Which step of a run made this call. Set by the host, never by the provider. */
  purpose?: InboxAssistantAIPurpose;
  /** Why a failed call failed, as a class (`auth`, `rate_limit`, `timeout`). Never the provider's message. */
  errorKind?: string;
  httpStatus?: number;
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

/** A caught failure reduced to what it was: class, machine code, HTTP status. Never its message. */
export interface InboxAssistantErrorDiagnostic {
  name: string;
  code?: string;
  status?: number;
}

export type InboxAssistantFactRejectionReason =
  | 'invalid_fact_shape' | 'unknown_source' | 'missing_exact_quote' | 'unsupported_number_or_currency' | 'personal_sent_attribution';

/** What the verifier did with one model reply. */
export interface InboxAssistantAnswerPassDiagnostics {
  /** `malformed`: the reply did not satisfy the JSON contract and no fact could be read from it. */
  format: 'valid' | 'malformed';
  factsReturned: number;
  factsVerified: number;
  rejected: Partial<Record<InboxAssistantFactRejectionReason, number>>;
}

/** The search-plan field a model reply got wrong. A fixed name, never the field's value. */
export type InboxAssistantPlanField =
  | 'unknown_field' | 'queries' | 'entity_terms' | 'topic_terms' | 'participant_terms' | 'intent' | 'quote_intent'
  | 'filters' | 'unknown_filter' | 'date' | 'date_range' | 'address' | 'attachment';

export interface InboxAssistantPlanDiagnostics {
  /** `fallback`: the model's plan was not used and host keyword rules built the search. */
  source: 'model' | 'fallback';
  /** Why the model's plan was not used: `invalid_json`, `invalid_shape`, or an AI failure class. */
  failure?: string;
  /** With `invalid_shape`: which field of the plan was unusable. */
  failedField?: InboxAssistantPlanField;
  httpStatus?: number;
  followUp: boolean;
  intent: 'sent' | 'all';
  quoteIntent: boolean;
  meetingIntent: boolean;
  invitationIntent: boolean;
  timeWindow: boolean;
  /** Which filters were applied, by name only. */
  filters: string[];
  queryCount: number;
  topicTermCount: number;
  participantTermCount: number;
  requiredGroupCount: number;
  /**
   * The search words themselves. They are derived from the question and are
   * saved beside it in the encrypted chat store. They are never logged, and a
   * copied report leaves them out unless the user asks for them.
   */
  terms: {
    queries: string[];
    entityTerms: string[];
    topicTerms: string[];
    participantTerms: string[];
    requiredTopicGroups: string[][];
    timeWindow?: string;
  };
}

export interface InboxAssistantAccountDiagnostics {
  accountId: string;
  status: 'searched' | 'unavailable';
  /** Why the account could not be fully searched. */
  failure?: InboxAssistantErrorDiagnostic;
  searches: number;
  matchedMessages: number;
  reviewedMessages: number;
  evidenceItems: number;
  evidenceChars: number;
  missingBodies: number;
  bodyDownloadFailures: number;
  attachmentsRead: number;
  attachmentsSkipped: number;
  /** Attachments that were opened and could not be read, counted by reason. */
  attachmentFailures: Record<string, number>;
  truncated: boolean;
  durationMs: number;
}

/**
 * Why a run ended the way it did. Saved with the run in the encrypted chat
 * store so a bad answer can be explained afterwards. Holds ids, classes, counts
 * and durations, plus the search words under `plan.terms`. Never mail text,
 * model output or an error message.
 */
/**
 * The agent loop, content-free: which protocol it used, how many turns, and
 * which tools it called or got wrong, by fixed tool name and error class.
 */
export interface InboxAssistantAgentDiagnostics {
  mode: 'native' | 'json';
  /** The provider refused tool definitions, so the run switched to the JSON protocol. */
  fallback?: 'tools_refused';
  /** Reasoning was turned off so the model would accept tools (`native` mode only). */
  reasoning?: 'off';
  steps: number;
  toolCalls: Record<string, number>;
  toolErrors: Record<string, number>;
  /** Times the model replied in prose and was asked to use a tool. */
  nudges?: number;
  stop?: 'answered' | 'step_limit';
  /** Change sets the run staged, the messages in them, how many "Approve for me" applied without a card, and standing changes asked for. */
  changes?: { sets: number; messages: number; autoApplied: number; settings?: number };
}

export interface InboxAssistantRunDiagnostics {
  version: 1;
  /** Which path handled the request. `refused`: the host declined it before doing any work. */
  route?: 'capability' | 'review' | 'mail_command' | 'search' | 'agent' | 'refused';
  reviewKind?: string;
  plan?: InboxAssistantPlanDiagnostics;
  /**
   * The search was widened after its first pass, which found mail and turned
   * all of it away. `required_topics`: no email mentioned every topic the
   * question named. `model_topics`: no email matched the model's topic in full,
   * so its entity terms stood in. `accounts` describes the widened search.
   */
  searchBroadened?: Array<'required_topics' | 'model_topics'>;
  accounts?: InboxAssistantAccountDiagnostics[];
  answer?: {
    /** No model call was made because the search found nothing to answer from. */
    skipped?: 'no_evidence';
    first?: InboxAssistantAnswerPassDiagnostics;
    repair?: {
      reason: 'malformed' | 'rejected_facts' | 'no_facts';
      /** The repair call was not made: no collected source was relevant enough to retry with. */
      skipped?: 'no_relevant_sources';
      sources: number;
      pass?: InboxAssistantAnswerPassDiagnostics;
      factsRecovered: number;
    };
    factsFinal: number;
  };
  /** How the agent loop went (route `agent`). */
  agent?: InboxAssistantAgentDiagnostics;
  /** `answered`: the agent replied from tool results or a plain message, with no email cited. */
  outcome?: 'verified' | 'related' | 'no_evidence' | 'answered' | 'capability' | 'review' | 'refused' | 'failed' | 'stopped';
  /** Set when the run threw. `stage` is the last step that had started. */
  failure?: { stage: 'route' | 'plan' | 'search' | 'answer' | 'review' | 'agent'; error: InboxAssistantErrorDiagnostic };
  durationMs?: number;
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
  diagnostics?: InboxAssistantRunDiagnostics;
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
  /** Mail changes the agent staged or applied in this exchange, one card each. */
  changeSets?: InboxAgentChangeSet[];
  /** Settings the agent asked to change (filters, sender blocks), one card each. */
  settingChanges?: InboxAgentSettingChange[];
  /** Compact receipt presentation for batches produced by one automatic run. */
  reviewBatch?: { runId: string; number: number };
  requestId?: string;
  status?: InboxAssistantRunStatus;
  updatedAt?: number;
  error?: string;
  usage?: InboxAssistantUsage;
  diagnostics?: InboxAssistantRunDiagnostics;
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
  /** Explicit one-run consent: mark verified recommendations read, then continue. */
  autoContinue?: boolean;
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
  dashboard(request: InboxAssistantDashboardRequest): Promise<InboxAssistantResult<InboxAssistantDashboard>>;
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
  /** Approve, cancel or undo one of the agent's change sets. */
  changeSet(request: InboxAgentChangeSetRequest): Promise<InboxAssistantResult<InboxAssistantExchange>>;
  cancel(requestId: string): Promise<InboxAssistantResult<InboxAssistantCancellation>>;
  clearHistory(): Promise<InboxAssistantResult<null>>;
  onActivity(listener: (activity: InboxAssistantActivity) => void): () => void;
  source(request: Pick<InboxAssistantSource, 'accountId' | 'emailId' | 'filename'>): Promise<InboxAssistantResult<{ emailId: string; threadId: string; filename?: string }>>;
}
