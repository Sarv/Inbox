import type { EmailRecord, FollowUp, FolderRecord, SearchQuery } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import { buildInboxAssistantDashboard, type InboxAssistantDashboardDeps } from '../../../../electron/services/inbox-assistant-dashboard';
import type { LocalCalendarEvent, LocalCalendarSnapshot } from '../../../../src/types/local-calendar';

const now = Date.parse('2026-10-24T04:30:00Z');
const accounts = [{ id: 'a', email: 'owner@one.example' }, { id: 'b', email: 'owner@two.example' }];
const email = (id: string, threadId = id): EmailRecord => ({ id, threadId, folderId: 'inbox', fromAddress: 'client@example.test', fromName: 'Client',
  toAddress: 'owner@one.example', date: now / 1000, subject: 'Can we discuss the quote?' } as EmailRecord);
const reminder = (id: string, dueAt = now / 1000 - 1): FollowUp => ({ id, messageId: `<${id}>`, subject: 'Waiting for a response', recipients: 'client@example.test',
  fromAddress: 'owner@one.example', sentAt: dueAt - 86400, dueAt, status: 'pending', emailId: id, threadId: `thread-${id}`, resolvedAt: null });

function fixture() {
  const storage = () => ({
    getFolders: vi.fn(async () => [{ id: 'inbox', path: 'INBOX', totalCount: 20, backfillComplete: true } as FolderRecord]),
    searchEmailsCount: vi.fn(async (query: SearchQuery) => query.noCategory ? 2 : query.aiCategory ? 1 : 7),
    searchEmails: vi.fn(async () => [email('first', 'shared-thread'), email('second', 'shared-thread')]),
    listOpenFollowUps: vi.fn(async () => [reminder('due'), reminder('future', now / 1000 + 86400)]),
  });
  const stores = { a: storage(), b: storage() };
  const calendar = { preferences: vi.fn(() => ({ timeZone: 'Asia/Calcutta' } as never)), snapshot: vi.fn(async () => ({ calendars: [], preferences: { timeZone: 'Asia/Calcutta' }, occurrences: [] } as unknown as LocalCalendarSnapshot)) };
  const deps: InboxAssistantDashboardDeps = { accounts: () => accounts, storage: vi.fn(id => stores[id as keyof typeof stores]), now: () => now, calendar };
  return { deps, stores, calendar };
}

describe('local Inbox Agent overview', () => {
  it('counts account-qualified conversations and loads bounded headers without reading bodies or calling AI', async () => {
    const { deps, stores, calendar } = fixture();
    const result = await buildInboxAssistantDashboard({ accountIds: ['a', 'b', 'a'] }, deps);
    expect(result.counts).toEqual({ unreadConversations: 14, uncategorizedUnreadConversations: 4, needsReplyConversations: 2 });
    expect(result.needsReply.items.map(item => [item.accountId, item.emailId])).toEqual([['a', 'first'], ['b', 'first']]);
    expect(result.needsReply.items.every(item => item.excerpt === '')).toBe(true);
    expect(stores.a.searchEmails).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scope: 'mailbox', headersOnly: true, limit: 50 }));
    expect(stores.a.searchEmailsCount.mock.calls.every(([query]) => query.collapseThreads && query.scope === 'mailbox')).toBe(true);
    expect(result.followUps.total).toBe(2);
    expect(result.followUps.items.every(item => item.dueAt < now && item.source?.sent)).toBe(true);
    expect(calendar.snapshot).toHaveBeenCalledExactlyOnceWith({ startMs: Date.parse('2026-10-23T18:30:00Z'), endMs: Date.parse('2026-10-30T18:30:00Z') });
  });

  it('shows partial account coverage rather than treating unavailable accounts as zero', async () => {
    const { deps } = fixture();
    const original = deps.storage;
    deps.storage = id => { if (id === 'b') throw new Error('Private storage path'); return original(id); };
    const result = await buildInboxAssistantDashboard({ accountIds: ['a', 'b'] }, deps);
    expect(result.counts).toEqual({ unreadConversations: null, uncategorizedUnreadConversations: null, needsReplyConversations: null });
    expect(result.accounts[1]).toMatchObject({ id: 'b', status: 'unavailable' });
    expect(result.needsReply.items).toHaveLength(1);
    expect(result.followUps.total).toBeNull();
    expect(JSON.stringify(result)).not.toContain('Private storage path');
  });

  it('does not invent exact follow-up totals at the repository cap', async () => {
    const { deps, stores } = fixture();
    stores.a.listOpenFollowUps.mockResolvedValue(Array.from({ length: 500 }, (_, index) => reminder(String(index))));
    const result = await buildInboxAssistantDashboard({ accountIds: ['a'] }, deps);
    expect(result.followUps).toMatchObject({ total: null, truncated: true });
    expect(result.followUps.items).toHaveLength(5);
    expect(result.warnings.some(value => value.includes('listing limit'))).toBe(true);
  });

  it('includes visible non-cancelled recurring calendar occurrences still in progress, not hidden or expired ones', async () => {
    const { deps, calendar } = fixture();
    const occurrence = (id: string, calendarId: string, status = 'confirmed', endMs = now + 3600000) => ({ eventId: id, occurrenceId: `${id}:1`, startMs: now - 1000, endMs,
      event: { id, title: id, calendarId, allDay: false, status } as LocalCalendarEvent });
    calendar.snapshot.mockResolvedValue({ calendars: [{ id: 'visible', name: 'Work', visible: true }, { id: 'hidden', name: 'Hidden', visible: false }], occurrences: [
      occurrence('ongoing', 'visible'), occurrence('cancelled', 'visible', 'cancelled'), occurrence('hidden', 'hidden'), occurrence('ended', 'visible', 'confirmed', now - 1),
    ] } as unknown as LocalCalendarSnapshot);
    const result = await buildInboxAssistantDashboard({ accountIds: ['a'] }, deps);
    expect(result.meetings.items).toEqual([expect.objectContaining({ eventId: 'ongoing', occurrenceId: 'ongoing:1', calendarName: 'Work' })]);
  });

  it('keeps mail data when the local calendar fails and reports incomplete sync', async () => {
    const { deps, stores, calendar } = fixture();
    stores.a.getFolders.mockResolvedValue([{ id: 'inbox', backfillComplete: false } as FolderRecord]);
    calendar.snapshot.mockRejectedValue(new Error('Calendar failed'));
    const result = await buildInboxAssistantDashboard({ accountIds: ['a'] }, deps);
    expect(result.counts.unreadConversations).toBe(7);
    expect(result.meetings.status).toBe('unavailable');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('synchronizing'), expect.stringContaining('calendar could not be loaded')]));
  });

  it.each([null, {}, { accountIds: ['removed'] }, { accountIds: [10] }, { accountIds: ['a'], question: 'Mark everything read' }])('rejects invalid or removed account requests before touching storage: %j', async value => {
    const { deps } = fixture();
    await expect(buildInboxAssistantDashboard(value, deps)).rejects.toThrow();
    expect(deps.storage).not.toHaveBeenCalled();
  });

  it('rejects a disconnect racing the read without returning the disconnected account rows', async () => {
    const { deps } = fixture();
    deps.accounts = vi.fn().mockReturnValueOnce(accounts).mockReturnValueOnce([]);
    await expect(buildInboxAssistantDashboard({ accountIds: ['a'] }, deps)).rejects.toThrow('connected accounts changed');
  });
});
