/**
 * Behavior Intelligence — Multi-Signal Priority Scoring
 *
 * Combines 6 signal dimensions into a 0-100 priority score per email.
 * Replaces the shallow BehaviorAnalyzer as the primary scoring engine.
 *
 * Signals:
 *   1. Engagement Depth (0.20) — action sequences, not just read/unread
 *   2. Response Expectation (0.25) — TO/CC, reply rate, timing
 *   3. Thread Dynamics (0.10) — role in thread, stalled detection
 *   4. Sender Relationship (0.25) — dynamic hierarchy
 *   5. Content Urgency (0.10) — deadlines, questions, approvals
 *   6. Temporal Patterns (0.10) — age, bursts, routine
 */

import type { ContactType, UserActionType } from '../types/agent';
import type { EmailRecord } from '../types/models';
import { logger } from '../utils/logger';

import { computeContentUrgency } from './signals/content-urgency';
import { computeEngagementDepth } from './signals/engagement-depth';
import { computeResponsePattern } from './signals/response-patterns';
import { computeSenderRelationship } from './signals/sender-relationship';
import { computeTemporalSignal } from './signals/temporal-patterns';
import { computeThreadDynamics } from './signals/thread-dynamics';
import type {
  PriorityScore,
  PriorityTier,
  SenderHistoricalStats,
  ThreadStats,
} from './signals/types';


// ========== Deps interface ==========

export interface BehaviorIntelligenceDeps {
  userEmail: string;
  userName: string; // For name-mention detection
  /** Get all signal data for a sender in one call */
  getSenderSignalData: (senderEmail: string) => SenderHistoricalStats;
  /** Get thread participation stats */
  getThreadParticipation: (threadId: string) => ThreadStats;
  /** Get contact type */
  getContactType: (email: string) => ContactType;
  /** Get user peak activity hours */
  getPeakHours: () => number[];
}

const WEIGHTS = {
  engagement: 0.20,
  response: 0.25,
  thread: 0.10,
  senderRelationship: 0.25,
  contentUrgency: 0.10,
  temporal: 0.10,
};

// ========== Main Class ==========

export class BehaviorIntelligence {
  private peakHoursCache: number[] | null = null;

  constructor(private deps: BehaviorIntelligenceDeps) {}

