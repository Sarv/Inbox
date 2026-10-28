/** Content-free human action facts from one named mailbox, never shared-directory totals. */
export interface SenderBehaviorSignals {
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
  readThenDeleted90d?: number;
  readThenDeletedFast90d?: number;
  readAndKept90d?: number;
  deletedWithoutRead90d?: number;
  recentDeleted30d?: number;
  recentReceived30d?: number;
  lastUserActionAt?: number | null;
  lastUserAction?: string | null;
}

export const SENDER_BEHAVIOR_UNAVAILABLE = 'Sender behavior unavailable; missing history is not evidence of low value.';

/** Send once per prompt, together with the same facts used by categorization and unread review. */
export const SENDER_BEHAVIOR_GUIDANCE = `Account-local 90d human actions count distinct messages; exclude automatic/system/rule/imported flags. Missing history or no observed replies alone is not evidence of low value. Never claim the user never replied; outboundLifetime is sent mail, not verified replies.
At least 3 distinct human deletions or 2 quick read-then-deletes, with no observed replies and no newer retention, strongly support dismissing clearly unsolicited marketing. Old opens/reads or outbound contact do not cancel repeated dismissal. Protect current genuine requests, financial records, business reports, security/legal notices and meeting arrangements. Replies, keep-unread, stars, VIP and retained reads support relevance; archive is not dismissal.
readThenDeletedFast90d: delete within 10 seconds of latest read/open. readAndKept90d: read/open at least 3 days ago, no later delete/archive/unread. deletedWithoutRead90d: no recorded prior read/open in-window, not proof it was never read. Received counts use message dates; actions use action dates. Do not divide them into rates. Facts never authorize a mail action.`;

const MAX_COUNT = 9_999_999;
const OUTCOMES = ['readThenDeleted90d', 'readThenDeletedFast90d', 'readAndKept90d', 'deletedWithoutRead90d', 'recentDeleted30d', 'recentReceived30d'] as const;
const USER_ACTIONS = new Set(['open', 'read', 'delete', 'archive', 'reply', 'reply_all', 'unread', 'star', 'important']);
const count = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;

/** Compact validated facts only. A null result means unavailable, never zero engagement. */
export function formatSenderBehaviorFacts(
  sender: string,
  signals: SenderBehaviorSignals | null | undefined,
  nowSec: number,
): string | null {
  if (typeof sender !== 'string' || sender.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(sender.trim())
    || !Number.isSafeInteger(nowSec) || nowSec <= 0 || !signals) return null;
  const data = signals;
  const fields = [data.received90d, data.opened90d, data.markedRead90d, data.deleted90d, data.archived90d,
    data.replied90d, data.keptUnread90d, data.starred90d, data.important90d, data.sentLifetime];
  if (fields.some(value => !count(value)) || OUTCOMES.some(field => data[field] !== undefined && !count(data[field]))
    || typeof data.isVip !== 'boolean' || typeof data.isBlocked !== 'boolean') return null;
  const entries = [
    ['opened', data.opened90d], ['markedRead', data.markedRead90d], ['deleted', data.deleted90d],
    ['archived', data.archived90d], ['replied', data.replied90d], ['keptUnread', data.keptUnread90d],
    ['starred', data.starred90d], ['important', data.important90d],
  ] as const;
  // Report actual zero replies beside observed actions; do not pretend an
  // entirely unobserved sender has a demonstrated pattern of non-engagement.
  const hasActivity = entries.some(([, value]) => value > 0)
    || OUTCOMES.some(field => field !== 'recentReceived30d' && (data[field] ?? 0) > 0);
  const activity = entries.filter(([label, value]) => value > 0 || (label === 'replied' && hasActivity))
    .map(([label, value]) => `${label}=${value}`);
  const lastSent = Number.isSafeInteger(data.lastSentAt) && data.lastSentAt! > 0 && data.lastSentAt! <= nowSec
    ? `,lastOutboundDaysAgo=${Math.floor((nowSec - data.lastSentAt!) / 86400)}` : '';
  const flags = [data.isVip ? 'VIP' : '', data.isBlocked ? 'blocked' : ''].filter(Boolean);
  const outcomes = hasActivity ? OUTCOMES.filter(field => data[field] !== undefined).map(field => `${field}=${data[field]}`) : [];
  const lastAction = USER_ACTIONS.has(data.lastUserAction ?? '') && Number.isSafeInteger(data.lastUserActionAt)
    && data.lastUserActionAt! > 0 && data.lastUserActionAt! <= nowSec && data.lastUserActionAt! >= nowSec - 90 * 86400
    ? `;lastUserAction=${data.lastUserAction},daysAgo=${Math.floor((nowSec - data.lastUserActionAt!) / 86400)}` : '';
  return `${sender.trim().toLowerCase()}:received90d=${data.received90d};${activity.join(',') || 'no recorded user actions'};outboundLifetime=${data.sentLifetime}${lastSent}${flags.length ? `;${flags.join(',')}` : ''}${outcomes.length ? `;${outcomes.join(',')}` : ''}${lastAction}`;
}
