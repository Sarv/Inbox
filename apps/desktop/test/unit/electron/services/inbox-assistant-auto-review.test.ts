import type { EmailRecord, SearchQuery } from '@sarvinbox/core';
import Sqlite from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../electron/services/core-db', () => ({ getCoreDb: () => { throw new Error('Use the isolated automatic-review test database.'); } }));

import { createInboxAssistantHistoryStore } from '../../../../electron/services/inbox-assistant-history';
import { InboxAssistantService, type InboxAssistantServiceDeps } from '../../../../electron/services/inbox-assistant-service';
import type { InboxAssistantActivity, InboxAssistantAIUsage, InboxAssistantExchange, InboxAssistantReviewActionRequest } from '../../../../src/types/inbox-assistant';
import { emailRecord } from '../../../helpers/email-fixtures';

const databases: Sqlite.Database[] = [];
const ACCOUNT = { id: 'primary', email: 'owner@company.example' };

function newsletter(id: string, protectedMail = false): EmailRecord {
  return emailRecord({ id, messageId: `<${id}@offers.example>`, threadId: `thread-${id}`, accountId: ACCOUNT.id,
    folderId: 'inbox', fromAddress: 'news@offers.example', toAddress: ACCOUNT.email, subject: `Newsletter ${id}`,
    date: 1_700_000_000, tags: protectedMail ? '|INBOX|important|' : '|INBOX|', hasBody: true,
    cleanBody: 'A public newsletter with seasonal offers. No response is requested.',
    rawBody: '<p>A public newsletter with seasonal offers. No response is requested.</p>' });
}

function recommendations(prompt: string): string {
  const prefix = 'UNTRUSTED_CONVERSATIONS_JSON: ';
  const line = prompt.split('\n').find(value => value.startsWith(prefix));
  if (!line) throw new Error('Expected the real read-only review prompt.');
  const items = JSON.parse(line.slice(prefix.length)) as Array<{ id: string }>;
  return JSON.stringify({ recommendations: items.map(item => ({ id: item.id, recommendation: 'mark_read',
    confidence: 0.99, reason: 'A synthetic unsolicited promotion without a requested response.' })) });
}

function fixture(records: EmailRecord[]) {
  const db = new Sqlite(':memory:');
  databases.push(db);
  db.exec('CREATE TABLE core_blobs(key TEXT PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL)');
  const history = createInboxAssistantHistoryStore(() => db);
  const chatId = history.create().id;
  const rows = new Map(records.map(row => [row.id, row]));
  let accounts = [{ ...ACCOUNT }];
  let provider = 'synthetic-provider-v1';
  const storage = {
    getFolders: vi.fn(async () => [{ id: 'inbox', path: 'INBOX', name: 'Inbox', specialUse: null }]),
    searchEmails: vi.fn(async (query: SearchQuery) => {
      const unread = [...rows.values()].filter(row => (query.isUnread === undefined || !row.tags.includes('|read|') === query.isUnread)
        && (!query.query || `${row.fromAddress} ${row.subject} ${row.rawBody}`.toLowerCase().includes(query.query.toLowerCase())));
      const threads = [...new Set(unread.map(row => row.threadId || row.id))];
      const chosen = new Set(threads.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 25)));
      return unread.filter(row => chosen.has(row.threadId || row.id));
    }),
    getEmail: vi.fn(async (id: string) => rows.get(id) ?? null),
    getEmailsByThread: vi.fn(async (id: string) => [...rows.values()].filter(row => row.threadId === id)),
    getContacts: vi.fn(async () => []), getAttachments: vi.fn(async () => []),
  };
  const deps: InboxAssistantServiceDeps = {
    accounts: () => accounts, history, reviewCacheIdentity: () => provider,
    openMailbox: vi.fn(async id => {
      if (id !== ACCOUNT.id) throw new Error('Wrong synthetic account owner.');
      return { storage: storage as never, aliases: [] };
    }),
    readAttachment: vi.fn(), callAI: vi.fn(async prompt => recommendations(prompt)),
    setRead: vi.fn(async (id, ids, read) => {
      if (id !== ACCOUNT.id) throw new Error('Wrong synthetic account owner.');
      for (const emailId of ids) {
        const row = rows.get(emailId)!;
        rows.set(emailId, { ...row, tags: read ? `${row.tags}read|` : row.tags.replace('|read|', '|') });
      }
      return { appliedIds: [...ids], queuedIds: [], failedIds: [] };
    }),
    moveMail: vi.fn(),
  };
  const service = new InboxAssistantService(deps);
  const prepare = (question = 'Review unread mail') => service.ask({ requestId: 'prepare-1', chatId, question, accountIds: [ACCOUNT.id] });
  const auto = (exchange: InboxAssistantExchange, changes: Partial<InboxAssistantReviewActionRequest> = {}, progress?: (value: InboxAssistantActivity) => void) =>
    service.applyReview({ requestId: 'auto-1', chatId, exchangeId: exchange.id, reviewId: exchange.review!.id,
      itemIds: [], autoContinue: true, ...changes }, progress);
  return { history, chatId, rows, storage, deps, service, prepare, auto,
    setAccounts: (value: typeof accounts) => { accounts = value; }, setProvider: (value: string) => { provider = value; } };
}

afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

describe('bounded automatic unread review', () => {
  it.each(['Review unread mail', 'Review uncategorized unread mail'])('advances through more than 400 protected conversations without AI or mail writes: %s', async question => {
    const f = fixture(Array.from({ length: 405 }, (_, index) => question.includes('uncategorized')
      ? { ...newsletter(`protected-${index}`), fromAddress: 'colleague@company.example' } : newsletter(`protected-${index}`, true)));
    const initial = await f.prepare(question);
    const report = vi.fn();
    const result = await f.auto(initial, {}, report);
    expect(result.review!.automation).toMatchObject({ status: 'completed', batchesReviewed: 3, reviewedConversations: 405,
      markedConversations: 0, markedEmails: 0, queuedEmails: 0 });
    const saved = f.history.load(f.chatId, { select: false });
    expect(saved.exchanges.map(exchange => exchange.review!.items.length)).toEqual([200, 200, 5]);
    expect(new Set(saved.exchanges.flatMap(exchange => exchange.review!.items.map(item => item.emailId))).size).toBe(405);
    expect(saved.exchanges[0]!.review!.automation).toEqual(result.review!.automation);
    expect(saved.runs!.at(-1)).toMatchObject({ requestId: 'auto-1', status: 'completed', kind: 'action' });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'auto-1', chatId: f.chatId, reviewAutomation: expect.objectContaining({ status: 'completed' }) }));
    expect(f.deps.callAI).not.toHaveBeenCalled();
    expect(f.deps.setRead).not.toHaveBeenCalled();
    expect(f.deps.moveMail).not.toHaveBeenCalled();
  });

  it('rescans changing unread lists from zero, retains kept conversations and saves separate undoable batch receipts', async () => {
    const records = Array.from({ length: 425 }, (_, index) => newsletter(`mail-${index}`, index % 17 !== 0));
    const f = fixture(records);
    const initial = await f.prepare();
    const result = await f.auto(initial);
    const expectedRead = records.filter((_, index) => index % 17 === 0).map(row => row.id);
    expect(result.review!.automation).toMatchObject({ status: 'completed', batchesReviewed: 3, reviewedConversations: 425,
      markedConversations: expectedRead.length, markedEmails: expectedRead.length });
    const saved = f.history.load(f.chatId, { select: false });
    expect(saved.exchanges.map(exchange => exchange.review!.items.length)).toEqual([200, 200, 25]);
    expect(new Set(saved.exchanges.flatMap(exchange => exchange.review!.items.map(item => item.emailId))).size).toBe(425);
    expect(saved.exchanges.every(exchange => exchange.reviewResult && exchange.reviewResult.failedCount === 0)).toBe(true);
    expect(saved.exchanges.flatMap(exchange => exchange.reviewResult!.items.flatMap(item => item.appliedIds)).sort()).toEqual(expectedRead.sort());
    expect([...f.rows.values()].filter(row => row.tags.includes('|read|')).map(row => row.id).sort()).toEqual(expectedRead);
    expect(f.deps.moveMail).not.toHaveBeenCalled();
    expect(vi.mocked(f.deps.callAI).mock.calls.every(([, , , options]) => options?.maxOutputTokens === 4_000)).toBe(true);
    const final = saved.exchanges.at(-1)!;
    const undoIds = final.review!.items.filter(item => item.undoAvailable).map(item => item.id);
    expect(undoIds.length).toBeGreaterThan(0);
    const undone = await f.service.applyReview({ requestId: 'undo-final', chatId: f.chatId, exchangeId: final.id,
      reviewId: final.review!.id, itemIds: undoIds, undo: true });
    expect(undone.reviewResult!.appliedCount).toBe(undoIds.length);
    expect(f.history.load(f.chatId).exchanges[0]!.reviewResult).toEqual(saved.exchanges[0]!.reviewResult);
  });

  it('saves an acknowledged write before Stop and does not touch the next selected conversation or start another batch', async () => {
    const f = fixture([newsletter('first'), newsletter('second'), ...Array.from({ length: 200 }, (_, index) => newsletter(`kept-${index}`, true))]);
    const initial = await f.prepare();
    const write = f.deps.setRead!;
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.deps.setRead = vi.fn(async (accountId, ids, read) => { started(); await gate; return write(accountId, ids, read); });
    const pending = f.auto(initial);
    await ready;
    const stopped = f.service.cancel('auto-1');
    release();
    const result = await pending;
    expect(await stopped).toEqual({ requestId: 'auto-1', cancelled: true });
    expect(result.review!.automation).toMatchObject({ status: 'stopped', batchesReviewed: 1, markedConversations: 1, markedEmails: 1,
      reason: expect.stringMatching(/^Stopped\./) });
    expect(result.reviewResult!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'applied', appliedIds: ['first'] }), expect.objectContaining({ status: 'skipped', appliedIds: [] }),
    ]));
    expect(f.rows.get('first')!.tags).toContain('|read|');
    expect(f.rows.get('second')!.tags).not.toContain('|read|');
    expect(f.deps.setRead).toHaveBeenCalledTimes(1);
    const saved = f.history.load(f.chatId);
    expect(saved.exchanges).toHaveLength(1);
    expect(saved.exchanges[0]!.reviewResult).toEqual(result.reviewResult);
    expect(saved.runs!.at(-1)).toMatchObject({ requestId: 'auto-1', status: 'stopped' });
  });

  it('acknowledges Stop while opening a never-settling next batch and ignores its late completion', async () => {
    const f = fixture(Array.from({ length: 201 }, (_, index) => newsletter(`kept-${index}`, true)));
    const initial = await f.prepare();
    const original = f.deps.openMailbox;
    let release!: (value: Awaited<ReturnType<typeof original>>) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.deps.openMailbox = vi.fn(async () => { started(); return new Promise<Awaited<ReturnType<typeof original>>>(resolve => { release = resolve; }); });
    const pending = f.auto(initial);
    await ready;
    expect(await f.service.cancel('auto-1')).toEqual({ requestId: 'auto-1', cancelled: true });
    expect((await pending).review!.automation).toMatchObject({ status: 'stopped', batchesReviewed: 1 });
    const before = f.history.load(f.chatId);
    release(await original(ACCOUNT.id));
    await new Promise(resolve => setImmediate(resolve));
    expect(f.history.load(f.chatId)).toEqual(before);
    expect(f.deps.setRead).not.toHaveBeenCalled();
    expect(f.deps.callAI).not.toHaveBeenCalled();
  });

  it('enforces the ten-minute run deadline while the next batch is waiting to open', async () => {
    const f = fixture(Array.from({ length: 201 }, (_, index) => newsletter(`kept-${index}`, true)));
    const initial = await f.prepare();
    const original = f.deps.openMailbox;
    let release!: (value: Awaited<ReturnType<typeof original>>) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.deps.openMailbox = vi.fn(async () => { started(); return new Promise<Awaited<ReturnType<typeof original>>>(resolve => { release = resolve; }); });
    vi.useFakeTimers();
    try {
      const pending = f.auto(initial);
      await ready;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect((await pending).review!.automation).toMatchObject({ status: 'failed', batchesReviewed: 1,
        reason: expect.stringMatching(/Mail action took too long/) });
      expect(f.history.load(f.chatId).runs!.at(-1)).toMatchObject({ requestId: 'auto-1', status: 'failed' });
      release(await original(ACCOUNT.id));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.deps.setRead).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(['removed-account', 'changed-account', 'provider'] as const)('stops before mutating newly reviewed mail when %s changes during classification', async change => {
    const f = fixture([newsletter('first'), ...Array.from({ length: 199 }, (_, index) => newsletter(`kept-${index}`, true)), newsletter('last')]);
    const initial = await f.prepare();
    f.deps.callAI = vi.fn(async prompt => {
      if (change === 'provider') f.setProvider('synthetic-provider-v2');
      else f.setAccounts(change === 'removed-account' ? [] : [{ ...ACCOUNT, email: 'replacement@company.example' }]);
      return recommendations(prompt);
    });
    const result = await f.auto(initial);
    expect(result.review!.automation).toMatchObject({ status: 'failed', batchesReviewed: 1, markedEmails: 1 });
    expect(result.review!.automation!.reason).toMatch(change === 'provider' ? /provider changed/i : /account.*changed/i);
    expect(f.rows.get('first')!.tags).toContain('|read|');
    expect(f.rows.get('last')!.tags).not.toContain('|read|');
    expect(f.deps.setRead).toHaveBeenCalledExactlyOnceWith(ACCOUNT.id, ['first'], true);
    expect(f.history.load(f.chatId).exchanges).toHaveLength(1);
  });

  it('stops at ten batches with protected mail still remaining and no AI calls', async () => {
    const f = fixture(Array.from({ length: 2_001 }, (_, index) => newsletter(`kept-${index}`, true)));
    const initial = await f.prepare();
    const result = await f.auto(initial);
    expect(result.review!.automation).toMatchObject({ status: 'stopped', batchesReviewed: 10, reviewedConversations: 2_000,
      markedEmails: 0, reason: expect.stringMatching(/10-batch limit/) });
    expect(f.history.load(f.chatId).exchanges).toHaveLength(10);
    expect(f.deps.callAI).not.toHaveBeenCalled();
    expect(f.deps.setRead).not.toHaveBeenCalled();
    const resumed = await f.auto(initial, { requestId: 'auto-resume' });
    expect(resumed.review!.automation).toMatchObject({ status: 'completed', batchesReviewed: 1, reviewedConversations: 1, markedEmails: 0 });
    const saved = f.history.load(f.chatId);
    expect(saved.exchanges).toHaveLength(11);
    expect(saved.exchanges.at(-1)!.review!.items.map(item => item.emailId)).toEqual(['kept-2000']);
    expect(new Set(saved.exchanges.flatMap(exchange => exchange.review!.items.map(item => item.emailId))).size).toBe(2_001);
    await expect(f.auto(initial, { requestId: 'auto-exhausted' })).rejects.toThrow('automatic review is complete');
    expect(f.history.load(f.chatId).runs).toHaveLength(3);
    expect(f.deps.callAI).not.toHaveBeenCalled();
    expect(f.deps.setRead).not.toHaveBeenCalled();
  });

  it.each(['calls', 'input characters'] as const)('stops at the automatic classification budget for %s while retaining completed receipts', async limit => {
    const records = Array.from({ length: limit === 'calls' ? 600 : 401 }, (_, index) => newsletter(`offer-${index}`));
    if (limit === 'input characters') {
      for (const row of records) {
        row.rawBody = `<p>${'A public newsletter discount. '.repeat(375)}</p>`;
        row.cleanBody = '';
      }
    }
    const f = fixture(records);
    const initial = await f.prepare();
    vi.mocked(f.deps.callAI).mockClear();
    const result = await f.auto(initial);
    const calls = vi.mocked(f.deps.callAI).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(20);
    expect(calls.reduce((sum, [prompt]) => sum + prompt.length, 0)).toBeLessThanOrEqual(500_000);
    if (limit === 'calls') expect(calls).toHaveLength(20);
    else expect(calls.length).toBeLessThan(20);
    expect(result.review!.automation).toMatchObject({ status: 'stopped', reason: expect.stringMatching(/AI budget/),
      maxAICalls: 20 });
    expect(result.review!.automation!.markedEmails).toBeGreaterThan(200);
    expect([...f.rows.values()].some(row => !row.tags.includes('|read|'))).toBe(true);
    const saved = f.history.load(f.chatId);
    expect(saved.exchanges.every(exchange => exchange.reviewResult && exchange.reviewResult.failedCount === 0)).toBe(true);
    expect(saved.exchanges.flatMap(exchange => exchange.reviewResult!.items.flatMap(item => item.appliedIds))).toHaveLength(result.review!.automation!.markedEmails);
    if (limit === 'calls') {
      const unread = [...f.rows.values()].filter(row => !row.tags.includes('|read|')).map(row => row.id).sort();
      expect(unread.length).toBeGreaterThan(0);
      const resumed = await f.auto(initial, { requestId: 'auto-resume' });
      expect(resumed.review!.automation).toMatchObject({ status: 'completed', batchesReviewed: 1, reviewedConversations: unread.length,
        markedConversations: unread.length, markedEmails: unread.length });
      const final = f.history.load(f.chatId);
      expect(final.exchanges.at(-1)!.review!.items.map(item => item.emailId).sort()).toEqual(unread);
      expect([...f.rows.values()].every(row => row.tags.includes('|read|'))).toBe(true);
      expect(final.exchanges.slice(0, saved.exchanges.length).map(exchange => exchange.reviewResult)).toEqual(saved.exchanges.map(exchange => exchange.reviewResult));
    }
  });

  it('retains provider usage on both the original review and automatic action ledger with the smaller output allowance', async () => {
    const f = fixture([newsletter('first'), ...Array.from({ length: 199 }, (_, index) => newsletter(`kept-${index}`, true)), newsletter('last')]);
    let sequence = 0;
    f.deps.callAI = vi.fn(async (prompt, _signal, onUsage) => {
      const usage: InboxAssistantAIUsage = { id: `synthetic-call-${++sequence}`, provider: 'fixture', model: 'fixture', status: 'completed',
        startedAt: 1, completedAt: 2, attempts: 1, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0,
        tokenSource: 'provider', usageComplete: true, estimatedCostUsd: 0.001, costComplete: true };
      onUsage?.(usage);
      return recommendations(prompt);
    });
    const initial = await f.prepare();
    expect(initial.usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    await f.auto(initial);
    const saved = f.history.load(f.chatId);
    expect(saved.usage).toMatchObject({ inputTokens: 200, outputTokens: 20, estimatedCostUsd: 0.002, tokenCountsComplete: true, costComplete: true });
    expect(saved.usage!.calls.map(call => call.id)).toEqual(['synthetic-call-1', 'synthetic-call-2']);
    expect(saved.runs!.at(-1)!.usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(vi.mocked(f.deps.callAI).mock.calls.every(([, , , options]) => options?.maxOutputTokens === 4_000)).toBe(true);
  });

  it('keeps queued-for-sync counts distinct from applied mail while saving the queue receipt', async () => {
    const f = fixture([newsletter('queued')]);
    const initial = await f.prepare();
    const write = f.deps.setRead!;
    f.deps.setRead = vi.fn(async (accountId, ids, read) => {
      await write(accountId, ids, read);
      return { appliedIds: [], queuedIds: [...ids], failedIds: [] };
    });
    const result = await f.auto(initial);
    expect(result.review!.automation).toMatchObject({ status: 'completed', markedConversations: 0, markedEmails: 0, queuedEmails: 1 });
    expect(result.reviewResult).toMatchObject({ queuedCount: 1, appliedCount: 0, items: [expect.objectContaining({ status: 'queued', queuedIds: ['queued'], appliedIds: [] })] });
    expect(f.history.load(f.chatId).exchanges[0]!.reviewResult).toEqual(result.reviewResult);
    expect(result.review!.items[0]).toMatchObject({ status: 'queued', undoAvailable: true });
  });

  it('stops on an empty bounded scan instead of looping over unavailable source rows', async () => {
    const f = fixture(Array.from({ length: 201 }, (_, index) => newsletter(`kept-${index}`, true)));
    const initial = await f.prepare();
    const missing = Array.from({ length: 2_001 }, (_, index) => newsletter(`unavailable-${index}`, true));
    f.storage.searchEmails.mockImplementation(async query => missing.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 25)));
    const result = await f.auto(initial);
    expect(result.review!.automation).toMatchObject({ status: 'stopped', batchesReviewed: 2, reviewedConversations: 200,
      reason: expect.stringMatching(/No new conversations/) });
    expect(f.history.load(f.chatId).exchanges.map(exchange => exchange.review!.items.length)).toEqual([200, 0]);
    expect(f.deps.callAI).not.toHaveBeenCalled();
    expect(f.deps.setRead).not.toHaveBeenCalled();
  });

  it.each([
    { itemIds: ['renderer-picked-id'] }, { manualSelection: true }, { action: 'trash' as const, manualSelection: true },
    { action: 'archive' as const, manualSelection: true }, { action: 'mark_read' as const }, { undo: true },
  ])('rejects automatic runs with a widened renderer selection or a different action: %j', async changes => {
    const f = fixture([newsletter('safe')]);
    const initial = await f.prepare();
    await expect(f.auto(initial, changes)).rejects.toThrow('Choose valid reviewed conversations');
    expect(f.deps.setRead).not.toHaveBeenCalled();
    expect(f.deps.moveMail).not.toHaveBeenCalled();
    expect(f.history.load(f.chatId).runs).toHaveLength(1);
  });

  it('rejects automatic continuation of a scoped read-flag command', async () => {
    const f = fixture([newsletter('safe')]);
    const initial = await f.prepare('Mark all newsletter emails read');
    await expect(f.auto(initial)).rejects.toThrow('unread and uncategorized mail only');
    expect(f.deps.setRead).not.toHaveBeenCalled();
    expect(f.deps.callAI).not.toHaveBeenCalled();
  });

  it('rechecks the source snapshot and stops without changing a conversation edited since review', async () => {
    const f = fixture([newsletter('changed'), ...Array.from({ length: 200 }, (_, index) => newsletter(`kept-${index}`, true))]);
    const initial = await f.prepare();
    const changed = f.rows.get('changed')!;
    f.rows.set(changed.id, { ...changed, rawBody: '<p>A new message requests a response.</p>' });
    const result = await f.auto(initial);
    expect(result.review!.automation).toMatchObject({ status: 'stopped', batchesReviewed: 1, markedEmails: 0,
      reason: expect.stringMatching(/changed|could not be updated/) });
    expect(result.reviewResult).toMatchObject({ appliedCount: 0, skippedCount: 1 });
    expect(f.rows.get('changed')!.tags).not.toContain('|read|');
    expect(f.deps.setRead).not.toHaveBeenCalled();
    expect(f.history.load(f.chatId).exchanges).toHaveLength(1);
  });

  it('freshly classifies an initially failed batch on retry instead of silently excluding its old failed snapshot', async () => {
    const f = fixture([newsletter('changed')]);
    const initial = await f.prepare();
    const changed = f.rows.get('changed')!;
    f.rows.set(changed.id, { ...changed, rawBody: '<p>A refreshed public sale newsletter with no response requested.</p>' });
    const stopped = await f.auto(initial);
    expect(stopped.review!.automation).toMatchObject({ status: 'stopped', markedEmails: 0 });
    expect(f.deps.setRead).not.toHaveBeenCalled();
    expect(f.deps.callAI).toHaveBeenCalledTimes(1);
    const resumed = await f.auto(initial, { requestId: 'auto-retry' });
    expect(resumed.review!.automation).toMatchObject({ status: 'completed', batchesReviewed: 1, reviewedConversations: 1, markedEmails: 1 });
    expect(f.deps.callAI).toHaveBeenCalledTimes(2);
    expect(f.deps.setRead).toHaveBeenCalledExactlyOnceWith(ACCOUNT.id, ['changed'], true);
    const saved = f.history.load(f.chatId);
    expect(saved.exchanges).toHaveLength(2);
    expect(saved.exchanges[0]!.reviewResult).toEqual(stopped.reviewResult);
    expect(saved.exchanges[1]!.reviewResult).toMatchObject({ appliedCount: 1 });
    expect(saved.exchanges[1]!.review!.id).not.toBe(initial.review!.id);
  });
});
