/**
 * Signal Types for Multi-Signal Behavior Intelligence
 *
 * Each signal dimension scores 0-1 with a confidence level.
 * Combined into a 0-100 PriorityScore for email ranking.
 */

import type { UserActionType } from '../../types/agent';

// ========== Base ==========

export interface SignalScore {
  value: number;       // 0-1 normalized
  confidence: number;  // 0-1 how much data supports this
  reasoning: string;   // human-readable explanation
}

// ========== Signal 1: Engagement Depth ==========

export type EngagementPattern =
  | 'read_replied'          // Read + replied = HIGH
  | 'read_starred'          // Read + starred = HIGH
  | 'read_deleted_fast'     // Read + deleted <5s = NOISE (curiosity)
  | 'read_lingered'         // Read + kept 3+ days in inbox
  | 'read_archived'         // Read + archived = acknowledged, low priority
  | 'unread_old'            // Unread 7+ days = doesn't care
  | 'read_kept'             // Read + still in inbox
  | 'unknown';

export interface EngagementSignal extends SignalScore {
  pattern: EngagementPattern;
}

// ========== Signal 2: Response Expectation ==========

export interface ResponseSignal extends SignalScore {
  recipientRole: 'to' | 'cc' | 'bcc';
  replyRate: number;             // 0-1 user's reply rate to this sender
  avgReplyTimeSec: number | null;
  neverReplied: boolean;
}

// ========== Signal 3: Thread Dynamics ==========

export type ThreadRole =
  | 'initiator'         // User started the thread
  | 'direct_participant'// 2-person back-and-forth
  | 'active_group'      // Group thread, user replies regularly
  | 'observer'          // Group thread, user rarely/never replies
  | 'late_addition'     // User was added mid-thread
  | 'mentioned'         // User's name appears in body
  | 'single';           // Not a thread (single email)

export interface ThreadSignal extends SignalScore {
  role: ThreadRole;
  participantCount: number;
  userReplyCountInThread: number;
  threadLength: number;
  isStalled: boolean;
}

// ========== Signal 4: Sender Relationship ==========

export type SenderRelationship =
  | 'senior_colleague'     // Same domain, they send more, user replies fast
  | 'junior_colleague'     // Same domain, user sends more
  | 'peer_colleague'       // Same domain, balanced exchange
  | 'active_customer'      // Recent frequent two-way
  | 'churning_customer'    // Was active, gone silent 30+ days
  | 'new_prospect'         // First-time inbound
  | 'transactional_vendor' // Invoices/receipts, user reads rarely replies
  | 'marketing_vendor'     // High volume, low read rate
  | 'personal'             // Off-domain, casual tone
  | 'automated'            // No-reply, system
  | 'unknown';

export interface SenderRelationshipSignal extends SignalScore {
  relationship: SenderRelationship;
  directionality: number; // -1 = they send to us mostly, +1 = we send to them mostly
  lastInteractionDaysAgo: number;
}

// ========== Signal 5: Content Urgency ==========

export interface ContentUrgencySignal extends SignalScore {
  hasDeadline: boolean;
  hasDirectQuestion: boolean;
  hasUrgencyMarkers: boolean;
  hasApprovalRequest: boolean;
  hasFinancialContent: boolean;
  userNameMentioned: boolean;
}

// ========== Signal 6: Temporal Patterns ==========

export interface TemporalSignal extends SignalScore {
  emailAgeSec: number;
  isRoutineSender: boolean;
  isBurstFromSender: boolean;
  isOutsideBusinessHours: boolean;
}

// ========== Combined Priority Score ==========

export type PriorityTier = 'critical' | 'high' | 'medium' | 'low' | 'noise';

export interface PriorityScore {
  score: number;   // 0-100
  tier: PriorityTier;
  signals: {
    engagement: EngagementSignal;
    response: ResponseSignal;
    thread: ThreadSignal;
    senderRelationship: SenderRelationshipSignal;
    contentUrgency: ContentUrgencySignal;
    temporal: TemporalSignal;
  };
  reasoning: string;
  recommendedAction: UserActionType | null;
  waitingDuration: string; // "2h", "3d"
  senderContext: string;   // "Active customer, replies within 1h"
}

// ========== Signal Weights ==========

export const SIGNAL_WEIGHTS = {
  engagement: 0.20,
  response: 0.25,
  thread: 0.10,
  senderRelationship: 0.25,
  contentUrgency: 0.10,
  temporal: 0.10,
} as const;

// ========== Data inputs for signal computation ==========

export interface SenderHistoricalStats {
  readThenDeletedFast: number;
  readThenReplied: number;
  readAndKept: number;
  readAndArchived: number;
  unreadOld: number;
  totalFromSender: number;
  replyCount: number;
  avgReplyTimeSec: number | null;
  neverReplied: boolean;
  // Directionality
  inboundCount: number;
  outboundCount: number;
  // Temporal
  isRoutine: boolean;
  burstCount: number;
  lastInteractionAt: number | null;
}

export interface ThreadStats {
  participantCount: number;
  userMessageCount: number;
  totalMessages: number;
  userStarted: boolean;
  lastActivityAt: number;
}
