/**
 * Email Processor Service
 *
 * Processes emails to determine importance score using a weighted algorithm.
 * Factors considered:
 * - Authentication (SPF/DKIM/DMARC)
 * - Sender relationship (replied to, sent to, same domain)
 * - Email type (direct recipient vs CC, reply to my email)
 * - Bulk mail indicators (List-Unsubscribe, Precedence headers)
 */

import { parseAuthenticationHeaders } from '@sarv-in/email-spam-scan/headers';
import type { AuthStatus } from '@sarv-in/email-spam-scan/verdict';

import type { EmailRecord } from '../types/models';
import { bulkHeaderSignals, headerLookupFromText } from '../utils/bulk-mail';
import { hasTag } from '../utils/tags';

/**
 * Authentication status parsed from email headers — the library's shape, so
 * the importance scorer and the spam filter read one verdict, not two.
 */
export type { AuthStatus } from '@sarv-in/email-spam-scan/verdict';

/**
 * Sender statistics for scoring
 */
export interface SenderContext {
  email: string;
  domain: string;
  receivedCount: number;
  repliedCount: number;
  sentToCount: number;
  isVip: boolean;
  isBlocked: boolean;
  authPassCount: number;
  authFailCount: number;
}

/**
 * Importance score result
 */
export interface ImportanceResult {
  score: number;
  factors: ImportanceFactor[];
  isImportant: boolean;
  authStatus: AuthStatus;
}

/**
 * Individual factor contributing to importance score
 */
export interface ImportanceFactor {
  name: string;
  weight: number;
  reason: string;
}

/**
 * Weight configuration for importance scoring
 */
export const IMPORTANCE_WEIGHTS = {
  // Authentication
  AUTH_ALL_PASS: 1,
  AUTH_PARTIAL_PASS: 0,
  AUTH_FAIL: -5,

  // Sender relationship
  SAME_DOMAIN: 3,
  REPLIED_TO_SENDER: 3,
  SENT_TO_SENDER: 2,
  VIP_SENDER: 5,
  BLOCKED_SENDER: -10,

  // Email characteristics
  DIRECT_RECIPIENT: 2,
  REPLY_TO_MY_EMAIL: 4,
  CC_RECIPIENT: 0,

  // Bulk mail indicators
  HAS_LIST_UNSUBSCRIBE: -2,
  HAS_PRECEDENCE_BULK: -2,
  HAS_BULK_HEADERS: -1,
  BULK_TAGGED: -2,

  // Subject keywords
  URGENT_KEYWORD: 1,
};

/**
 * Importance thresholds
 */
export const IMPORTANCE_THRESHOLDS = {
  IMPORTANT: 3,      // Score >= 3 is important (e.g., direct recipient + auth pass)
  NORMAL: 1,         // Score >= 1 is normal
  LOW_PRIORITY: -2,  // Score < -2 is low priority
  SUSPICIOUS: -5,    // Score < -5 is suspicious
};

/**
 * Parse authentication results from email headers.
 *
 * The reading is `@sarv-in/email-spam-scan/headers` — the same one the spam
 * filter scores, so the importance weights and the spam points can never
 * disagree about whether a message passed DMARC. Re-exported under the name
 * this module always published: the importance scorer below is only one of its
 * callers, and the rest import it from here.
 */
export { parseAuthenticationHeaders };

/**
 * Check if email has bulk mail headers.
 *
 * The rules are NOT here — they live in `bulkHeaderSignals`, the same set the
 * IMAP client applies at sync time to decide the stored `|bulk|` tag. This
 * function only maps them onto the three buckets the importance weights are
 * expressed in, so the scorer and the sync verdict can never disagree about
 * what a bulk header is.
 */
export function hasBulkHeaders(rawHeaders: string | null | undefined): {
  hasListUnsubscribe: boolean;
  hasPrecedenceBulk: boolean;
  hasOtherBulkIndicators: boolean;
} {
  const signals = bulkHeaderSignals(headerLookupFromText(rawHeaders));
  return {
    hasListUnsubscribe: signals.listUnsubscribe || signals.listId,
    hasPrecedenceBulk: signals.precedenceBulk,
    // Auto-Submitted and Feedback-ID join the vendor tracing headers: all of
    // them say "a machine sent this" without the RFC list headers being set.
    hasOtherBulkIndicators: signals.espTrace || signals.feedbackId || signals.autoSubmitted,
  };
}

