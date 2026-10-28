import { formatSenderBehaviorFacts, SENDER_BEHAVIOR_UNAVAILABLE, type SenderBehaviorSignals } from '@sarvinbox/core';

export type UnreadReviewBehaviorSignals = SenderBehaviorSignals;

export interface UnreadReviewBehaviorContext {
  text: string;
  available: boolean;
  senderCount: number;
  omittedSenderCount: number;
  /** Trusted mailbox flag, also checked for senders omitted from the text. */
  hasVip?: boolean;
}

const MAX_SENDERS = 4;
const MAX_CHARS = 1800;
/**
 * One collector per mailbox/review. Repeated senders share an in-memory read;
 * the next review creates a fresh collector, so subsequent user actions are
 * reflected in both the prompt and its recommendation-cache fingerprint.
 */
export function createUnreadReviewBehaviorContext(
  query: (senders: string[], nowSec: number) => Record<string, UnreadReviewBehaviorSignals>,
  now: () => number = Date.now,
): (senders: string[]) => Promise<UnreadReviewBehaviorContext> {
  const known = new Map<string, UnreadReviewBehaviorSignals | null>();
  return async (values: string[]) => {
    const unavailable = (omittedSenderCount = 0): UnreadReviewBehaviorContext => ({ text: SENDER_BEHAVIOR_UNAVAILABLE, available: false, senderCount: 0, omittedSenderCount });
    if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string'
      || value.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(value.trim()))) return unavailable();
    const all = [...new Set(values.map(value => value.trim().toLowerCase()))].sort();
    if (!all.length) return unavailable();
    const selected = all.slice(0, MAX_SENDERS);
    const nowSec = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(nowSec) || nowSec <= 0) return unavailable(all.length);
    const missing = all.filter(sender => !known.has(sender));
    if (missing.length) {
      try {
        const found = query(missing, nowSec);
        for (const sender of missing) known.set(sender, Object.prototype.hasOwnProperty.call(found, sender) ? found[sender]! : null);
      } catch { for (const sender of missing) known.set(sender, null); }
    }
    const hasVip = all.some(sender => known.get(sender)?.isVip === true);
    const lines: string[] = [];
    let unavailableSenders = 0;
    for (const sender of selected) {
      const line = formatSenderBehaviorFacts(sender, known.get(sender), nowSec);
      if (line === null) { unavailableSenders++; continue; }
      lines.push(line);
    }
    if (!lines.length) return { ...unavailable(all.length), hasVip };
    let text = 'Account-local 90d user actions, distinct emails; automatic/system actions excluded. Missing history is not low value.\n';
    let included = 0;
    for (const line of lines) {
      // Leave room for an explicit coverage note instead of discarding every
      // sender when rich history or long addresses reach the bounded budget.
      if (text.length + line.length + 120 > MAX_CHARS) break;
      text += `${line}\n`;
      included++;
    }
    if (!included) return { ...unavailable(all.length), hasVip };
    const omittedSenderCount = all.length - included;
    if (omittedSenderCount) text += `\nHistory unavailable or omitted for ${omittedSenderCount} other sender(s); do not infer low engagement.`;
    return { text: text.trimEnd(), available: unavailableSenders === 0 && included === selected.length, senderCount: included, omittedSenderCount, hasVip };
  };
}
