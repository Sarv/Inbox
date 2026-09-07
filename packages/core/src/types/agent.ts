// Types for the Email Agent system
// Covers: action logging, agent decisions, behavior learning, autonomous actions

/**
 * Every user action on an email is logged for behavior learning
 */
export interface UserActionLog {
  id: string;
  emailId: string;
  threadId: string | null;
  actionType: UserActionType;
  actionValue: string | null; // JSON: snooze_until, label_name, folder_path, etc.
  source: ActionSource;
  senderAddress: string | null; // Denormalized for fast sender-pattern queries
  timestamp: number; // Unix timestamp
  createdAt: number;
}

export type UserActionType =
  | 'read'
  | 'unread'
  | 'star'
  | 'unstar'
  | 'archive'
  | 'delete'
  | 'spam'
  | 'move'
  | 'label_add'
  | 'label_remove'
  | 'snooze'
  | 'unsnooze'
  | 'reply'
  | 'reply_all'
  | 'forward'
  | 'important'
  | 'unimportant'
  | 'mute'
  | 'open' // User opened/viewed the email
  | 'ignore'; // User saw email but took no action (derived)

export type ActionSource =
  | 'user'           // Direct user action
  | 'agent_auto'     // Agent acted autonomously (high confidence)
  | 'agent_approved' // Agent proposed, user approved
  | 'agent_rejected' // Agent proposed, user rejected (learning signal)
  | 'rule'           // User-defined filter/rule
  | 'system';        // System action (e.g., sync)

/**
 * Agent decision record — what the agent proposed vs what happened
 */
export interface AgentDecision {
  id: string;
  emailId: string;
  threadId: string | null;
  senderAddress: string | null;

  // What the agent decided
  proposedAction: UserActionType;
  proposedValue: string | null; // JSON: reply draft, label, folder, etc.
  confidence: number; // 0.0 - 1.0
  reasoning: string; // Why the agent chose this action

  // What actually happened
  status: AgentDecisionStatus;
  actualAction: UserActionType | null; // What user actually did (if different)
  userFeedback: string | null; // Optional user correction note

  // Timing
  proposedAt: number;
  resolvedAt: number | null;
  createdAt: number;

  // Auto-drafted reply (populated by pipeline when action is 'reply')
  draftBody?: string;
  draftSubject?: string;
  draftReasoning?: string;
}

export type AgentDecisionStatus =
  | 'pending'    // Waiting for user approval
  | 'approved'   // User accepted the proposal
  | 'rejected'   // User rejected, may have taken different action
  | 'auto'       // Auto-executed (high confidence)
  | 'expired'    // No response within time window
  | 'overridden'; // User took a completely different action

/**
 * Sender daily metrics for time-series analysis
 */
export interface SenderDailyMetrics {
  id: string;
  senderEmail: string;
  date: number; // Unix timestamp (start of day)
  receivedCount: number;
  readCount: number;
  repliedCount: number;
  deletedCount: number;
  archivedCount: number;
  avgResponseTimeSec: number | null; // Average time to first action
  createdAt: number;
}

/**
 * Persisted pipeline event for long-term analysis
 */
export interface PipelineEventLog {
  id: string;
  eventType: string;
  emailId: string | null;
  threadId: string | null;
  data: string | null; // JSON payload
  timestamp: number;
  createdAt: number;
}

/**
 * Agent configuration — controls autonomy levels
 */
export interface AgentConfig {
  enabled: boolean;

  // Confidence thresholds
  autoActThreshold: number;    // Above this = act without asking (default 0.85)
  suggestThreshold: number;    // Above this = suggest to user (default 0.5)

  // Feature toggles
  autoTriage: boolean;         // Auto-archive/delete noise
  autoRead: boolean;           // Auto-mark noise emails as read
  draftReplies: boolean;       // Write reply drafts for emails worth answering — saved straight to the Drafts folder (the Drafts folder IS the review step)
  autoReply: boolean;          // AUTO-SEND: actually send the drafted reply via SMTP when confidence ≥ autoActThreshold (below it → saved as draft). Off = everything stays a draft
  autoStar: boolean;           // Auto-star/flag important emails (learned from behavior)
  autoPrioritize: boolean;     // Reorder inbox by learned importance

  // Safety
  neverAutoDeleteFrom: string[];  // Domains/addresses to never auto-delete
  neverAutoReplyTo: string[];     // Never auto-reply to these
  requireApprovalForNew: boolean; // Always ask for new/unseen sender patterns
  maxAutoActionsPerHour: number;  // Rate limit autonomous actions

  // Web search (for agentic reply drafting)
  searchWebEnabled: boolean;   // Enable web search when drafting replies
  tavilyApiKey?: string;       // Tavily API key (required when searchWebEnabled=true)

  // Testing
  testMode: boolean;           // Skip IMAP sync for agent actions (for testing)
}

/**
 * Behavior profile — learned from user action history
 */
