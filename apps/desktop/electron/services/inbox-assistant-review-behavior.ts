/** Only facts already recorded in the named mailbox; no free-text history. */
export interface UnreadReviewBehaviorSignals {
  received90d: number;
  opened90d: number;
  markedRead90d: number;
  deleted90d: number;
  archived90d: number;
  replied90d: number;
  keptUnread90d: number;
  starred90d: number;
  important90d: number;
  sentLifetime: number;
  lastSentAt: number | null;
  isVip: boolean;
  isBlocked: boolean;
}

export interface UnreadReviewBehaviorContext {
  text: string;
  available: boolean;
  senderCount: number;
  omittedSenderCount: number;
}

const MAX_SENDERS = 4;
const MAX_CHARS = 1800;
const MAX_COUNT = 9_999_999;
const UNAVAILABLE = 'Sender behavior unavailable; missing history is not evidence of low value.';
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : undefined;

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
    const unavailable = (omittedSenderCount = 0): UnreadReviewBehaviorContext => ({ text: UNAVAILABLE, available: false, senderCount: 0, omittedSenderCount });
    if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string'
      || value.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(value.trim()))) return unavailable();
    const all = [...new Set(values.map(value => value.trim().toLowerCase()))].sort();
    if (!all.length) return unavailable();
    const selected = all.slice(0, MAX_SENDERS);
    const nowSec = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(nowSec) || nowSec <= 0) return unavailable(all.length);
    const missing = selected.filter(sender => !known.has(sender));
    if (missing.length) {
      try {
        const found = query(missing, nowSec);
        for (const sender of missing) known.set(sender, Object.prototype.hasOwnProperty.call(found, sender) ? found[sender]! : null);
      } catch { for (const sender of missing) known.set(sender, null); }
    }
    const lines: string[] = [];
    let unavailableSenders = 0;
    for (const sender of selected) {
      const data = known.get(sender);
      const fields = data ? [data.received90d, data.opened90d, data.markedRead90d, data.deleted90d, data.archived90d,
        data.replied90d, data.keptUnread90d, data.starred90d, data.important90d, data.sentLifetime] : [];
      if (!data || fields.some(value => count(value) === undefined) || typeof data.isVip !== 'boolean' || typeof data.isBlocked !== 'boolean') {
        unavailableSenders++; continue;
      }
      const activity = [
        ['opened', data.opened90d], ['markedRead', data.markedRead90d], ['deleted', data.deleted90d],
        ['archived', data.archived90d], ['replied', data.replied90d], ['keptUnread', data.keptUnread90d],
        ['starred', data.starred90d], ['important', data.important90d],
      ].filter(([, value]) => Number(value) > 0).map(([label, value]) => `${label}=${value}`);
      const outbound = `outboundLifetime=${data.sentLifetime}`;
      const lastSent = Number.isSafeInteger(data.lastSentAt) && data.lastSentAt! > 0 && data.lastSentAt! <= nowSec
        ? `,lastOutboundDaysAgo=${Math.floor((nowSec - data.lastSentAt!) / 86400)}` : '';
      const flags = [data.isVip ? 'VIP' : '', data.isBlocked ? 'blocked' : ''].filter(Boolean);
      lines.push(`${sender}:received90d=${data.received90d};${activity.join(',') || 'no recorded user actions'};${outbound}${lastSent}${flags.length ? `;${flags.join(',')}` : ''}`);
    }
    if (!lines.length) return unavailable(all.length);
    const omittedSenderCount = all.length - lines.length;
    let text = 'Account-local 90d user actions, distinct emails; automatic/system actions excluded. Missing history is not low value.\n';
    text += lines.join('\n');
    if (omittedSenderCount) text += `\nHistory unavailable or omitted for ${omittedSenderCount} other sender(s); do not infer low engagement.`;
    if (text.length > MAX_CHARS) return unavailable(all.length);
    return { text, available: unavailableSenders === 0, senderCount: lines.length, omittedSenderCount };
  };
}
