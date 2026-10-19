import type { EmailRecord, SearchQuery } from '@sarvinbox/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../electron/services/core-db', () => ({ getCoreDb: () => { throw new Error('Use the isolated action-service test database.'); } }));

import { createInboxAssistantHistoryStore, type InboxAssistantHistoryStore } from '../../../../electron/services/inbox-assistant-history';
import { InboxAssistantService, inboxAssistantGenericReviewRequest, type InboxAssistantServiceDeps } from '../../../../electron/services/inbox-assistant-service';
import type { InboxAssistantAccount, InboxAssistantExchange, InboxAssistantReviewActionRequest } from '../../../../src/types/inbox-assistant';
import { emailRecord } from '../../../helpers/email-fixtures';

const ACCOUNTS: InboxAssistantAccount[] = [{ id: 'primary', email: 'owner@company.example' }, { id: 'secondary', email: 'sales@company.example' }];
let db: Database.Database;
let history: InboxAssistantHistoryStore;
let service: InboxAssistantService;
let deps: InboxAssistantServiceDeps;
let rows: Map<string, EmailRecord>;
let registered: InboxAssistantAccount[];
let chatId: string;

function newsletter(id: string, overrides: Partial<EmailRecord> = {}): EmailRecord {
  return emailRecord({ id, messageId: `<${id}@offers.example>`, threadId: `thread-${id}`, accountId: 'primary', folderId: 'inbox',
    fromAddress: 'news@offers.example', toAddress: ACCOUNTS[0]!.email, subject: `Newsletter ${id}`, date: 1_700_000_000,
    cleanBody: 'A public newsletter containing seasonal offers and no action request.',
    rawBody: '<p>A public newsletter containing seasonal offers and no action request.</p>', ...overrides });
}

function request(id = 'prepare-1') {
  return { requestId: id, chatId, question: 'Review unread mail', accountIds: ['primary'] };
}

function applyRequest(exchange: InboxAssistantExchange, overrides: Partial<InboxAssistantReviewActionRequest> = {}): InboxAssistantReviewActionRequest {
  return { requestId: 'apply-1', chatId, exchangeId: exchange.id, reviewId: exchange.review!.id,
    itemIds: exchange.review!.items.filter(item => item.recommendation === 'mark_read').map(item => item.id), ...overrides };
}