export interface BehaviorProfile {
  // Response patterns
  avgResponseTimeSec: number;
  responseRate: number; // 0-1, what % of emails get a reply
  peakActivityHours: number[]; // Hours of day when user is most active

  // Sender tiers (learned from interaction frequency)
  vipSenders: string[];       // Always respond quickly
  noiseSenders: string[];     // Usually ignore/delete

  // Action patterns per sender domain
  domainPatterns: Record<string, {
    readRate: number;
    replyRate: number;
    deleteRate: number;
    archiveRate: number;
    avgResponseTimeSec: number;
  }>;

  // Content patterns
  topicInterests: string[];    // Topics user engages with
  topicIgnores: string[];      // Topics user ignores

  lastUpdated: number;
}

/**
 * Agent action proposal — shown in approval queue UI
 */
export interface AgentProposal {
  id: string;
  emailId: string;
  threadId: string | null;
  action: UserActionType;
  value: string | null;
  confidence: number;
  reasoning: string;
  previewText: string; // Short description for UI
  proposedAt: number;
  expiresAt: number; // Auto-expire proposals
}

/**
 * Reply draft generated by the agent
 */
export interface AgentReplyDraft {
  id: string;
  emailId: string;
  threadId: string | null;
  subject: string;
  body: string; // HTML
  tone: 'formal' | 'casual' | 'brief' | 'detailed';
  confidence: number;
  basedOnPatterns: string[]; // IDs of similar past replies used as examples
  createdAt: number;
}

/**
 * Storage interface extension for agent operations
 */
export interface IAgentStorage {
  // Action Log
  logAction(action: UserActionLog): Promise<void>;
  logActionBatch(actions: UserActionLog[]): Promise<void>;
  getActionsByEmail(emailId: string): Promise<UserActionLog[]>;
  getActionsByType(actionType: UserActionType, limit?: number, offset?: number): Promise<UserActionLog[]>;
  getActionsBySender(senderAddress: string, limit?: number): Promise<UserActionLog[]>;
  getRecentActions(limit?: number, since?: number): Promise<UserActionLog[]>;
  getActionStats(since?: number): Promise<ActionStats>;

  // Agent Decisions
  saveDecision(decision: AgentDecision): Promise<void>;
  updateDecisionStatus(id: string, status: AgentDecisionStatus, actualAction?: UserActionType | null, userFeedback?: string | null): Promise<void>;
  getPendingDecisions(): Promise<AgentDecision[]>;
  getDecisionHistory(limit?: number, offset?: number): Promise<AgentDecision[]>;
  getDecisionAccuracy(since?: number): Promise<{ total: number; approved: number; rejected: number; accuracy: number }>;

  // Sender Daily Metrics
  upsertSenderDailyMetrics(metrics: SenderDailyMetrics): Promise<void>;
  getSenderMetrics(senderEmail: string, days?: number): Promise<SenderDailyMetrics[]>;
  getTopSendersByAction(actionType: UserActionType, limit?: number, since?: number): Promise<{ email: string; count: number }[]>;

  // Pipeline Event Persistence
  logPipelineEvent(event: PipelineEventLog): Promise<void>;
  logPipelineEventBatch(events: PipelineEventLog[]): Promise<void>;
  getPipelineEvents(eventType?: string, limit?: number, since?: number): Promise<PipelineEventLog[]>;
  cleanupOldEvents(olderThan: number): Promise<number>;
}

// ========== Contact Classification ==========

export type ContactType =
  | 'potential_customer' // Inbound inquiry, demo request, lead
  | 'existing_customer'  // Active customer, has transacted/signed up
  | 'churned_customer'   // Was a customer, went silent
  | 'vendor'             // Sends invoices, provides services to us
  | 'colleague'          // Same domain, internal team
  | 'personal'           // Personal contact (friend, family)
  | 'newsletter'         // Automated newsletter/marketing
  | 'automated'          // No-reply, system notifications, bots
  | 'recruiter'          // Job offers, recruiting outreach
  | 'unknown';           // Not yet classified

export type ContactTypeSource =
  | 'user'       // User manually set the type
  | 'ai'         // AI classified based on email content
  | 'rule'       // Classified by domain/pattern rule
  | 'behavior'   // Classified from interaction patterns
  | 'unset';     // Not yet classified

export interface ContactClassification {
  contactType: ContactType;
  confidence: number; // 0-1
  source: ContactTypeSource;
  reasoning?: string;
}

export interface ClassifiedContact {
  email: string;
  name: string | null;
  company: string | null;
  contactType: ContactType;
  contactTypeConfidence: number;
  contactTypeSource: ContactTypeSource;
  receivedCount: number;
  sentCount: number;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  avgResponseTimeSec: number | null;
  threadCount: number;
  needsResponse: boolean;
  isFavorite: boolean;
}

/**
 * Aggregated action statistics
 */
export interface ActionStats {
  totalActions: number;
  actionCounts: Record<UserActionType, number>;
  topSenders: { email: string; actionCount: number }[];
  avgActionsPerDay: number;
  mostActiveHour: number;
}
