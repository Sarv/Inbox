import { addLocalDays, dateInTimeZone, localWeekDay, startOfLocalDate, validLocalDate, validateTimeZone } from '../../src/utils/local-calendar';

import { INBOX_ASSISTANT_FOLLOWUP_SEPARATOR, inboxAssistantExplicitIntent } from './inbox-assistant-context';

export interface InboxAssistantSearchScope {
  filters: { after?: string; before?: string };
  /** Inclusive Unix-second boundaries for message receipt/sending dates, not event times. */
  timeWindow?: { dateFrom: number; dateTo: number; timeZone: string; label: string };
  topicTerms: string[];
  /** Every group is required; alternatives within one group are equivalent search terms. */
  topicGroups: string[][];
  queryTerms: string[];
  intent?: 'sent' | 'all';
  meetingIntent: boolean;
  invitationIntent?: boolean;
}

const STOP_WORDS = new Set(('a about all am an and any are as at be been both by can check could did do does each email emails find for from get give had has have how i if in information is it just know latest list look mail mails me message messages more my of on only or our please recent regarding related search see send sent show some tell than that the their them there these they this those to us was we were what when where whether which who why will with would you your read summarize summarise explain extract full complete original again '
  + 'today yesterday tomorrow week weeks month months day days past last next current currently morning afternoon evening tonight monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december').split(/\s+/));
const MEETING_WORDS = ['meeting', 'meetings', 'invite', 'invites', 'invitation', 'invitations', 'appointment', 'appointments'];
const MEETING_SEARCH_TERMS = ['meeting', 'invitation', 'invite', 'appointment'];
const MEETING_QUALIFIERS = new Set([...MEETING_WORDS,
  'calendar', 'calendars', 'confirmation', 'confirmations', 'scheduled', 'schedule', 'scheduling',
  'received', 'receive', 'receiving', 'arrived', 'arrive', 'arriving', 'came', 'come', 'coming', 'got', 'found',
  'incoming', 'inbound', 'outgoing', 'new', 'upcoming', 'available', 'inbox', 'inboxes', 'account', 'accounts', 'selected', 'connected',
  'create', 'make', 'prepare', 'generate', 'summary', 'summaries', 'recap', 'overview', 'report', 'reports', 'details', 'info', 'share',
  'mentioned', 'mention', 'mentions', 'contained', 'contains', 'containing',
]);

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Functional/relative-date words are never mailbox topics in their own right. */
export function meaningfulInboxAssistantTerms(values: string[]): string[] {
  return unique(values.slice(0, 32).flatMap(value => {
    const words = value.trim().slice(0, 160).match(/[\p{L}\p{N}][\p{L}\p{N}@._+-]*/gu) ?? [];
    const useful = words.filter(word => word.length > 1 && !STOP_WORDS.has(word.toLowerCase()) && !/^\d{4}-\d{2}-\d{2}$/.test(word));
    return useful.length ? [useful.join(' ')] : [];
  })).slice(0, 12);
}

export function matchesInboxAssistantTerm(value: string, term: string): boolean {
  const alternatives = MEETING_WORDS.includes(term.toLowerCase()) ? MEETING_WORDS : [term];
  return alternatives.some(alternative => {
    const escaped = alternative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}])${escaped}(?=$|[^\\p{L}])`, 'iu').test(value);
  });
}

function relativeDates(question: string, today: string): { after: string; before: string } | undefined {
  // Negated/qualified dates need a different range; never silently invert them.
  if (/\b(?:not|except|excluding|before|after|until|since|from)\s+(?:today|yesterday|tomorrow|this week|last week|next week|this month|last month|next month)\b/i.test(question)) return undefined;
  const single = [...question.matchAll(/\b(today|yesterday|tomorrow|tonight)\b/gi)];
  const choices = unique(single.map(match => match[1]!.toLowerCase().replace('tonight', 'today')));
  if (choices.length === 1 && !/\b(?:this|last|next)\s+(?:week|month)\b|\b(?:last|past)\s+\d+\s+days\b/i.test(question)) {
    const offset = choices[0] === 'yesterday' ? -1 : choices[0] === 'tomorrow' ? 1 : 0;
    const after = addLocalDays(today, offset);
    return { after, before: addLocalDays(after, 1) };
  }
  if (choices.length) return undefined;
  const days = question.match(/\b(?:last|past)\s+(\d{1,3})\s+days\b/i);
  if (days && Number(days[1]) >= 1 && Number(days[1]) <= 366) return { after: addLocalDays(today, 1 - Number(days[1])), before: addLocalDays(today, 1) };
  const week = question.match(/\b(this|last|next)\s+week\b/i);
  if (week) {
    const monday = addLocalDays(today, -((localWeekDay(today) + 6) % 7));
    const after = addLocalDays(monday, week[1]!.toLowerCase() === 'last' ? -7 : week[1]!.toLowerCase() === 'next' ? 7 : 0);
    return { after, before: addLocalDays(after, 7) };
  }
  const month = question.match(/\b(this|last|next)\s+month\b/i);
  if (month) {
    const date = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + (month[1]!.toLowerCase() === 'last' ? -1 : month[1]!.toLowerCase() === 'next' ? 1 : 0));
    const after = date.toISOString().slice(0, 10);
    date.setUTCMonth(date.getUTCMonth() + 1);
    return { after, before: date.toISOString().slice(0, 10) };
  }
  return undefined;
}

/** Host-derived constraints survive invalid/provider-unavailable model planning. */
export function resolveInboxAssistantSearchScope(question: string, options: { nowMs?: number; now?: Date; timeZone?: string; today?: string } = {}): InboxAssistantSearchScope {
  const latest = question.split(INBOX_ASSISTANT_FOLLOWUP_SEPARATOR)[0]!.trim().slice(0, 4_000);
  const timeZone = validateTimeZone(options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  const nowMs = options.nowMs ?? options.now?.getTime() ?? Date.now();
  const today = options.today && validLocalDate(options.today) ? options.today : dateInTimeZone(nowMs, timeZone);
  const dates = relativeDates(latest, today);
  const meetingIntent = /\b(?:meetings?|invites?|invitations?|appointments?)\b/i.test(latest);
  const invitationIntent = /\b(?:invites?|invitations?)\b/i.test(latest);
  const rawTerms = meaningfulInboxAssistantTerms(latest.split(/\s+/));
  const anchors = meetingIntent ? rawTerms.filter(term => !MEETING_QUALIFIERS.has(term.toLowerCase()) && !/^\d+$/.test(term)).slice(0, 4) : [];
  const topicTerms = meetingIntent ? [...anchors, 'meeting'] : [];
  return {
    filters: dates ?? {},
    ...(dates ? { timeWindow: { dateFrom: Math.floor(startOfLocalDate(dates.after, timeZone) / 1000), dateTo: Math.ceil(startOfLocalDate(dates.before, timeZone) / 1000) - 1, timeZone, label: `${dates.after} to ${dates.before} (exclusive), ${timeZone}; message dates` } } : {}),
    topicTerms,
    topicGroups: meetingIntent ? [...anchors.map(term => [term]), MEETING_WORDS.slice()] : [],
    queryTerms: meetingIntent ? unique([...anchors, ...MEETING_SEARCH_TERMS]) : [],
    intent: inboxAssistantExplicitIntent(latest),
    meetingIntent,
    ...(invitationIntent ? { invitationIntent: true } : {}),
  };
}
