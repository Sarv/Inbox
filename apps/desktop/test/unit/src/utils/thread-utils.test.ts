import type { EmailRecord } from '@sarvinbox/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { InboxSection, SectionFilter } from '../../../../src/config/inbox-types';

import type { EmailThread } from '../../../../src/utils/thread-utils';
import {
  adjustTotalForFilteredOut,
  assignThreadsToSections,
  buildThreads,
  hasImportanceFlag,
  hasStarredFlag,
  isDraft,
  isDraftEmail,
  isDraftRow,
  isRead,
  isSmartPrioritizeEnabled,
  isUnreadCountable,
  sortThreadsForDisplay,
  threadMatchesViewFilter,
  threadRowCount,
  threadRowKey,
  threadStaysVisible,
  threadTagsString,
  visibleThreadsUnderFilter,
} from '../../../../src/utils/thread-utils';

/**
 * Minimal in-memory localStorage. The renderer's Smart-Prioritize switch is read
 * from localStorage on EVERY buildThreads call, and the vitest env is 'node'
 * (no localStorage), so tests install this and restore afterwards.
 */
const installLocalStorage = (seed: Record<string, string> = {}) => {
  const store = new Map(Object.entries(seed));
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};

/** Build an EmailRecord with only the fields a test cares about. */
const email = (over: Partial<EmailRecord> & Record<string, unknown> = {}): EmailRecord =>
  ({
    id: 'e1',
    messageId: '<m1@x>',
    threadId: 't1',
    folderId: 'INBOX',
    uid: 1,
    tags: '|INBOX|',
    subject: 'Subject',
    fromAddress: 'sender@x.com',
    fromName: 'Sender',
    toAddress: 'advik.d@sarv.com',
    toNames: null,
    ccAddress: null,
    ccNames: null,
    bccAddress: null,
    bccNames: null,
    replyTo: null,
    date: 1_000,
    receivedDate: null,
    cleanBody: '',
    rawBody: '',
    contentType: 'html',
    contentHash: 'h',
    inReplyTo: null,
    references: null,
    priority: null,
    hasAttachments: false,
    attachmentCount: 0,
    attachmentNames: null,
    attachmentSizes: null,
    hasEmbedding: false,
    embeddingLastGenerated: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as EmailRecord;

beforeEach(() => installLocalStorage());
afterEach(() => {
  delete (globalThis as any).localStorage;
});

describe('isDraftEmail', () => {
  // The single source of truth for "is this an unsent draft?". A false positive
  // makes a real message un-openable/discardable; a false negative resurrects
  // the immortal-draft bug (a draft that never leaves the list).
  it('treats the local mirror marker |draft| as a draft', () => {
    expect(isDraftEmail(email({ tags: '|Drafts|draft|' }))).toBe(true);
  });

  it('treats the provider-standard Drafts folder tags as drafts', () => {
    expect(isDraftEmail(email({ tags: '|Drafts|' }))).toBe(true);
    expect(isDraftEmail(email({ tags: '|[Gmail]/Drafts|' }))).toBe(true);
  });

  it('matches a provider-specific drafts path supplied by the store', () => {
    // e.g. Dovecot's `INBOX.Drafts` — synced drafts come back tagged only with
    // their folder, never `|draft|`, so without the folder list they'd be missed.
    const paths = new Set(['INBOX.Drafts']);
    expect(isDraftEmail(email({ tags: '|INBOX.Drafts|' }), paths)).toBe(true);
    expect(isDraftEmail(email({ tags: '|INBOX.Drafts|' }))).toBe(false); // no list ⇒ not detected
  });

  it('ignores a blank entry in the drafts-path set', () => {
    // A folder list with an empty path must not make EVERY message a draft
    // (`tags.includes('||')` would otherwise match).
    expect(isDraftEmail(email({ tags: '|INBOX|' }), new Set(['']))).toBe(false);
  });

  it('is NOT a draft once the message has been sent/trashed/junked, stale |draft| tag or not', () => {
    // A sent copy keeps `|draft|`; treating it as live re-shows an already-sent mail.
    expect(isDraftEmail(email({ tags: '|Sent|draft|' }))).toBe(false);
    expect(isDraftEmail(email({ tags: '|Trash|draft|' }))).toBe(false);
    expect(isDraftEmail(email({ tags: '|[Gmail]/Trash|draft|' }))).toBe(false); // no '|Trash|' substring
    expect(isDraftEmail(email({ tags: '|Deleted Items|draft|' }))).toBe(false);
    expect(isDraftEmail(email({ tags: '|Drafts|deleted|' }))).toBe(false); // \Deleted ⇒ awaiting expunge
    expect(isDraftEmail(email({ tags: '|Junk|draft|' }))).toBe(false);
    expect(isDraftEmail(email({ tags: '|Junk Email|draft|' }))).toBe(false);
    expect(isDraftEmail(email({ tags: '|Spam|draft|' }))).toBe(false);
    expect(isDraftEmail(email({ tags: '|[Gmail]/Spam|draft|' }))).toBe(false);
  });

  it('is false for ordinary inbox mail and for missing tags', () => {
    expect(isDraftEmail(email({ tags: '|INBOX|read|' }))).toBe(false);
    expect(isDraftEmail(email({ tags: undefined as unknown as string }))).toBe(false);
  });

  it('isDraft is the no-folder-list shorthand', () => {
    expect(isDraft(email({ tags: '|draft|' }))).toBe(true);
    expect(isDraft(email({ tags: '|INBOX.Drafts|' }))).toBe(false);
  });
});

describe('flag predicates', () => {
  // Tags are authoritative WHENEVER present — the derived booleans are only a
  // fallback for rows that predate the tags column. Getting the precedence
  // backwards would make optimistic star/unstar flips invisible.
  it('reads importance from tags when tags exist, ignoring the derived boolean', () => {
    expect(hasImportanceFlag(email({ tags: '|INBOX|important|' }))).toBe(true);
    expect(hasImportanceFlag(email({ tags: '|INBOX|', isImportant: true }))).toBe(false);
  });

  it('falls back to the derived isImportant only when tags are empty', () => {
    expect(hasImportanceFlag(email({ tags: '', isImportant: true }))).toBe(true);
    expect(hasImportanceFlag(email({ tags: '' }))).toBe(false);
  });

  it('reads starred from tags, falling back to the derived isStarred', () => {
    expect(hasStarredFlag(email({ tags: '|INBOX|starred|' }))).toBe(true);
    expect(hasStarredFlag(email({ tags: '|INBOX|', isStarred: true }))).toBe(false);
    expect(hasStarredFlag(email({ tags: '', isStarred: true }))).toBe(true);
    expect(hasStarredFlag(email({ tags: '' }))).toBe(false);
  });

  it('reads read-state from tags, falling back to the \\Seen IMAP flag', () => {
    expect(isRead(email({ tags: '|INBOX|read|' }))).toBe(true);
    expect(isRead(email({ tags: '|INBOX|' }))).toBe(false);
    expect(isRead(email({ tags: '', flags: ['\\Seen'] }))).toBe(true);
    expect(isRead(email({ tags: '', flags: [] }))).toBe(false);
    expect(isRead(email({ tags: '' }))).toBe(false);
  });
});

describe('isUnreadCountable', () => {
  // This is the client's definition of "bold". It must match the DB's
  // folder-unread badge exactly, or the sidebar count and the list disagree.
  it('counts an ordinary unread inbox message', () => {
    expect(isUnreadCountable(email({ tags: '|INBOX|' }))).toBe(true);
  });

  it('does not count a read message or a draft', () => {
    expect(isUnreadCountable(email({ tags: '|INBOX|read|' }))).toBe(false);
    // The user's OWN draft must never make a thread look like unread mail —
    // clicking can't clear it, so the row would stay bold forever.
    expect(isUnreadCountable(email({ tags: '|Drafts|draft|' }))).toBe(false);
  });

  it('does not count an unread copy sitting in Trash/Spam/Junk/deleted', () => {
    for (const tag of ['Trash', 'Spam', '[Gmail]/Trash', '[Gmail]/Spam', 'Junk', 'Junk Email', 'Deleted Items', 'deleted']) {
      expect(isUnreadCountable(email({ tags: `|${tag}|` }))).toBe(false);
    }
  });

  it('handles a row with no tags at all', () => {
    expect(isUnreadCountable(email({ tags: undefined as unknown as string }))).toBe(true);
  });
});

describe('threadTagsString', () => {
  it('concatenates every loaded message\'s tags so a label on ANY message surfaces', () => {
    // The row must show a label even when it sits on an older message, so
    // callers keep using `includes('|name|')` over the combined string.
    const thread = { emails: [email({ tags: '|INBOX|' }), email({ tags: '|INBOX|starred|' })] } as EmailThread;
    expect(threadTagsString(thread)).toContain('|starred|');
  });

  it('tolerates a message with no tags', () => {
    const thread = { emails: [email({ tags: undefined as unknown as string })] } as EmailThread;
    expect(threadTagsString(thread)).toBe('');
  });
});

describe('isSmartPrioritizeEnabled', () => {
  // Ranking only flips on when BOTH agent flags are set — a half-configured
  // agent must not silently reorder the user's inbox.
  it('is false when no agent config is stored', () => {
    expect(isSmartPrioritizeEnabled()).toBe(false);
  });

  it('is true only when enabled AND autoPrioritize are both true', () => {
    installLocalStorage({ 'sarvinbox-agent-config': JSON.stringify({ enabled: true, autoPrioritize: true }) });
    expect(isSmartPrioritizeEnabled()).toBe(true);

    installLocalStorage({ 'sarvinbox-agent-config': JSON.stringify({ enabled: true }) });
    expect(isSmartPrioritizeEnabled()).toBe(false);

    installLocalStorage({ 'sarvinbox-agent-config': JSON.stringify({ autoPrioritize: true }) });
    expect(isSmartPrioritizeEnabled()).toBe(false);
  });

  it('is false (never throws) on malformed JSON', () => {
    installLocalStorage({ 'sarvinbox-agent-config': '{not json' });
    expect(isSmartPrioritizeEnabled()).toBe(false);
  });

  it('is false when localStorage itself is unavailable', () => {
    // Privacy modes / a stripped renderer can make localStorage throw; the list
    // must still render rather than crashing on the sort.
    delete (globalThis as any).localStorage;
    expect(isSmartPrioritizeEnabled()).toBe(false);
  });
});

describe('threadRowKey / threadRowCount', () => {
  // These are the paging unit for every thread-paged view. If they ever stop
  // agreeing with buildThreads, the paginator counts different rows than the
  // list renders — which is exactly how Starred came to read "of 52" over 15.
  it('counts the same rows buildThreads renders, across every grouping rule', () => {
    const rows = [
      email({ id: 'a', threadId: 't1', date: 3 }),
      email({ id: 'b', threadId: 't1', date: 2 }),   // same conversation
      email({ id: 'c', threadId: '', date: 1 }),     // no threadId -> its own row
      email({ id: 'd', threadId: 't9', accountId: 'one', date: 5 }),
      email({ id: 'e', threadId: 't9', accountId: 'two', date: 5 }), // dual-delivered
    ];
    expect(threadRowCount(rows)).toBe(buildThreads(rows).length);
    expect(threadRowCount(rows)).toBe(4);
    expect(threadRowCount([])).toBe(0);
  });

  it('keys a row the way buildThreads does', () => {
    expect(threadRowKey(email({ id: 'a', threadId: 't1', date: 1 }))).toBe('t1');
    expect(threadRowKey(email({ id: 'a', threadId: '', date: 1 }))).toBe('a');
    expect(threadRowKey(email({ id: 'a', threadId: 't1', accountId: 'acct', date: 1 }))).toBe('acct::t1');
  });
});

describe('buildThreads — grouping', () => {
  it('groups messages by threadId and orders them oldest → newest', () => {
    const threads = buildThreads([
      email({ id: 'b', threadId: 't1', date: 200 }),
      email({ id: 'a', threadId: 't1', date: 100 }),
      email({ id: 'c', threadId: 't1', date: 300 }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].emails.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(threads[0].oldestEmail.id).toBe('a');
    expect(threads[0].latestEmail.id).toBe('c');
  });

  it('falls back to the message id when a row carries no threadId', () => {
    // A draft written before its thread existed has threadId '' — grouping on it
    // would collapse every such row into ONE bogus thread.
    const threads = buildThreads([
      email({ id: 'x', threadId: '', date: 1 }),
      email({ id: 'y', threadId: '', date: 2 }),
    ]);
    expect(threads.map((t) => t.threadId).sort()).toEqual(['x', 'y']);
  });

  it('keeps a dual-delivered message as TWO rows in the unified view', () => {
    // Same Message-ID (⇒ same threadId) delivered to two accounts. Collapsing
    // them would lose one account's colored row in "All Inboxes".
    const threads = buildThreads([
      email({ id: 'a1', threadId: 't9', accountId: 'acct-one', date: 5 }),
      email({ id: 'a2', threadId: 't9', accountId: 'acct-two', date: 5 }),
    ]);
    expect(threads).toHaveLength(2);
    expect(threads.map((t) => t.threadId).sort()).toEqual(['acct-one::t9', 'acct-two::t9']);
  });

  it('returns an empty list for no emails', () => {
    expect(buildThreads([])).toEqual([]);
  });

  it('orders threads newest-last-message first', () => {
    const threads = buildThreads([
      email({ id: 'old', threadId: 'tOld', date: 100 }),
      email({ id: 'new', threadId: 'tNew', date: 900 }),
      email({ id: 'mid', threadId: 'tMid', date: 500 }),
    ]);
    expect(threads.map((t) => t.threadId)).toEqual(['tNew', 'tMid', 'tOld']);
  });
});

describe('buildThreads — derived row state', () => {
  it('points the category badge at the latest NON-draft message', () => {
    // A draft reply is usually the newest email but carries no category; using
    // it would blank the badge on an already-categorized conversation.
    const [thread] = buildThreads([
      email({ id: 'real', threadId: 't', date: 100, tags: '|INBOX|read|' }),
      email({ id: 'aDraft', threadId: 't', date: 200, tags: '|Drafts|draft|' }),
    ]);
    expect(thread.badgeEmailId).toBe('real');
  });

  it('falls back to the latest message when the thread is nothing BUT a draft', () => {
    const [thread] = buildThreads([email({ id: 'onlyDraft', threadId: 't', tags: '|Drafts|draft|' })]);
    expect(thread.badgeEmailId).toBe('onlyDraft');
    expect(thread.draftCount).toBe(1);
    expect(thread.hasDraft).toBe(true);
  });

  it('derives unread state + first-unread from the LOADED rows (optimistic-safe)', () => {
    const [thread] = buildThreads([
      email({ id: 'm1', threadId: 't', date: 100, tags: '|INBOX|read|' }),
      email({ id: 'm2', threadId: 't', date: 200, tags: '|INBOX|' }),
      email({ id: 'm3', threadId: 't', date: 300, tags: '|INBOX|' }),
    ]);
    expect(thread.hasUnread).toBe(true);
    expect(thread.unreadCount).toBe(2);
    expect(thread.firstUnreadEmail?.id).toBe('m2'); // OLDEST unread — where the reader jumps
  });

  it('reports no unread and a null first-unread for a fully read thread', () => {
    const [thread] = buildThreads([email({ threadId: 't', tags: '|INBOX|read|' })]);
    expect(thread.hasUnread).toBe(false);
    expect(thread.unreadCount).toBe(0);
    expect(thread.firstUnreadEmail).toBeNull();
  });

  it('prefers the DB whole-thread message count over the loaded count', () => {
    // A filtered view loads one message of a five-message thread; the row must
    // still show "(5)" the way Gmail does.
    const [thread] = buildThreads([email({ threadId: 't', threadMessageCount: 5 })]);
    expect(thread.messageCount).toBe(5);
  });

  it('falls back to the loaded count when the DB aggregate is absent', () => {
    const [thread] = buildThreads([
      email({ id: 'a', threadId: 't', date: 1 }),
      email({ id: 'b', threadId: 't', date: 2 }),
    ]);
    expect(thread.messageCount).toBe(2);
  });

  it('prefers the thread-wide starred/important aggregates over the loaded subset', () => {
    // The starred copy may live in [Gmail]/Starred and not be loaded in INBOX;
    // without the aggregate the star icon and the Starred section disagree.
    const [starred] = buildThreads([email({ threadId: 't', tags: '|INBOX|', threadIsStarred: true, threadIsImportant: true })]);
    expect(starred.isStarred).toBe(true);
    expect(starred.isImportant).toBe(true);

    // An explicit `false` aggregate must WIN over a locally-tagged copy.
    const [unstarred] = buildThreads([
      email({ threadId: 't', tags: '|INBOX|starred|important|', threadIsStarred: false, threadIsImportant: false }),
    ]);
    expect(unstarred.isStarred).toBe(false);
    expect(unstarred.isImportant).toBe(false);
  });

  it('falls back to per-message flags when no aggregate is present', () => {
    const [thread] = buildThreads([
      email({ id: 'a', threadId: 't', date: 1, tags: '|INBOX|' }),
      email({ id: 'b', threadId: 't', date: 2, tags: '|INBOX|starred|important|' }),
    ]);
    expect(thread.isStarred).toBe(true);
    expect(thread.isImportant).toBe(true);
  });

  it('shows the draft badge from the DB aggregate when the draft is not loaded', () => {
    // The draft lives in [Gmail]/Drafts, outside the inbox query, so draftCount is 0.
    const [thread] = buildThreads([email({ threadId: 't', tags: '|INBOX|read|', threadHasDraft: true })]);
    expect(thread.draftCount).toBe(0);
    expect(thread.hasDraft).toBe(true);
  });

  it('takes the MAX importance and agent-priority score across the thread', () => {
    const [thread] = buildThreads([
      email({ id: 'a', threadId: 't', date: 1, importanceScore: 10, priorityScore: 30 }),
      email({ id: 'b', threadId: 't', date: 2, importanceScore: 70, priorityScore: 5 }),
    ]);
    expect(thread.importanceScore).toBe(70);
    expect(thread.agentPriorityScore).toBe(30);
  });

  it('floors the agent score at 0 and treats missing scores as 0', () => {
    const [thread] = buildThreads([email({ threadId: 't' })]);
    expect(thread.agentPriorityScore).toBe(0);
    expect(thread.importanceScore).toBe(0);
  });

  it('marks a thread priority when it is important, starred OR unread', () => {
    expect(buildThreads([email({ threadId: 'a', tags: '|INBOX|' })])[0].isPriority).toBe(true);
    expect(buildThreads([email({ threadId: 'b', tags: '|INBOX|read|starred|' })])[0].isPriority).toBe(true);
    expect(buildThreads([email({ threadId: 'c', tags: '|INBOX|read|important|' })])[0].isPriority).toBe(true);
    expect(buildThreads([email({ threadId: 'd', tags: '|INBOX|read|' })])[0].isPriority).toBe(false);
  });
});

describe('buildThreads — senderDisplay', () => {
  it('shows a single sender for a one-message thread', () => {
    const [thread] = buildThreads([email({ threadId: 't', fromName: 'Sohum Jadeja' })]);
    expect(thread.senderDisplay).toBe('Sohum Jadeja');
  });

  it('shows "First .. Last" (first names only) for a multi-sender thread', () => {
    const [thread] = buildThreads([
      email({ id: 'a', threadId: 't', date: 1, threadMessageCount: 2, threadFirstSender: 'Sohum Jadeja', threadLastSender: 'Advik Dutta' }),
      email({ id: 'b', threadId: 't', date: 2 }),
    ]);
    expect(thread.senderDisplay).toBe('Sohum .. Advik');
  });

  it('collapses to one name when first and last sender are the SAME person', () => {
    const [thread] = buildThreads([
      email({ id: 'a', threadId: 't', date: 1, threadMessageCount: 3, threadFirstSender: 'Sohum Jadeja', threadLastSender: 'Sohum Jadeja' }),
      email({ id: 'b', threadId: 't', date: 2 }),
    ]);
    expect(thread.senderDisplay).toBe('Sohum Jadeja');
  });

  it('falls back through the loaded rows: threadFirstSender → fromName → fromAddress', () => {
    const [thread] = buildThreads([
      email({ id: 'a', threadId: 't', date: 1, fromName: null, fromAddress: 'first@x.com' }),
      email({ id: 'b', threadId: 't', date: 2, fromName: 'Latest Person', fromAddress: 'last@x.com' }),
    ]);
    expect(thread.senderDisplay).toBe('first@x.com .. Latest'); // 2 loaded ⇒ multi-sender form
  });

  it('yields an empty display when there is no sender information at all', () => {
    const [thread] = buildThreads([email({ threadId: 't', fromName: null, fromAddress: '' })]);
    expect(thread.senderDisplay).toBe('');
  });

  it('falls back to the whole name when it starts with whitespace (no blank first name)', () => {
    // Server-supplied display names often carry a leading space; splitting on
    // whitespace would otherwise yield '' and render " .. Advik".
    const [thread] = buildThreads([
      email({ id: 'a', threadId: 't', date: 1, threadMessageCount: 2, threadFirstSender: ' Sohum Jadeja', threadLastSender: 'Advik Dutta' }),
      email({ id: 'b', threadId: 't', date: 2 }),
    ]);
    expect(thread.senderDisplay).toBe(' Sohum Jadeja .. Advik');
  });
});

describe('sortThreadsForDisplay', () => {
  const thread = (id: string, date: number, score: number): EmailThread =>
    ({ threadId: id, agentPriorityScore: score, latestEmail: { date } } as EmailThread);

  it('sorts by date (newest first) with Smart Prioritize OFF', () => {
    const sorted = sortThreadsForDisplay([thread('a', 100, 99), thread('b', 300, 1), thread('c', 200, 50)]);
    expect(sorted.map((t) => t.threadId)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by agent score first, date as tiebreak, with Smart Prioritize ON', () => {
    installLocalStorage({ 'sarvinbox-agent-config': JSON.stringify({ enabled: true, autoPrioritize: true }) });
    const sorted = sortThreadsForDisplay([
      thread('older-high', 100, 90),
      thread('newest-low', 900, 1),
      thread('newer-high', 500, 90),
    ]);
    expect(sorted.map((t) => t.threadId)).toEqual(['newer-high', 'older-high', 'newest-low']);
  });

  it('does not mutate the input array (callers reuse buildThreads output)', () => {
    const input = [thread('a', 100, 0), thread('b', 300, 0)];
    const sorted = sortThreadsForDisplay(input);
    expect(input.map((t) => t.threadId)).toEqual(['a', 'b']);
    expect(sorted).not.toBe(input);
  });

  it('treats a missing agent score as 0 under Smart Prioritize', () => {
    installLocalStorage({ 'sarvinbox-agent-config': JSON.stringify({ enabled: true, autoPrioritize: true }) });
    const noScore = { threadId: 'no-score', latestEmail: { date: 900 } } as EmailThread;
    const scored = thread('scored', 100, 10);
    expect(sortThreadsForDisplay([noScore, scored]).map((t) => t.threadId)).toEqual(['scored', 'no-score']);
    // …and in the other argument position too (both sides are ||-defaulted).
    expect(sortThreadsForDisplay([scored, noScore]).map((t) => t.threadId)).toEqual(['scored', 'no-score']);
  });

  it('falls back to date when both threads score 0 under Smart Prioritize', () => {
    installLocalStorage({ 'sarvinbox-agent-config': JSON.stringify({ enabled: true, autoPrioritize: true }) });
    const sorted = sortThreadsForDisplay([thread('older', 100, 0), thread('newer', 900, 0)]);
    expect(sorted.map((t) => t.threadId)).toEqual(['newer', 'older']);
  });
});

describe('assignThreadsToSections', () => {
  // Sectioned inbox: every thread must land in exactly ONE section (a duplicate
  // row is the visible bug), and "everything_else" is the catch-all.
  const thread = (id: string, date: number, filter: SectionFilter): EmailThread =>
    ({ threadId: id, latestEmail: { date }, __filter: filter } as unknown as EmailThread);
  const matches = (t: EmailThread, filter: SectionFilter) => (t as unknown as { __filter: SectionFilter }).__filter === filter;
  const section = (id: string, filter: SectionFilter, over: Partial<InboxSection> = {}): InboxSection => ({
    id,
    filter,
    maxItems: 0,
    hideWhenEmpty: false,
    ...over,
  });

  it('assigns each thread once and sweeps the rest into everything_else', () => {
    const threads = [thread('u1', 300, 'unread'), thread('x1', 200, 'none'), thread('u2', 100, 'unread')];
    const result = assignThreadsToSections(threads, [section('s1', 'unread'), section('s2', 'everything_else')], matches);
    expect(result.map((s) => s.threads.map((t) => t.threadId))).toEqual([['u1', 'u2'], ['x1']]);
  });

  it('labels each section from the shared SECTION_FILTER_LABELS map', () => {
    const result = assignThreadsToSections([], [section('s1', 'important_unread'), section('s2', 'everything_else')], matches);
    expect(result.map((s) => s.label)).toEqual(['Important and unread', 'Everything else']);
  });

  it('skips a section whose filter is "none" (the hide-section choice)', () => {
    const result = assignThreadsToSections([thread('a', 1, 'unread')], [section('s1', 'none'), section('s2', 'everything_else')], matches);
    expect(result).toHaveLength(1);
    expect(result[0].section.id).toBe('s2');
  });

  it('never lets a later section re-claim a thread an earlier one took', () => {
    const t = thread('shared', 1, 'starred');
    const result = assignThreadsToSections(t.threadId ? [t] : [], [section('s1', 'starred'), section('s2', 'starred')], matches);
    expect(result[0].threads.map((x) => x.threadId)).toEqual(['shared']);
    expect(result[1].threads).toEqual([]);
  });

  it('sorts newest-first WITHIN a section regardless of input order', () => {
    const result = assignThreadsToSections(
      [thread('old', 100, 'unread'), thread('new', 900, 'unread'), thread('mid', 500, 'unread')],
      [section('s1', 'unread')],
      matches,
    );
    expect(result[0].threads.map((t) => t.threadId)).toEqual(['new', 'mid', 'old']);
  });

  it('caps a section at maxItems, leaving the overflow for everything_else', () => {
    const result = assignThreadsToSections(
      [thread('a', 300, 'unread'), thread('b', 200, 'unread'), thread('c', 100, 'unread')],
      [section('s1', 'unread', { maxItems: 2 }), section('s2', 'everything_else')],
      matches,
    );
    expect(result[0].threads.map((t) => t.threadId)).toEqual(['a', 'b']);
    expect(result[1].threads.map((t) => t.threadId)).toEqual(['c']);
  });

  it('drops an empty section only when hideWhenEmpty is set', () => {
    const sections = [section('hide', 'starred', { hideWhenEmpty: true }), section('keep', 'important', { hideWhenEmpty: false })];
    const result = assignThreadsToSections([], sections, matches);
    expect(result.map((s) => s.section.id)).toEqual(['keep']);
  });

  it('returns an empty list when there are no sections configured', () => {
    expect(assignThreadsToSections([thread('a', 1, 'unread')], [], matches)).toEqual([]);
  });

  it('calls the caller-supplied matcher rather than re-deriving membership', () => {
    // Section membership lives in ONE place (the caller's matchesFn) so the AI
    // box and the inbox can't drift apart on what "important" means.
    const spy = vi.fn(() => true);
    assignThreadsToSections([thread('a', 1, 'unread')], [section('s1', 'important')], spy);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'a' }), 'important');
  });
});

describe('threadMatchesViewFilter', () => {
  /** A thread carrying just the flags/tags a filter looks at. */
  const vfThread = (over: Partial<EmailThread> & { tags?: string[] } = {}): EmailThread => {
    const { tags, ...rest } = over;
    return {
      threadId: 't1',
      hasUnread: false,
      isStarred: false,
      emails: (tags ?? ['|INBOX|']).map((t, i) => email({ id: `e${i}`, tags: t })),
      ...rest,
    } as EmailThread;
  };

  // Without a filter the list must never drop rows — an unfiltered inbox that
  // silently hides mail is the worst possible regression here.
  it('keeps every thread when no filter is active', () => {
    expect(threadMatchesViewFilter(vfThread(), null)).toBe(true);
    expect(threadMatchesViewFilter(vfThread(), undefined)).toBe(true);
  });

  // THE reported bug: marking a mail read under "Filtered: Unread" left the row
  // on screen (it just re-bucketed into "Everything else", which matches all).
  it('drops a thread that has become read under is:unread', () => {
    expect(threadMatchesViewFilter(vfThread({ hasUnread: true }), { isUnread: true })).toBe(true);
    expect(threadMatchesViewFilter(vfThread({ hasUnread: false }), { isUnread: true })).toBe(false);
  });

  // The mirror case (is:read): marking a mail UNREAD must take it out of a
  // read-filtered list, not leave a bold row sitting in it.
  it('drops a thread that has become unread under is:read', () => {
    expect(threadMatchesViewFilter(vfThread({ hasUnread: false }), { isUnread: false })).toBe(true);
    expect(threadMatchesViewFilter(vfThread({ hasUnread: true }), { isUnread: false })).toBe(false);
  });

  // Un-starring under "Filtered: Starred" must remove the row, same as above.
  it('drops an un-starred thread under is:starred', () => {
    expect(threadMatchesViewFilter(vfThread({ isStarred: true }), { isFlagged: true })).toBe(true);
    expect(threadMatchesViewFilter(vfThread({ isStarred: false }), { isFlagged: true })).toBe(false);
  });

  // has:attachment is thread-grained like the DB query: an attachment on ANY
  // message keeps the whole conversation, not only the latest one.
  it('matches has:attachment when any message in the thread has one', () => {
    const withAttachment = vfThread();
    withAttachment.emails = [email({ id: 'a', hasAttachments: false }), email({ id: 'b', hasAttachments: true })];
    expect(threadMatchesViewFilter(withAttachment, { hasAttachments: true })).toBe(true);
    expect(threadMatchesViewFilter(vfThread(), { hasAttachments: true })).toBe(false);
  });

  // is:unlabelled must hide a thread the AI has since categorized — the slug
  // lives in the tags string, so a badge appearing has to remove the row.
  it('drops a categorized thread under is:unlabelled', () => {
    const labelled = vfThread({ tags: ['|INBOX|promotions|'] });
    expect(threadMatchesViewFilter(labelled, { noCategory: true }, ['promotions'])).toBe(false);
    expect(threadMatchesViewFilter(vfThread(), { noCategory: true }, ['promotions'])).toBe(true);
  });

  // Category defs load asynchronously; an empty slug list means "unknown", and
  // guessing would blank an is:unlabelled list on first render.
  it('keeps threads under is:unlabelled while category defs are unknown', () => {
    const labelled = vfThread({ tags: ['|INBOX|promotions|'] });
    expect(threadMatchesViewFilter(labelled, { noCategory: true }, [])).toBe(true);
  });

  // Every condition of a compound filter has to hold — an OR here would leak
  // read mail back into a filtered list.
  it('requires every condition of a compound filter', () => {
    const unreadUnstarred = vfThread({ hasUnread: true, isStarred: false });
    expect(threadMatchesViewFilter(unreadUnstarred, { isUnread: true, isFlagged: true })).toBe(false);
    const unreadStarred = vfThread({ hasUnread: true, isStarred: true });
    expect(threadMatchesViewFilter(unreadStarred, { isUnread: true, isFlagged: true })).toBe(true);
  });

  /**
   * The render-time visibility rule, shared by all three list paths (DB
   * sections, client-side sections, flat list) so they can't disagree about
   * when a row disappears.
   *
   * What breaks if these fail: THE reported bug. Under "Filtered: Unread" the
   * user marked 20+ mails read and not one row left the screen — the flat list
   * had no re-check at all, so the action looked like it had done nothing.
   */
  describe('threadStaysVisible', () => {
    // Breaks: the flat list stops honouring the quick-filter and shows read
    // mail under "Filtered: Unread" until the view is reloaded.
    it('drops a thread that no longer matches the filter', () => {
      expect(threadStaysVisible(vfThread({ hasUnread: false }), { isUnread: true }, [])).toBe(false);
      expect(threadStaysVisible(vfThread({ hasUnread: true }), { isUnread: true }, [])).toBe(true);
    });

    /**
     * Breaks: the row you just clicked vanishes from under the cursor. Opening
     * a mail auto-marks it read, so under "Filtered: Unread" a bare filter
     * check would remove the thread being READ — taking the selection with it
     * and closing the reading pane. It goes on the next load instead.
     */
    it('keeps the OPEN thread even once it stops matching', () => {
      const open = vfThread({ hasUnread: false });
      open.emails = [email({ id: 'reading-this' })];
      expect(threadStaysVisible(open, { isUnread: true }, [], 'reading-this')).toBe(true);
      expect(threadStaysVisible(open, { isUnread: true }, [], 'some-other-mail')).toBe(false);
    });

    // Breaks: with nothing selected, `e.id === undefined` on a row whose id is
    // somehow absent would exempt it and pin a non-matching row on screen.
    it('exempts nothing when no thread is open', () => {
      const noIds = vfThread({ hasUnread: false });
      noIds.emails = [email({ id: undefined as unknown as string })];
      expect(threadStaysVisible(noIds, { isUnread: true }, [], null)).toBe(false);
      expect(threadStaysVisible(noIds, { isUnread: true }, [])).toBe(false);
    });

    // Breaks: an unfiltered list starts hiding mail — the worst regression in
    // this file. No filter means every thread stays, open or not.
    it('keeps every thread when no filter is active', () => {
      expect(threadStaysVisible(vfThread({ hasUnread: false }), null, [])).toBe(true);
      expect(threadStaysVisible(vfThread({ hasUnread: false }), undefined, [])).toBe(true);
    });
  });

  /**
   * What the FLAT list renders — every non-sectioned view: any folder that
   * isn't INBOX, the default inbox type, virtual folders, AI-category pills and
   * the full-page section view. Both section paths already re-checked the
   * filter at render; this one never did, which is why marking mail read under
   * "Filtered: Unread" left every row exactly where it was.
   */
  describe('visibleThreadsUnderFilter', () => {
    const unread = (id: string) => ({
      threadId: id,
      hasUnread: true,
      isStarred: false,
      emails: [email({ id: `${id}-e`, tags: '|INBOX|' })],
    }) as EmailThread;
    const read = (id: string) => ({ ...unread(id), hasUnread: false }) as EmailThread;

    // Breaks: THE reported bug — 20+ mails marked read, not one row leaves the
    // filtered list.
    it('removes threads that stopped matching, keeping the rest', () => {
      const list = [unread('a'), read('b'), unread('c')];

      expect(visibleThreadsUnderFilter(list, { isUnread: true }, []).map((t) => t.threadId))
        .toEqual(['a', 'c']);
    });

    /**
     * Breaks: the list re-renders every row on any unrelated store change. With
     * no filter this sits on the hot render path, so it must hand BACK the same
     * array — a fresh `.filter()` copy is a new reference and defeats the memo.
     */
    it('returns the identical array when no filter is active', () => {
      const list = [unread('a'), read('b')];

      expect(visibleThreadsUnderFilter(list, null, [])).toBe(list);
      expect(visibleThreadsUnderFilter(list, undefined, [])).toBe(list);
    });

    // Breaks: the thread being read disappears mid-click (see threadStaysVisible).
    it('keeps the open thread in the list', () => {
      const openThread = read('b');
      const visible = visibleThreadsUnderFilter([unread('a'), openThread], { isUnread: true }, [], 'b-e');

      expect(visible.map((t) => t.threadId)).toEqual(['a', 'b']);
    });

    // Breaks: an empty filtered list renders as a blank pane instead of the
    // "no emails" state, because the caller was still counting unfiltered rows.
    it('can empty the list entirely', () => {
      expect(visibleThreadsUnderFilter([read('a'), read('b')], { isUnread: true }, [])).toEqual([]);
    });
  });
});

describe('adjustTotalForFilteredOut', () => {
  // Breaks: the paginator says "30 of 30" above 9 visible rows the moment 21
  // mails are read in webmail — the total is a server COUNT from fetch time and
  // does not know the render-time filter just dropped those rows.
  it('subtracts the dropped rows from the server total', () => {
    expect(adjustTotalForFilteredOut(30, 21)).toBe(9);
  });

  it('leaves the total alone when nothing was dropped', () => {
    expect(adjustTotalForFilteredOut(30, 0)).toBe(30);
  });

  // Breaks: a negative "-3 of 30" once the loaded page holds fewer rows than the
  // count (a stale total after a reload, or an out-of-order refresh).
  it('never goes below zero', () => {
    expect(adjustTotalForFilteredOut(2, 5)).toBe(0);
  });

  // Breaks: NaN in the paginator before the first count lands.
  it('treats a missing total as zero', () => {
    expect(adjustTotalForFilteredOut(undefined, 4)).toBe(0);
    expect(adjustTotalForFilteredOut(null, 0)).toBe(0);
  });

  // Guards the caller doing `threads.length - visible.length` in the wrong
  // order: a negative drop must never INFLATE the total past the server count.
  it('ignores a negative dropped count', () => {
    expect(adjustTotalForFilteredOut(30, -5)).toBe(30);
  });
});

/**
 * `isDraftRow` — "should this render as a message in the conversation?"
 *
 * Distinct from `isDraftEmail` ("may I edit this?"), and the difference is a
 * shipped bug: deleting a draft MADE IT APPEAR in the thread. The delete added
 * `|Trash|`, `isDraftEmail` stopped calling it a draft, and the thread view's
 * filter — which used `isDraftEmail` — let it through as an ordinary message.
 * Reported from the field as "draft is deleted but when I open the main thread
 * it's showing".
 */
describe('isDraftRow', () => {
  const row = (tags: string) => ({ tags }) as never;
  const DRAFT_PATHS = new Set(['INBOX.Drafts']);

  it('is true for a live draft', () => {
    expect(isDraftRow(row('|Drafts|draft|'))).toBe(true);
  });

  // THE regression: a discarded draft must stay hidden from the conversation.
  it('is STILL true for a draft that was deleted into Trash', () => {
    expect(isDraftRow(row('|Trash|draft|'))).toBe(true);
    // …whereas the editability question correctly says no.
    expect(isDraftEmail(row('|Trash|draft|'))).toBe(false);
  });

  // A sent copy keeps a stale `|draft|` tag from the compose that made it, but
  // it is a real message. Hiding it would erase the user's own replies from
  // every thread they ever sent one in.
  it('is false for a sent copy carrying a stale draft tag', () => {
    expect(isDraftRow(row('|Sent|draft|'))).toBe(false);
    expect(isDraftRow(row('|[Gmail]/Sent Mail|draft|'))).toBe(false);
    expect(isDraftRow(row('|Sent Items|draft|'))).toBe(false);
  });

  it('recognises a provider Drafts path with no local marker', () => {
    expect(isDraftRow(row('|INBOX.Drafts|'), DRAFT_PATHS)).toBe(true);
    expect(isDraftRow(row('|[Gmail]/Drafts|'))).toBe(true);
  });

  it('is false for ordinary received mail', () => {
    expect(isDraftRow(row('|INBOX|read|'))).toBe(false);
    expect(isDraftRow(row(''))).toBe(false);
  });
});