function recommendation(prompt: string): string {
  const input = prompt.split('\n').find(line => line.startsWith('UNTRUSTED_CONVERSATIONS_JSON: '));
  if (!input) throw new Error('Expected the real read-only review preparation prompt.');
  const items = JSON.parse(input.slice('UNTRUSTED_CONVERSATIONS_JSON: '.length)) as Array<{ id: string; content: string }>;
  return JSON.stringify({ recommendations: items.map(item => ({ id: item.id, recommendation: 'mark_read',
    confidence: /uncertain/i.test(item.content) ? 0.4 : 0.99, reason: 'A synthetic low-value public newsletter.' })) });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE core_blobs(key TEXT PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL)');
  history = createInboxAssistantHistoryStore(() => db);
  chatId = history.create().id;
  registered = [...ACCOUNTS];
  rows = new Map([
    newsletter('safe-a'), newsletter('safe-b'), newsletter('important', { tags: '|INBOX|important|' }),
    newsletter('uncertain'), newsletter('missing', { cleanBody: '', rawBody: '', hasBody: false }),
    newsletter('attachment', { hasAttachments: true, attachmentNames: '["unreviewed.pdf"]' }),
  ].map(row => [row.id, row]));
  const storage = {
    getFolders: vi.fn(async () => [{ id: 'inbox', path: 'INBOX', name: 'Inbox', specialUse: null }]),
    searchEmails: vi.fn(async (query: SearchQuery) => [...rows.values()].filter(row =>
      (query.isUnread === undefined || !row.tags.includes('|read|') === query.isUnread)
      && (!query.query || `${row.fromAddress} ${row.fromName ?? ''} ${row.subject} ${row.rawBody} ${row.cleanBody}`.toLowerCase().includes(query.query.toLowerCase())))
      .slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 25))),
    getEmail: vi.fn(async (id: string) => rows.get(id) ?? null),
    getEmailsByThread: vi.fn(async (threadId: string) => [...rows.values()].filter(row => row.threadId === threadId)),
    getContacts: vi.fn(async () => []), getAttachments: vi.fn(async () => []),
  };
  deps = {
    accounts: () => registered, history,
    openMailbox: vi.fn(async () => ({ storage: storage as never, aliases: [] })),
    readAttachment: vi.fn(),
    callAI: vi.fn(async prompt => recommendation(prompt)),
    setRead: vi.fn(async (accountId, ids, read) => {
      if (accountId !== 'primary') throw new Error('Wrong synthetic mailbox owner.');
      for (const id of ids) {
        const row = rows.get(id)!;
        rows.set(id, { ...row, tags: read ? `${row.tags}read|` : row.tags.replace('|read|', '|') });
      }
      return { appliedIds: [...ids], queuedIds: [], failedIds: [] };
    }),
    moveMail: vi.fn(async (accountId, ids, action) => {
      if (accountId !== 'primary') throw new Error('Wrong synthetic mailbox owner.');
      for (const id of ids) {
        const row = rows.get(id)!;
        rows.set(id, { ...row, tags: row.tags.replace('|INBOX|', '|') + (action === 'trash' ? 'Trash|' : '') });
      }
      return { appliedIds: [...ids], queuedIds: [], failedIds: [] };
    }),
  };
  service = new InboxAssistantService(deps);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe('Inbox Agent conversation approval orchestration', () => {
  it.each(['archive', 'trash'] as const)('persists a manually selected %s receipt for protected reviewed mail', async action => {
    const exchange = await service.ask(request());
    const item = exchange.review!.items.find(value => value.emailId === 'important')!;
    expect(item.mailActionsAllowed).toBe(true);
    const applied = await service.applyReview(applyRequest(exchange, { itemIds: [item.id], action, manualSelection: true }));
    expect(deps.moveMail).toHaveBeenCalledExactlyOnceWith('primary', ['important'], action);
    expect(deps.setRead).not.toHaveBeenCalled();
    expect(applied.reviewResult).toMatchObject({ appliedCount: 1, items: [{ action, status: 'applied' }] });
    expect(history.load(chatId).exchanges[0]!.review!.items.find(value => value.id === item.id)).toMatchObject({ appliedAction: action, undoAvailable: false, mailActionsAllowed: false });
  });

  it.each([
    { action: 'delete', manualSelection: true },
    { action: 'trash' },
    { action: 'archive', manualSelection: false },
    { action: 'trash', manualSelection: true, undo: true },
  ])('rejects invalid or implicit folder action before changing mail: %j', async override => {
    const exchange = await service.ask(request());
    await expect(service.applyReview({ ...applyRequest(exchange), ...override })).rejects.toThrow('Choose valid');
    expect(deps.moveMail).not.toHaveBeenCalled();
    expect(deps.setRead).not.toHaveBeenCalled();
  });

  it('keeps automatic approvals limited to read flags and allows a later explicit archive of the safe post-read snapshot', async () => {
    service.updateChat({ chatId, actionMode: 'approve_for_me' });
    const exchange = await service.ask(request());
    expect(deps.setRead).toHaveBeenCalled();
    expect(deps.moveMail).not.toHaveBeenCalled();
    const item = exchange.review!.items.find(value => value.emailId === 'safe-a')!;
    expect(item).toMatchObject({ appliedAction: 'mark_read', mailActionsAllowed: true });
    const moved = await service.applyReview(applyRequest(exchange, { itemIds: [item.id], action: 'archive', manualSelection: true }));
    expect(moved.reviewResult).toMatchObject({ appliedCount: 1, items: [{ action: 'archive' }] });
    expect(deps.moveMail).toHaveBeenCalledExactlyOnceWith('primary', ['safe-a'], 'archive');
    expect(moved.review!.items.find(value => value.id === item.id)).toMatchObject({ appliedAction: 'archive', undoAvailable: false });
  });

  it('rejects the removed Auto setting without changing the saved approval choice', () => {
    expect(() => service.updateChat({ chatId, actionMode: 'auto' })).toThrow('valid conversation setting');
    expect(history.load(chatId).actionMode ?? 'review').toBe('review');
    expect(deps.setRead).not.toHaveBeenCalled();
  });

  it.each([
    'Review unread mail',
    'Please review my unread emails and mark low-value conversations as read.',
    'Review my uncategorized unread emails.',
    'Show uncategorized conversations',
    'Check all unread emails across all accounts.',
    'Look at my unread inbox conversations',
  ])('recognizes the explicit generic review vocabulary: %s', question => {
    expect(inboxAssistantGenericReviewRequest(question)).toBe(true);
  });

  it.each([
    'Review unread emails from news@offers.example',
    'Review unread emails before October',
    'Review unread emails after 2025',
    'Review unread emails in the last week',
    'Mark unread promotions as read',
    'Review unread social emails',
    'Review only unread invoices',
    'Review unread Acme emails',
    'Review unread emails 2024',
    'Review unread emails résumé',
    'Review unread emails 商城',
    'Review unread emails २०२६',
  ])('rejects unsupported restrictions before opening mail or using delegated approval: %s', async question => {
    service.updateChat({ chatId, actionMode: 'approve_for_me' });
    expect(inboxAssistantGenericReviewRequest(question)).toBe(false);
    await expect(service.ask({ ...request(), question })).rejects.toThrow(/restrictions are not supported/);
    expect(deps.openMailbox).not.toHaveBeenCalled();
    expect(deps.callAI).not.toHaveBeenCalled();
    expect(deps.setRead).not.toHaveBeenCalled();
    expect(history.load(chatId)).toMatchObject({ actionMode: 'approve_for_me', exchanges: [] });
    expect([...rows.values()].every(row => !row.tags.includes('|read|'))).toBe(true);
  });

  it('reviews the BigBlueButton mark-unread command in the correct direction, then applies and undoes only matching read messages', async () => {
    rows.clear();
    const original = newsletter('bbb-read', { fromAddress: 'news@bigbluebutton.example', subject: 'BigBlueButton update', tags: '|INBOX|read|', threadId: 'mixed' });
    const unrelated = newsletter('other-read', { tags: '|INBOX|read|', threadId: 'mixed' });
    const bodyMatch = newsletter('body-match', { rawBody: '<p>BigBlueButton deployment notes</p>', tags: '|INBOX|read|' });
    const alreadyUnread = newsletter('bbb-unread', { subject: 'BigBlueButton notice' });
    for (const row of [original, unrelated, bodyMatch, alreadyUnread]) rows.set(row.id, row);
    const result = await service.ask({ ...request(), question: 'mark all bigbluebutton email unread' });
    expect(result.review).toMatchObject({ kind: 'mark_unread', scope: { query: 'bigbluebutton', field: 'any' } });
    expect(result.review!.items.flatMap(item => item.targetEmailIds!).sort()).toEqual(['bbb-read', 'body-match']);
    expect(result.answer.text).toContain('marking as unread');
    expect(deps.setRead).not.toHaveBeenCalled(); expect(deps.callAI).not.toHaveBeenCalled();
    const action = { ...applyRequest(result), itemIds: result.review!.items.map(item => item.id) };
    const changed = await service.applyReview(action);
    expect(changed.reviewResult).toMatchObject({ appliedCount: 2, failedCount: 0 });
    expect(vi.mocked(deps.setRead!).mock.calls.every(([, , read]) => read === false)).toBe(true);
    expect(rows.get('other-read')!.tags).toBe(unrelated.tags);
    expect(rows.get('bbb-unread')!.tags).toBe(alreadyUnread.tags);
    expect(rows.get('bbb-read')!.tags).not.toContain('|read|');
    await service.applyReview({ ...action, requestId: 'undo-scoped', undo: true });
    expect(rows.get('bbb-read')!.tags).toContain('|read|');
    expect(rows.get('body-match')!.tags).toContain('|read|');
    expect(rows.get('bbb-unread')!.tags).not.toContain('|read|');
  });

  it('allows delegated scoped mark-unread actions without resetting approval', async () => {
    rows.clear(); rows.set('bbb', newsletter('bbb', { subject: 'BigBlueButton', tags: '|INBOX|read|' }));
    service.updateChat({ chatId, actionMode: 'approve_for_me' });
    const result = await service.ask({ ...request(), question: 'Mark all BigBlueButton emails unread' });
    expect(result.reviewResult).toMatchObject({ appliedCount: 1 });
    expect(deps.setRead).toHaveBeenCalledWith('primary', ['bbb'], false);
    expect(history.load(chatId).actionMode).toBe('approve_for_me');
  });

  it.each(['Mark all emails unread', 'mark all unread emails read', 'mark BigBlueButton emails unread and read', 'mark emails read', 'mark all BigBlueButton emails unread before October', 'Mark these emails as unread for me', 'Please mark my emails as unread please', 'Can you please mark all my emails unread'])('never turns a rejected flag command into opposite-direction triage: %s', async question => {
    service.updateChat({ chatId, actionMode: 'approve_for_me' });
    await expect(service.ask({ ...request(), question })).rejects.toThrow();
    expect(deps.setRead).not.toHaveBeenCalled();
    expect(deps.openMailbox).not.toHaveBeenCalled();
  });

  it('acknowledges Stop and releases the request slot even when a mailbox opening promise has not settled', async () => {
    const open = deps.openMailbox;
    let release!: (value: Awaited<ReturnType<typeof open>>) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    deps.openMailbox = vi.fn(() => { began(); return new Promise<Awaited<ReturnType<typeof open>>>(resolve => { release = resolve; }); });
    const events = vi.fn();
    const pending = service.ask(request('hung-search'), events);
    const rejected = expect(pending).rejects.toThrow(/cancel/i);
    await started;
    expect(await service.cancel('unknown')).toEqual({ requestId: 'unknown', cancelled: false });
    expect(await service.cancel('hung-search')).toEqual({ requestId: 'hung-search', cancelled: true });
    await rejected;
    const count = events.mock.calls.length;
    deps.openMailbox = open;
    const next = await service.ask(request('next-search'));
    release(await open('primary'));
    await new Promise(resolve => setImmediate(resolve));
    expect(events).toHaveBeenCalledTimes(count);
    expect(history.load(chatId).exchanges.map(exchange => exchange.id)).toEqual([next.id]);
    await expect(service.cancel({ requestId: 'wrong' })).rejects.toThrow('Invalid');
  });

  it('rewinds before a question, invalidates its review capability and restores the prior conversation without changing mail', async () => {
    const first = await service.ask(request());
    const second = await service.ask(request('second'));
    const rewound = await service.rewindChat({ chatId, exchangeId: second.id });
    expect(rewound).toMatchObject({ question: second.question, accountIds: ['primary'], chat: { rewindAvailable: true, exchangeCount: 1 } });
    expect(rewound.chat.exchanges.map(item => item.id)).toEqual([first.id]);
    await expect(service.applyReview(applyRequest(second))).rejects.toThrow('expired');
    const restored = await service.restoreRewindChat({ chatId });
    expect(restored.exchanges.map(item => item.id)).toEqual([first.id, second.id]);
    expect(restored.exchanges.every(item => item.review?.status === 'expired')).toBe(true);
    expect(deps.setRead).not.toHaveBeenCalled();
    await expect(service.rewindChat({ chatId, exchangeId: 'missing' })).rejects.toThrow('no longer');
    await expect(service.rewindChat({ chatId, exchangeId: first.id, injected: true })).rejects.toThrow('Choose');
  });

  it('refuses a rewind if a reviewed mail action acquires the chat while cancellation is being acknowledged', async () => {
    const exchange = await service.ask(request());
    const rewinding = service.rewindChat({ chatId, exchangeId: exchange.id });
    const applying = service.applyReview(applyRequest(exchange));
    await expect(rewinding).rejects.toThrow('new request started');
    const completed = await applying;
    expect(completed.reviewResult?.appliedCount).toBe(2);
    expect(history.load(chatId).exchanges[0]?.reviewResult).toEqual(completed.reviewResult);
  });

  it('rejects an all-accounts request when the selected scope contains only one account', async () => {
    service.updateChat({ chatId, actionMode: 'approve_for_me' });
    await expect(service.ask({ ...request(), question: 'Review unread mail across all accounts' }))
      .rejects.toThrow('Select all accounts');
    expect(deps.openMailbox).not.toHaveBeenCalled();
    expect(deps.callAI).not.toHaveBeenCalled();
    expect(deps.setRead).not.toHaveBeenCalled();
    expect(history.load(chatId)).toMatchObject({ actionMode: 'approve_for_me', exchanges: [] });
  });

  it('prepares a real read-only review without changing flags or calling the QA provider flow', async () => {
    const result = await service.ask(request());
    expect(result.review?.items).toHaveLength(6);
    expect(result.review?.items.filter(item => item.recommendation === 'mark_read')).toHaveLength(2);
    expect(result.review?.items.find(item => item.emailId === 'important')?.protectedReasons.length).toBeGreaterThan(0);
    expect(result.review?.items.find(item => item.emailId === 'missing')?.bodyUnavailable).toBe(true);
    expect(result.review?.items.find(item => item.emailId === 'attachment')?.attachmentsUnknown).toBe(true);
    expect(result.review?.items.find(item => item.emailId === 'uncertain')?.recommendation).toBe('needs_review');
    expect(deps.setRead).not.toHaveBeenCalled();
    expect([...rows.values()].every(row => !row.tags.includes('|read|'))).toBe(true);
    expect(history.load(chatId).exchanges[0]?.review?.id).toBe(result.review?.id);
    expect(vi.mocked(deps.callAI).mock.calls.every(([prompt]) => prompt.includes('UNTRUSTED_CONVERSATIONS_JSON'))).toBe(true);
  });

  it('keeps Approve for me selected across requests and applies only safe eligible conversations', async () => {
    service.updateChat({ chatId, pinned: true, actionMode: 'approve_for_me' });
    const first = await service.ask(request());
    expect(first.reviewResult?.appliedCount).toBe(2);
    expect(vi.mocked(deps.setRead!).mock.calls.flatMap(([, ids]) => ids).sort()).toEqual(['safe-a', 'safe-b']);
    expect(history.load(chatId)).toMatchObject({ actionMode: 'approve_for_me', pinned: true });
    rows.set('next-safe', newsletter('next-safe'));
    const second = await service.ask(request('prepare-2'));
    expect(second.reviewResult?.appliedCount).toBe(1);
    expect(rows.get('next-safe')!.tags).toContain('|read|');
    expect(deps.setRead).toHaveBeenCalledTimes(3);
  });

  it('prepares and refreshes review-only requests without delegated mail changes', async () => {
    service.updateChat({ chatId, actionMode: 'approve_for_me' });
    const first = await service.ask({ ...request(), reviewOnly: true });
    const refreshed = await service.ask({ ...request('refresh'), reviewOnly: true });
    expect(first.review?.items.some(item => item.recommendation === 'mark_read')).toBe(true);
    expect(first.reviewResult).toBeUndefined();
    expect(refreshed.reviewResult).toBeUndefined();
    expect(refreshed.review!.id).not.toBe(first.review!.id);
    expect(history.load(chatId).actionMode).toBe('approve_for_me');
    expect(deps.setRead).not.toHaveBeenCalled();
  });

  it('keeps continuation batches read-only when saved approval is delegated', async () => {
    service.updateChat({ chatId, actionMode: 'approve_for_me' });
    rows.clear();
    for (let index = 0; index < 205; index++) rows.set(`safe-${index}`, newsletter(`safe-${index}`));
    const first = await service.ask({ ...request(), reviewOnly: true });
    const next = await service.ask({ ...request('continue'), continueReviewId: first.review!.id, reviewOnly: true });
    expect(first.review!.items).toHaveLength(200);
    expect(next.review!.items).toHaveLength(5);
    expect(next.reviewResult).toBeUndefined();
    expect(deps.setRead).not.toHaveBeenCalled();
  });

  it('applies explicit manual selections and persists their undo receipt without broadening delegated approval', async () => {
    service.updateChat({ chatId, actionMode: 'approve_for_me' });
    const review = await service.ask({ ...request(), reviewOnly: true });
    const important = review.review!.items.find(item => item.emailId === 'important')!;
    expect(important).toMatchObject({ recommendation: 'keep_unread', manualSelectionAllowed: true });
    const action = applyRequest(review, { itemIds: [important.id], manualSelection: true });
    const applied = await service.applyReview(action);
    expect(applied.reviewResult?.appliedCount).toBe(1);
    expect(deps.setRead).toHaveBeenCalledExactlyOnceWith('primary', ['important'], true);
    expect(history.load(chatId).exchanges[0]?.review?.items.find(item => item.id === important.id)?.undoAvailable).toBe(true);
    await service.applyReview({ ...action, requestId: 'manual-undo', undo: true, manualSelection: undefined });
    expect(deps.setRead).toHaveBeenLastCalledWith('primary', ['important'], false);
    expect(history.load(chatId).actionMode).toBe('approve_for_me');
  });

  it('rejects malformed manual-selection and review-only flags at the host boundary', async () => {
    await expect(service.ask({ ...request(), reviewOnly: 'yes' })).rejects.toThrow('Enter a question');
    const exchange = await service.ask(request());
    await expect(service.applyReview({ ...applyRequest(exchange), manualSelection: 'yes' })).rejects.toThrow('Choose valid');
    await expect(service.applyReview(applyRequest(exchange, { manualSelection: true, undo: true }))).rejects.toThrow('Choose valid');
    expect(deps.setRead).not.toHaveBeenCalled();
  });

  it('keeps Approve for me persisted across subsequent explicit requests and never starts work merely from changing the setting', async () => {
    service.updateChat({ chatId, actionMode: 'approve_for_me' });
    expect(deps.setRead).not.toHaveBeenCalled();
    expect(deps.callAI).not.toHaveBeenCalled();
    await service.ask(request());
    rows.set('later-safe', newsletter('later-safe'));
    expect(rows.get('later-safe')!.tags).not.toContain('|read|');
    await service.ask(request('prepare-2'));
    expect(rows.get('later-safe')!.tags).toContain('|read|');
    expect(createInboxAssistantHistoryStore(() => db).load(chatId).actionMode).toBe('approve_for_me');
    expect(deps.setRead).toHaveBeenCalledTimes(3);
  });

  it('honors a switch to asking for approval while preparation is still running', async () => {
    service.updateChat({ chatId, actionMode: 'approve_for_me' });
    let started!: () => void; let release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    deps.callAI = vi.fn(async prompt => { started(); await gate; return recommendation(prompt); });
    const pending = service.ask(request());
    await ready;
    service.updateChat({ chatId, actionMode: 'review' }); release();
    const result = await pending;
    expect(result.reviewResult).toBeUndefined();
    expect(deps.setRead).not.toHaveBeenCalled();
    expect(history.load(chatId).actionMode).toBe('review');
  });

  it('stops remaining delegated mutations when approval is required while preserving the first acknowledged receipt', async () => {
    service.updateChat({ chatId, actionMode: 'approve_for_me' });
    const originalSetRead = deps.setRead!;
    let started!: () => void; let release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    deps.setRead = vi.fn(async (accountId: string, ids: string[], read: boolean) => {
      const receipt = await originalSetRead(accountId, ids, read);
      if (++calls === 1) { started(); await gate; }
      return receipt;
    });
    const pending = service.ask(request());
    await ready;
    service.updateChat({ chatId, actionMode: 'review' }); release();
    const result = await pending;
    expect(result.reviewResult).toMatchObject({ appliedCount: 1, skippedCount: 1 });
    expect(deps.setRead).toHaveBeenCalledTimes(1);
    expect(history.load(chatId)).toMatchObject({ actionMode: 'review', exchangeCount: 1 });
    expect(history.load(chatId).exchanges[0]?.reviewResult).toEqual(result.reviewResult);
  });

  it('routes an explicit uncategorized review and applies an approved review without the research answer path', async () => {
    const exchange = await service.ask({ ...request(), question: 'Show uncategorized conversations', reviewKind: 'uncategorized' });
    expect(exchange.review?.kind).toBe('uncategorized');
    const result = await service.applyReview(applyRequest(exchange));
    expect(result.reviewResult?.appliedCount).toBe(2);
    expect(history.load(chatId).exchanges[0]?.reviewResult).toEqual(result.reviewResult);
    const count = vi.mocked(deps.setRead!).mock.calls.length;
    await service.applyReview(applyRequest(exchange, { requestId: 'apply-again' }));
    expect(deps.setRead).toHaveBeenCalledTimes(count);
  });

  it('rejects wrong-chat, wrong-exchange and fabricated review tokens before changing mail', async () => {
    const exchange = await service.ask(request());
    const other = service.createChat();
    for (const overrides of [{ chatId: other.id }, { exchangeId: 'wrong-exchange' }, { reviewId: 'fabricated-review' }]) {
      await expect(service.applyReview(applyRequest(exchange, overrides))).rejects.toThrow(/expired|fresh review/);
    }
    await expect(service.applyReview(applyRequest(exchange, { itemIds: ['foreign-item'] }))).rejects.toThrow('Choose only items');
    expect(deps.setRead).not.toHaveBeenCalled();
  });

  it('rejects an expired review and preserves restored history as expired after an app restart', async () => {
    const exchange = await service.ask(request());
    const now = vi.spyOn(Date, 'now').mockReturnValue(exchange.review!.expiresAt + 1);
    await expect(service.applyReview(applyRequest(exchange))).rejects.toThrow('expired');
    now.mockRestore();
    const restarted = new InboxAssistantService({ ...deps, history: createInboxAssistantHistoryStore(() => db) });
    expect(restarted.chat(chatId).exchanges[0]?.review?.status).toBe('expired');
    await expect(restarted.applyReview(applyRequest(exchange))).rejects.toThrow('expired');
    expect(deps.setRead).not.toHaveBeenCalled();
  });

  it('rejects a disconnected review account without using another registered mailbox', async () => {
    const exchange = await service.ask(request());
    registered = [ACCOUNTS[1]!];
    await expect(service.applyReview(applyRequest(exchange))).rejects.toThrow('no longer connected');
    expect(deps.setRead).not.toHaveBeenCalled();
  });

  it('locks clear/delete during a mutation and retains acknowledged results in the origin chat after cancellation and navigation', async () => {
    const exchange = await service.ask(request());
    const originalSetRead = deps.setRead!;
    let started!: () => void; let release!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const firstReceipt = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    deps.setRead = vi.fn(async (accountId: string, ids: string[], read: boolean) => {
      const receipt = await originalSetRead(accountId, ids, read);
      if (++calls === 1) { started(); await firstReceipt; }
      return receipt;
    });
    const pending = service.applyReview(applyRequest(exchange));
    await firstStarted;
    expect(() => service.clearHistory()).toThrow('Wait for the current mail action');
    expect(() => service.deleteChat(chatId)).toThrow('Wait for the current mail action');
    await expect(service.ask(request('busy'))).rejects.toThrow('still running');
    const other = service.createChat();
    service.cancel('apply-1'); release();
    const result = await pending;
    expect(result.reviewResult).toMatchObject({ appliedCount: 1, skippedCount: 1 });
    expect(deps.setRead).toHaveBeenCalledTimes(1);
    expect(history.list().activeChatId).toBe(other.id);
    expect(history.load(other.id, { select: false }).exchanges).toEqual([]);
    expect(history.load(chatId, { select: false }).exchanges[0]?.reviewResult).toEqual(result.reviewResult);
    expect(history.load(chatId, { select: false }).exchanges).toHaveLength(1);
  });

  it('invalidates a prepared review when its origin conversation is cleared', async () => {
    const exchange = await service.ask(request());
    service.clearHistory();
    await expect(service.applyReview(applyRequest(exchange))).rejects.toThrow('expired');
    expect(history.load(chatId).exchanges).toEqual([]);
    expect(deps.setRead).not.toHaveBeenCalled();
  });

  it('rejects continuation tokens outside their held chat, review kind, account scope or lifetime', async () => {
    const first = await service.ask(request());
    const other = service.createChat();
    const continueRequest = { ...request('continue-1'), continueReviewId: first.review!.id };
    const openCalls = vi.mocked(deps.openMailbox).mock.calls.length;
    const aiCalls = vi.mocked(deps.callAI).mock.calls.length;
    for (const invalid of [
      { ...continueRequest, continueReviewId: 'unknown-review' },
      { ...continueRequest, chatId: other.id },
      { ...continueRequest, question: 'Review my uncategorized unread emails', reviewKind: 'uncategorized' },
      { ...continueRequest, accountIds: ['secondary'] },
      { ...continueRequest, accountIds: ['primary', 'secondary'] },
    ]) {
      await expect(service.ask(invalid)).rejects.toThrow('continuation expired or its account scope changed');
    }
    const now = vi.spyOn(Date, 'now').mockReturnValue(first.review!.expiresAt);
    await expect(service.ask(continueRequest)).rejects.toThrow('continuation expired');
    now.mockRestore();
    expect(deps.openMailbox).toHaveBeenCalledTimes(openCalls);
    expect(deps.callAI).toHaveBeenCalledTimes(aiCalls);
    expect(deps.setRead).not.toHaveBeenCalled();
    expect(history.load(chatId, { select: false }).exchanges).toHaveLength(1);
    expect(history.load(other.id, { select: false }).exchanges).toEqual([]);
    expect(history.list().activeChatId).toBe(other.id);
  });

  it('continues past 200 kept-unread conversations and retains prior exclusions in the next batch', async () => {
    rows.clear();
    for (let index = 0; index < 205; index++) {
      const row = newsletter(`kept-${index}`, { tags: '|INBOX|important|' });
      rows.set(row.id, row);
    }
    const first = await service.ask(request());
    expect(first.review?.items).toHaveLength(200);
    expect(first.review).toMatchObject({ truncated: true, coverage: [{ hasMore: true, reviewedThreads: 200 }] });
    expect(first.review?.items.every(item => item.recommendation === 'keep_unread')).toBe(true);
    const second = await service.ask({ ...request('continue-1'), continueReviewId: first.review!.id });
    expect(second.review?.items.map(item => item.emailId)).toEqual(['kept-200', 'kept-201', 'kept-202', 'kept-203', 'kept-204']);
    expect(second.review?.truncated).toBe(false);
    const previouslyReviewed = new Set(first.review!.items.map(item => item.threadId));
    expect(second.review?.items.some(item => previouslyReviewed.has(item.threadId))).toBe(false);
    const latest = newsletter('new-kept', { tags: '|INBOX|important|' });
    rows.set(latest.id, latest);
    const third = await service.ask({ ...request('continue-2'), continueReviewId: second.review!.id });
    expect(third.review?.items.map(item => item.emailId)).toEqual(['new-kept']);
    expect(history.load(chatId).exchanges.map(exchange => exchange.review?.items.length)).toEqual([200, 5, 1]);
    expect(deps.callAI).not.toHaveBeenCalled();
    expect(deps.setRead).not.toHaveBeenCalled();
    expect([...rows.values()].every(row => !row.tags.includes('|read|'))).toBe(true);
  });
});
