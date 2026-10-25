import { parseAddresses, type EmailRecord, type FollowUp, type FolderRecord, type SearchQuery } from '@sarvinbox/core';

import type { InboxAssistantAccount, InboxAssistantDashboard, InboxAssistantSource } from '../../src/types/inbox-assistant';
import type { LocalCalendarPreferences, LocalCalendarRange, LocalCalendarSnapshot } from '../../src/types/local-calendar';
import { addLocalDays, dateInTimeZone, startOfLocalDate } from '../../src/utils/local-calendar';

interface DashboardStorage {
  getFolders(): Promise<FolderRecord[]>;
  searchEmailsCount(query: SearchQuery): Promise<number>;
  searchEmails(query: SearchQuery): Promise<EmailRecord[]>;
  listOpenFollowUps(limit?: number): Promise<FollowUp[]>;
}

export interface InboxAssistantDashboardDeps {
  accounts(): InboxAssistantAccount[];
  storage(accountId: string): DashboardStorage | Promise<DashboardStorage>;
  now?(): number;
  calendar?: {
    preferences(): LocalCalendarPreferences;
    snapshot(range: LocalCalendarRange): LocalCalendarSnapshot | Promise<LocalCalendarSnapshot>;
  };
}

const ITEM_LIMIT = 5;
const REPLY_SCAN_LIMIT = 50;
const FOLLOW_UP_LIMIT = 500;
const MAILBOX: SearchQuery = { query: '', scope: 'mailbox', collapseThreads: true };

function selectedAccounts(value: unknown, registered: InboxAssistantAccount[]): InboxAssistantAccount[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'accountIds')) throw new Error('Choose accounts for the Inbox Agent overview.');
  const ids = (value as { accountIds?: unknown }).accountIds;
  if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string' || !id || id.length > 500)) {
    throw new Error('Choose up to ten connected accounts for the overview.');
  }
  return [...new Set(ids as string[])].map(id => {
    const account = registered.find(item => item.id === id);
    if (!account) throw new Error('An overview account is no longer connected. Refresh your accounts.');
    return account;
  });
}

function validCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Local conversation counts are unavailable.');
  return value;
}

function source(account: InboxAssistantAccount, email: EmailRecord, folders: FolderRecord[]): InboxAssistantSource {
  const folder = folders.find(item => item.id === email.folderId);
  const path = folder?.path || '';
  const sent = folder?.specialUse?.toLowerCase() === '\\sent'
    || /^(?:sent|sent items|sent mail|\[gmail\]\/sent mail)$/i.test(path);
  return {
    id: `overview:${email.id}`, kind: 'message', accountId: account.id, accountEmail: account.email,
    emailId: email.id, threadId: email.threadId || email.id, subject: email.subject || '(No subject)',
    from: email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress,
    to: parseAddresses(email.toAddress || ''), date: email.date, folder: path, sent,
    // Headers-only rows deliberately carry no body, including no list preview
    // presented as a verified summary. The shared source pane opens the original.
    excerpt: '',
  };
}

function followUpSource(account: InboxAssistantAccount, item: FollowUp): InboxAssistantSource | undefined {
  if (!item.emailId) return undefined;
  return {
    id: `follow-up:${item.id}`, kind: 'message', accountId: account.id, accountEmail: account.email,
    emailId: item.emailId, threadId: item.threadId || item.emailId, subject: item.subject || '(No subject)',
    from: item.fromAddress, to: parseAddresses(item.recipients), date: item.sentAt,
    folder: 'Sent', sent: true, excerpt: '',
  };
}