  /**
   * Score a single email — the main entry point.
   * Returns a 0-100 PriorityScore with all signal breakdowns.
   */
  scoreEmail(email: EmailRecord): PriorityScore {
    const now = Math.floor(Date.now() / 1000);
    const sender = (email.fromAddress || '').toLowerCase();
    const userDomain = this.deps.userEmail.split('@')[1]?.toLowerCase() || '';
    const senderDomain = sender.split('@')[1] || '';
    const isInternal = !!(userDomain && senderDomain === userDomain);

    // Gather data
    let senderData: SenderHistoricalStats;
    try {
      senderData = this.deps.getSenderSignalData(sender);
    } catch {
      senderData = emptySenderStats();
    }

    let threadStats: ThreadStats | null = null;
    if (email.threadId) {
      try {
        threadStats = this.deps.getThreadParticipation(email.threadId);
      } catch { /* thread participation is optional enrichment — ignore lookup failures */ }
    }

    const contactType = this.deps.getContactType(sender);
    const peakHours = this.getPeakHours();

    // Detect recipient role — extract bare addresses and compare exactly,
    // otherwise "joann@example.com" substring-matches user "ann@example.com".
    const toAddrs: string[] = (email.toAddress || '').toLowerCase().match(/[\w.+-]+@[\w.-]+/g) || [];
    const ccAddrs: string[] = (email.ccAddress || '').toLowerCase().match(/[\w.+-]+@[\w.-]+/g) || [];
    const userLower = this.deps.userEmail.toLowerCase();
    const recipientRole: 'to' | 'cc' | 'bcc' =
      toAddrs.includes(userLower) ? 'to' :
      ccAddrs.includes(userLower) ? 'cc' : 'to'; // default to 'to' if unknown

    const isRead = (email.tags || '').includes('|read|');
    const emailBody = email.cleanBody || email.rawBody || '';

    // ========== Compute all 6 signals ==========

    const engagement = computeEngagementDepth(senderData, isRead, now - email.date);

    const response = computeResponsePattern(
      recipientRole,
      senderData.replyCount,
      senderData.totalFromSender,
      senderData.avgReplyTimeSec,
      senderData.neverReplied,
    );

    const thread = computeThreadDynamics(
      threadStats,
      emailBody,
      this.deps.userName,
      !!email.threadId,
    );

    const readRate = senderData.totalFromSender > 0
      ? (senderData.totalFromSender - senderData.unreadOld) / senderData.totalFromSender
      : 0.5;
    const replyRate = senderData.totalFromSender > 0
      ? senderData.replyCount / senderData.totalFromSender
      : 0;
    const lastInteractionDays = senderData.lastInteractionAt
      ? (now - senderData.lastInteractionAt) / 86400
      : 999;

    const senderRelationship = computeSenderRelationship(
      contactType,
      senderData.inboundCount,
      senderData.outboundCount,
      senderData.avgReplyTimeSec,
      isInternal,
      lastInteractionDays,
      senderData.totalFromSender,
      readRate,
      replyRate,
    );

    const contentUrgency = computeContentUrgency(
      email.subject || '',
      emailBody,
      this.deps.userName,
    );

    const temporal = computeTemporalSignal(
      email.date,
      now,
      senderData.isRoutine,
      senderData.burstCount,
      peakHours,
    );

    // ========== Combine into priority score ==========

    const signals = { engagement, response, thread, senderRelationship, contentUrgency, temporal };

    let score = 0;
    let totalWeight = 0;
    for (const [key, weight] of Object.entries(WEIGHTS)) {
      const signal = (signals as any)[key];
      const effectiveWeight = weight * signal.confidence;
      score += signal.value * effectiveWeight * 100;
      totalWeight += effectiveWeight;
    }
    score = totalWeight > 0 ? score / totalWeight : 50;

    // Multipliers for extreme cases
    if (contentUrgency.hasDeadline && (now - email.date) > 86400) {
      score = Math.min(100, score * 1.3); // Overdue deadline
    }
    if (engagement.pattern === 'read_deleted_fast' && recipientRole === 'cc') {
      score = Math.max(0, score * 0.3); // Curiosity CC noise
    }
    if (senderRelationship.relationship === 'automated') {
      score = Math.min(25, score); // Cap automated at LOW
    }

    score = Math.round(Math.max(0, Math.min(100, score)));

    // Tier
    const tier: PriorityTier =
      score >= 90 ? 'critical' :
      score >= 70 ? 'high' :
      score >= 40 ? 'medium' :
      score >= 20 ? 'low' : 'noise';

    // Recommended action based on tier + signals
    const recommendedAction = this.recommendAction(tier, signals);

    // Human-readable combined reasoning
    const topSignals = Object.entries(signals)
      .filter(([, s]) => s.value > 0.5 || s.value < 0.2)
      .sort(([, a], [, b]) => b.value - a.value)
      .slice(0, 3)
      .map(([, s]) => s.reasoning);

    const waitingSec = now - email.date;
    const waitingDuration = waitingSec < 3600 ? `${Math.round(waitingSec / 60)}m` :
      waitingSec < 86400 ? `${Math.round(waitingSec / 3600)}h` :
      `${Math.round(waitingSec / 86400)}d`;

    return {
      score,
      tier,
      signals,
      reasoning: topSignals.join(' | '),
      recommendedAction,
      waitingDuration,
      senderContext: senderRelationship.reasoning,
    };
  }

  /**
   * Batch score multiple emails — shares cached data.
   */
  scoreEmailBatch(emails: EmailRecord[]): Map<string, PriorityScore> {
    const results = new Map<string, PriorityScore>();
    for (const email of emails) {
      try {
        results.set(email.id, this.scoreEmail(email));
      } catch (error) {
        logger.error(`[BehaviorIntelligence] Failed to score ${email.id}:`, error);
      }
    }
    return results;
  }

  private recommendAction(
    tier: PriorityTier,
    signals: PriorityScore['signals'],
  ): UserActionType | null {
    if (tier === 'noise') return 'archive';
    if (tier === 'low' && signals.senderRelationship.relationship === 'automated') return 'read';

    if (signals.response.recipientRole === 'to' && signals.response.replyRate > 0.3) {
      return 'reply';
    }

    if (tier === 'critical' || tier === 'high') {
      if (signals.contentUrgency.hasDirectQuestion || signals.contentUrgency.hasApprovalRequest) {
        return 'reply';
      }
      return 'star';
    }

    if (tier === 'medium') return 'read';
    if (tier === 'low') return 'archive';

    return null;
  }

  private getPeakHours(): number[] {
    if (this.peakHoursCache) return this.peakHoursCache;
    try {
      this.peakHoursCache = this.deps.getPeakHours();
    } catch {
      this.peakHoursCache = [9, 10, 11, 14, 15]; // default business hours
    }
    return this.peakHoursCache;
  }
}

function emptySenderStats(): SenderHistoricalStats {
  return {
    readThenDeletedFast: 0,
    readThenReplied: 0,
    readAndKept: 0,
    readAndArchived: 0,
    unreadOld: 0,
    totalFromSender: 0,
    replyCount: 0,
    avgReplyTimeSec: null,
    neverReplied: true,
    inboundCount: 0,
    outboundCount: 0,
    isRoutine: false,
    burstCount: 0,
    lastInteractionAt: null,
  };
}
