/**
 * The spam filter's stored verdict — thresholds, reason shape, and the parser
 * for the `spam_reasons` JSON column. Zero imports on purpose: the renderer
 * needs exactly this much to show a score and its reasons on the shield, and
 * pulls it in as `@sarvinbox/core/spam-verdict` without dragging the scorer
 * (and its domain lists) into the browser bundle. The scorer itself is
 * `spam-signals.ts`; it imports from here so the two can never disagree about
 * where the line is.
 */

/** Score at or above which a message IS spam: tagged, filed, kept from the AI. */
export const SPAM_THRESHOLD = 5;
/** Score at or above which the shield shows a warning without filing. */
export const SUSPICIOUS_THRESHOLD = 3;

export type SpamReasonId =
  | 'upstream-spam'
  | 'known-spammer'
  | 'auth-failed'
  | 'display-name-spoof'
  | 'sender-punycode'
  | 'sender-invalid'
  | 'reply-to-freemail'
  | 'reply-to-mismatch'
  | 'missing-message-id'
  | 'malformed-message-id'
  | 'missing-date'
  | 'date-skew'
  | 'fake-reply'
  | 'no-recipient'
  | 'bulk-no-unsubscribe'
  | 'precedence-junk'
  // Reputation stage (spam-reputation.ts): network signals added after insert.
  | 'ip-blocklisted'
  | 'domain-blocklisted'
  | 'user-reported';

export interface SpamReason {
  id: SpamReasonId;
  points: number;
  /** One human-readable sentence, shown as-is in the shield tooltip. */
  detail: string;
}

export type SpamVerdict = 'spam' | 'suspicious' | 'clean';

/** The verdict a stored score amounts to; null when the row was never scored. */
export function spamVerdict(score: number | null | undefined): SpamVerdict | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score >= SPAM_THRESHOLD) return 'spam';
  if (score >= SUSPICIOUS_THRESHOLD) return 'suspicious';
  return 'clean';
}

export function isSpamScore(score: number | null | undefined): boolean {
  return spamVerdict(score) === 'spam';
}

/**
 * The stored `spam_reasons` column back into objects. Tolerant: a NULL, an
 * empty string, malformed JSON or a non-array all read as "no reasons" — a
 * shield that crashes on one bad row is worse than one that shows less.
 */
export function parseSpamReasons(json: string | null | undefined): SpamReason[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is SpamReason =>
        !!r && typeof r === 'object'
        && typeof (r as SpamReason).id === 'string'
        && typeof (r as SpamReason).points === 'number'
        && typeof (r as SpamReason).detail === 'string',
    );
  } catch {
    return [];
  }
}