/** Counts and widgets use saved local data. No AI, IMAP, attachment reads or mail writes. */
export async function buildInboxAssistantDashboard(value: unknown, deps: InboxAssistantDashboardDeps): Promise<InboxAssistantDashboard> {
  const accounts = selectedAccounts(value, deps.accounts());
  const now = deps.now?.() ?? Date.now();
  const warnings: string[] = [];
  const data = await Promise.all(accounts.map(async account => {
    try {
      const storage = await deps.storage(account.id);
      const [folders, unread, uncategorized, needsReply, replyRows, reminders] = await Promise.all([
        storage.getFolders(),
        storage.searchEmailsCount({ ...MAILBOX, isUnread: true }),
        storage.searchEmailsCount({ ...MAILBOX, isUnread: true, noCategory: true }),
        storage.searchEmailsCount({ ...MAILBOX, aiCategory: 'needs_response' }),
        // One row limit bounds bytes even for conversations with many members.
        // Deduplicate locally; the independent count remains conversation-based.
        storage.searchEmails({ query: '', scope: 'mailbox', aiCategory: 'needs_response', headersOnly: true, limit: REPLY_SCAN_LIMIT, sortBy: 'date', sortOrder: 'desc' }),
        storage.listOpenFollowUps(FOLLOW_UP_LIMIT),
      ]);
      const byThread = new Map<string, InboxAssistantSource>();
      for (const email of replyRows) {
        const key = email.threadId || email.id;
        if (!byThread.has(key)) byThread.set(key, source(account, email, folders));
      }
      const replySources = [...byThread.values()];
      const due = reminders.filter(item => (item.status === 'pending' || item.status === 'due') && item.dueAt * 1000 <= now);
      const syncIncomplete = folders.some(folder => folder.backfillComplete === false
        || (folder.serverMessageCount !== undefined && folder.serverMessageCount > folder.totalCount));
      return {
        account, status: 'ready' as const, unread: validCount(unread), uncategorized: validCount(uncategorized), needsReply: validCount(needsReply),
        replySources, reminders: due.map(item => ({ id: item.id, accountId: account.id, subject: item.subject || '(No subject)', to: item.recipients,
          dueAt: item.dueAt * 1000, source: followUpSource(account, item) })),
        remindersLimited: reminders.length >= FOLLOW_UP_LIMIT, syncIncomplete,
      };
    } catch {
      return { account, status: 'unavailable' as const };
    }
  }));

  // Never return a removed account's rows from a request that raced disconnect.
  const current = deps.accounts();
  if (accounts.some(account => !current.some(item => item.id === account.id && item.email === account.email))) {
    throw new Error('Your connected accounts changed. Refresh the overview.');
  }
  const ready = data.filter(item => item.status === 'ready');
  const complete = ready.length === accounts.length;
  const sum = (field: 'unread' | 'uncategorized' | 'needsReply') => complete ? ready.reduce((total, item) => total + item[field], 0) : null;
  const needsReplyTotal = sum('needsReply');
  const replyItems = ready.flatMap(item => item.replySources).sort((left, right) => right.date - left.date || left.accountId.localeCompare(right.accountId)).slice(0, ITEM_LIMIT);
  const dueItems = ready.flatMap(item => item.reminders).sort((left, right) => left.dueAt - right.dueAt || left.id.localeCompare(right.id));
  const followUpsLimited = !complete || ready.some(item => item.remindersLimited);
  for (const item of data) {
    if (item.status === 'unavailable') warnings.push(`Local mail for ${item.account.email} could not be loaded. Totals are unavailable rather than counted as zero.`);
    else {
      if (item.syncIncomplete) warnings.push(`Older mail is still synchronizing for ${item.account.email}; this overview covers locally available mail.`);
      if (item.remindersLimited) warnings.push(`Follow-up reminders for ${item.account.email} reached the local listing limit. The total is unavailable.`);
    }
  }

  let meetings: InboxAssistantDashboard['meetings'] = { status: 'unavailable', scope: 'local-only', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', items: [] };
  try {
    if (!deps.calendar) throw new Error('Local calendar unavailable.');
    const timeZone = deps.calendar.preferences().timeZone;
    const date = dateInTimeZone(now, timeZone);
    const range = { startMs: startOfLocalDate(date, timeZone), endMs: startOfLocalDate(addLocalDays(date, 7), timeZone) };
    const calendar = await deps.calendar.snapshot(range);
    const visible = new Map(calendar.calendars.filter(item => item.visible).map(item => [item.id, item.name]));
    meetings = { status: 'ready', scope: 'local-only', timeZone, items: calendar.occurrences
      .filter(item => visible.has(item.event.calendarId) && item.event.status !== 'cancelled' && item.endMs > now)
      .sort((left, right) => left.startMs - right.startMs || left.occurrenceId.localeCompare(right.occurrenceId))
      .slice(0, ITEM_LIMIT).map(item => ({ eventId: item.eventId, occurrenceId: item.occurrenceId, startMs: item.startMs, endMs: item.endMs,
        title: item.event.title, calendarName: visible.get(item.event.calendarId)!, allDay: item.event.allDay })) };
  } catch { warnings.push('The local calendar could not be loaded. Meeting availability is not confirmed.'); }

  return {
    generatedAt: now,
    accounts: data.map(item => ({ ...item.account, status: item.status, ...(item.status === 'unavailable' ? { error: 'Open this mailbox and refresh the overview.' } : {}) })),
    counts: { unreadConversations: sum('unread'), uncategorizedUnreadConversations: sum('uncategorized'), needsReplyConversations: needsReplyTotal },
    needsReply: { total: needsReplyTotal, items: replyItems, truncated: needsReplyTotal === null || needsReplyTotal > replyItems.length },
    followUps: { total: followUpsLimited ? null : dueItems.length, items: dueItems.slice(0, ITEM_LIMIT), truncated: followUpsLimited || dueItems.length > ITEM_LIMIT },
    meetings, warnings,
  };
}