/**
 * Check if email is a reply to my email (using In-Reply-To header)
 */
export function isReplyToMyEmail(
  email: EmailRecord,
  myMessageIds: Set<string>
): boolean {
  if (!email.inReplyTo) {
    return false;
  }
  return myMessageIds.has(email.inReplyTo);
}

/**
 * Check if subject contains urgency keywords
 */
export function hasUrgencyKeywords(subject: string | null | undefined): boolean {
  if (!subject) {
    return false;
  }

  const urgentPatterns = [
    /\burgent\b/i,
    /\bimportant\b/i,
    /\basap\b/i,
    /\baction required\b/i,
    /\btime.?sensitive\b/i,
    /\bdeadline\b/i,
    /\bresponse.?needed\b/i,
  ];

  return urgentPatterns.some(pattern => pattern.test(subject));
}

/**
 * Calculate importance score for an email
 */
export function calculateImportanceScore(
  email: EmailRecord,
  senderContext: SenderContext | null,
  userEmail: string,
  userDomain: string,
  myMessageIds: Set<string>,
  rawHeaders?: string | null
): ImportanceResult {
  const factors: ImportanceFactor[] = [];
  let score = 0;

  // 1. Authentication check
  const authStatus = parseAuthenticationHeaders(rawHeaders);

  if (authStatus.overall === 'pass') {
    score += IMPORTANCE_WEIGHTS.AUTH_ALL_PASS;
    factors.push({
      name: 'auth_pass',
      weight: IMPORTANCE_WEIGHTS.AUTH_ALL_PASS,
      reason: 'Email authentication passed (SPF/DKIM/DMARC)',
    });
  } else if (authStatus.overall === 'fail') {
    score += IMPORTANCE_WEIGHTS.AUTH_FAIL;
    factors.push({
      name: 'auth_fail',
      weight: IMPORTANCE_WEIGHTS.AUTH_FAIL,
      reason: 'Email authentication failed - suspicious',
    });
  }

  // 2. Blocked sender check (early exit)
  if (senderContext?.isBlocked) {
    score += IMPORTANCE_WEIGHTS.BLOCKED_SENDER;
    factors.push({
      name: 'blocked_sender',
      weight: IMPORTANCE_WEIGHTS.BLOCKED_SENDER,
      reason: 'Sender is blocked',
    });
    return {
      score,
      factors,
      isImportant: false,
      authStatus,
    };
  }

  // 3. VIP sender check
  if (senderContext?.isVip) {
    score += IMPORTANCE_WEIGHTS.VIP_SENDER;
    factors.push({
      name: 'vip_sender',
      weight: IMPORTANCE_WEIGHTS.VIP_SENDER,
      reason: 'Sender is marked as VIP',
    });
  }

  // 4. Same domain check
  const senderDomain = email.fromAddress?.split('@')[1]?.toLowerCase() || '';
  if (senderDomain && senderDomain === userDomain.toLowerCase()) {
    score += IMPORTANCE_WEIGHTS.SAME_DOMAIN;
    factors.push({
      name: 'same_domain',
      weight: IMPORTANCE_WEIGHTS.SAME_DOMAIN,
      reason: `Same domain as you (${senderDomain})`,
    });
  }

  // 5. Direct recipient check — extract bare addresses and compare exactly,
  // otherwise "joann@example.com" substring-matches user "ann@example.com".
  const toAddresses = email.toAddress?.toLowerCase().match(/[\w.+-]+@[\w.-]+/g) || [];
  const ccAddresses = email.ccAddress?.toLowerCase().match(/[\w.+-]+@[\w.-]+/g) || [];
  const userEmailLower = userEmail.toLowerCase();

  if (toAddresses.some((addr: string) => addr === userEmailLower)) {
    score += IMPORTANCE_WEIGHTS.DIRECT_RECIPIENT;
    factors.push({
      name: 'direct_recipient',
      weight: IMPORTANCE_WEIGHTS.DIRECT_RECIPIENT,
      reason: 'You are a direct recipient (To:)',
    });
  } else if (ccAddresses.some((addr: string) => addr === userEmailLower)) {
    score += IMPORTANCE_WEIGHTS.CC_RECIPIENT;
    factors.push({
      name: 'cc_recipient',
      weight: IMPORTANCE_WEIGHTS.CC_RECIPIENT,
      reason: 'You are CC\'d on this email',
    });
  }

  // 6. Reply to my email check
  if (isReplyToMyEmail(email, myMessageIds)) {
    score += IMPORTANCE_WEIGHTS.REPLY_TO_MY_EMAIL;
    factors.push({
      name: 'reply_to_my_email',
      weight: IMPORTANCE_WEIGHTS.REPLY_TO_MY_EMAIL,
      reason: 'This is a reply to an email you sent',
    });
  }

  // 7. Sender relationship checks
  if (senderContext) {
    if (senderContext.repliedCount > 0) {
      score += IMPORTANCE_WEIGHTS.REPLIED_TO_SENDER;
      factors.push({
        name: 'replied_to_sender',
        weight: IMPORTANCE_WEIGHTS.REPLIED_TO_SENDER,
        reason: `You've replied to this sender ${senderContext.repliedCount} time(s)`,
      });
    } else if (senderContext.sentToCount > 0) {
      score += IMPORTANCE_WEIGHTS.SENT_TO_SENDER;
      factors.push({
        name: 'sent_to_sender',
        weight: IMPORTANCE_WEIGHTS.SENT_TO_SENDER,
        reason: `You've sent emails to this sender ${senderContext.sentToCount} time(s)`,
      });
    }
  }

  // 8. Bulk mail indicators
  const bulkIndicators = hasBulkHeaders(rawHeaders);

  // Most callers store rows, not header blocks. For them the verdict is already
  // on the row: sync ran the same rules once and stamped `|bulk|`. Without this
  // the whole bulk arm silently scored nothing for every such caller.
  if (!rawHeaders && hasTag(email.tags || '', 'bulk')) {
    score += IMPORTANCE_WEIGHTS.BULK_TAGGED;
    factors.push({
      name: 'bulk_tagged',
      weight: IMPORTANCE_WEIGHTS.BULK_TAGGED,
      reason: 'Classified as list/bulk mail at sync',
    });
  }

  if (bulkIndicators.hasListUnsubscribe) {
    score += IMPORTANCE_WEIGHTS.HAS_LIST_UNSUBSCRIBE;
    factors.push({
      name: 'list_unsubscribe',
      weight: IMPORTANCE_WEIGHTS.HAS_LIST_UNSUBSCRIBE,
      reason: 'Has List-Unsubscribe header (newsletter/marketing)',
    });
  }

  if (bulkIndicators.hasPrecedenceBulk) {
    score += IMPORTANCE_WEIGHTS.HAS_PRECEDENCE_BULK;
    factors.push({
      name: 'precedence_bulk',
      weight: IMPORTANCE_WEIGHTS.HAS_PRECEDENCE_BULK,
      reason: 'Has Precedence: bulk header',
    });
  }

  if (bulkIndicators.hasOtherBulkIndicators) {
    score += IMPORTANCE_WEIGHTS.HAS_BULK_HEADERS;
    factors.push({
      name: 'bulk_headers',
      weight: IMPORTANCE_WEIGHTS.HAS_BULK_HEADERS,
      reason: 'Has marketing/campaign headers',
    });
  }

  // 9. Urgency keywords
  if (hasUrgencyKeywords(email.subject)) {
    score += IMPORTANCE_WEIGHTS.URGENT_KEYWORD;
    factors.push({
      name: 'urgent_keyword',
      weight: IMPORTANCE_WEIGHTS.URGENT_KEYWORD,
      reason: 'Subject contains urgency keywords',
    });
  }

  return {
    score,
    factors,
    isImportant: score >= IMPORTANCE_THRESHOLDS.IMPORTANT,
    authStatus,
  };
}

/**
 * Get importance level from score
 */
export function getImportanceLevel(score: number): 'important' | 'normal' | 'low' | 'suspicious' {
  if (score >= IMPORTANCE_THRESHOLDS.IMPORTANT) {
    return 'important';
  } else if (score >= IMPORTANCE_THRESHOLDS.NORMAL) {
    return 'normal';
  } else if (score >= IMPORTANCE_THRESHOLDS.SUSPICIOUS) {
    return 'low';
  } else {
    return 'suspicious';
  }
}
