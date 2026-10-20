import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../electron/services/core-db', () => ({ getCoreDb: () => { throw new Error('Use the isolated test database.'); } }));

import { createInboxAssistantHistoryStore, type InboxAssistantHistoryStore } from '../../../../electron/services/inbox-assistant-history';
import { aggregateInboxAssistantUsage } from '../../../../electron/services/inbox-assistant-usage';
import type { InboxAssistantExchange, InboxAssistantRunRecord } from '../../../../src/types/inbox-assistant';

let db: Database.Database;
let store: InboxAssistantHistoryStore;
const LEGACY = 'inbox-assistant-history-v1';
const INDEX = 'inbox-assistant-chats-index-v2';
const CHAT = 'inbox-assistant-chat-v2:';
const REWIND = 'inbox-assistant-rewind-v1:';
const REWIND_AUDIT = 'inbox-assistant-rewind-audit-v1:';

function exchange(index = 0): InboxAssistantExchange {
  return { id: `exchange-${index}`, question: index === 0 ? 'What quote did I send to TCS?' : `What changed in revision ${index}?`,
    accountIds: ['work'], createdAt: 1_000 + index,
    answer: { text: `SENSITIVE ANSWER ${index} [S1]`, sources: [{ id: 'S1', kind: 'attachment', accountId: 'work', accountEmail: 'rc@example.test', emailId: `mail-${index}`, subject: 'TCS quotation', from: 'rc@example.test', to: ['buyer@tcs.example'], date: 1_791_600_000, folder: 'Sent', sent: true, filename: 'quote.pdf', location: 'page 1', excerpt: `PRIVATE SOURCE ${index}` }], coverage: [], warnings: [] },
    activities: [{ requestId: `request-${index}`, sequence: 1, at: 1_000 + index, stage: 'attachment', status: 'done', message: 'Read quote.pdf' }],
  };
}
function blob(key: string): string | undefined {
  const row = db.prepare('SELECT data FROM core_blobs WHERE key = ?').get(key) as { data: Buffer } | undefined;
  return row && Buffer.from(row.data).toString('utf8');
}
function seed(key: string, value: unknown): void {
  db.prepare('INSERT OR REPLACE INTO core_blobs(key, data, updated_at) VALUES (?, ?, 0)').run(key, Buffer.from(JSON.stringify(value)));
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE core_blobs(key TEXT PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL)');
  store = createInboxAssistantHistoryStore(() => db);
});
afterEach(() => { db.close(); });

describe('separate encrypted-store Inbox Agent chats', () => {
  it('persists in-flight questions and run records privately while background updates preserve selection', () => {
    const origin = store.create();
    const other = store.create();
    const pending: InboxAssistantExchange = { ...exchange(), answer: { text: '', sources: [], coverage: [], warnings: [] }, status: 'running', requestId: 'live-request', updatedAt: 10 };
    const run: InboxAssistantRunRecord = { requestId: 'live-request', chatId: origin.id, exchangeId: pending.id, kind: 'question', question: 'PRIVATE RUN QUESTION', accountIds: ['work'],
      status: 'running', startedAt: 1, updatedAt: 10, activities: [{ requestId: 'live-request', chatId: origin.id, sequence: 1, at: 10, stage: 'search', status: 'running', message: 'PRIVATE PROGRESS' }] };
    store.writeChat({ ...origin, exchanges: [pending], runs: [run] });
    const restarted = createInboxAssistantHistoryStore(() => db);
    expect(restarted.load(origin.id, { select: false })).toMatchObject({ exchanges: [{ status: 'running', requestId: 'live-request' }], runs: [run] });
    expect(restarted.list().activeChatId).toBe(other.id);
    expect(blob(INDEX)).not.toContain('PRIVATE RUN QUESTION');
    expect(blob(INDEX)).not.toContain('PRIVATE PROGRESS');
    expect(blob(INDEX)).not.toContain('live-request');
    // Legacy writes that update exchanges alone cannot drop durable run logs.
    restarted.writeChat({ ...origin, exchanges: [{ ...pending, status: 'stopped' }] });
    expect(restarted.load(origin.id, { select: false }).runs).toEqual([run]);
  });

  it('retains saved draft output and failed usage receipts across rewinds, restoration and restart', () => {
    const origin = store.create();
    const runs: InboxAssistantRunRecord[] = [{ requestId: 'draft-run', chatId: origin.id, kind: 'draft', question: 'Draft my reply', accountIds: ['work'], status: 'completed', startedAt: 1, updatedAt: 2, activities: [],
      draft: { chatId: origin.id, accountId: 'work', to: ['recipient@example.test'], cc: [], subject: 'Saved draft', body: 'PRIVATE DRAFT BODY' } },
    { requestId: 'failed-run', chatId: origin.id, exchangeId: 'exchange-1', kind: 'question', question: 'Failed question', accountIds: ['work'], status: 'failed', startedAt: 3, updatedAt: 4, activities: [], error: 'Provider unavailable' }];
    store.writeChat({ ...origin, exchanges: [exchange(), { ...exchange(1), status: 'failed', requestId: 'failed-run' }], runs });
    const rewound = store.rewind(origin.id, 'exchange-1');
    expect(rewound.chat.runs).toEqual([runs[0]]);
    expect(createInboxAssistantHistoryStore(() => db).restoreRewind(origin.id).runs).toEqual(runs);
    expect(blob(INDEX)).not.toContain('PRIVATE DRAFT BODY');
  });

  it('keeps one spending ledger across edited branches without summing duplicate exchanged receipts', () => {
    const origin = store.create();
    const makeRun = (id: string, exchangeId: string, inputTokens: number): InboxAssistantRunRecord => ({ requestId: id, chatId: origin.id, exchangeId, kind: 'question', question: 'Private billed request', accountIds: ['work'],
      status: 'completed', startedAt: 1, updatedAt: 2, activities: [], usage: aggregateInboxAssistantUsage([{ id: `call-${id}`, provider: 'fixture', model: 'fixture', status: 'completed', startedAt: 1, completedAt: 2, attempts: 1,
        inputTokens, outputTokens: 5, tokenSource: 'provider', usageComplete: true, estimatedCostUsd: inputTokens / 1000, costComplete: true }]) });
    const first = makeRun('first', 'exchange-0', 100);
    const second = makeRun('second', 'exchange-1', 50);
    store.writeChat({ ...origin, runs: [first, second], exchanges: [{ ...exchange(), usage: first.usage }, { ...exchange(1), usage: second.usage }] });
    expect(store.load(origin.id).usage).toMatchObject({ inputTokens: 150, outputTokens: 10 });
    expect(store.load(origin.id).usage?.estimatedCostUsd).toBeCloseTo(0.15);
    const rewound = store.rewind(origin.id, 'exchange-1').chat;
    expect(rewound.runs).toEqual([first]);
    expect(rewound.usage?.inputTokens).toBe(150);
    const third = makeRun('third', 'exchange-2', 75);
    store.writeChat({ ...rewound, exchanges: [...rewound.exchanges, { ...exchange(2), usage: third.usage }], runs: [...rewound.runs!, third] });
    expect(store.load(origin.id).usage).toMatchObject({ inputTokens: 225, outputTokens: 15 });
    expect(store.load(origin.id).usage?.estimatedCostUsd).toBeCloseTo(0.225);
    const restored = createInboxAssistantHistoryStore(() => db).restoreRewind(origin.id);
    expect(restored.runs).toEqual([first, second]);
    expect(restored.usage).toMatchObject({ inputTokens: 225, outputTokens: 15 });
    expect(restored.usage?.estimatedCostUsd).toBeCloseTo(0.225);
    expect(restored.usage?.calls.map(call => call.id)).toEqual(['call-first', 'call-second', 'call-third']);
    expect(store.restoreRewind(origin.id).usage?.inputTokens).toBe(225);
    expect(blob(INDEX)).not.toContain('call-first');
  });

  it('rejects malformed or foreign run records without replacing prior stored data', () => {
    const origin = store.create();
    const before = blob(`${CHAT}${origin.id}`);
    const run: InboxAssistantRunRecord = { requestId: 'run', chatId: 'foreign-chat', kind: 'action', question: 'Archive', accountIds: ['work'], status: 'completed', startedAt: 1, updatedAt: 2, activities: [] };
    expect(() => store.writeChat({ ...origin, runs: [run] })).toThrow('run owner');
    expect(blob(`${CHAT}${origin.id}`)).toBe(before);
    expect(() => store.writeChat({ ...origin, runs: [{ ...run, chatId: origin.id, status: 'invented' as never }] })).toThrow('Invalid');
    expect(blob(`${CHAT}${origin.id}`)).toBe(before);
  });

  it('migrates legacy persistent Auto and one-request approval safely without rewriting conversations or recovery data', () => {
    const ongoing = store.create(); store.writeChat({ ...ongoing, exchanges: [exchange()] });
    store.update(ongoing.id, { pinned: true }); store.rename(ongoing.id, 'Ongoing delegation');
    const oneRequest = store.create(); store.writeChat({ ...oneRequest, exchanges: [exchange(1), exchange(2)] });
    store.rewind(oneRequest.id, 'exchange-2');
    const review = store.create(); const unset = store.create();
    const legacy = JSON.parse(blob(INDEX)!);
    delete legacy.actionModeVersion;
    for (const item of legacy.chats) {
      if (item.id === ongoing.id) item.actionMode = 'auto';
      else if (item.id === oneRequest.id) item.actionMode = 'approve_for_me';
      else if (item.id === review.id) item.actionMode = 'review';
      else delete item.actionMode;
    }
    seed(INDEX, legacy);
    const recovery = JSON.parse(blob(`${REWIND}${oneRequest.id}`)!);
    recovery.chat.actionMode = 'approve_for_me'; seed(`${REWIND}${oneRequest.id}`, recovery);
    const originalBodies = new Map(legacy.chats.map((item: { id: string }) => [item.id, blob(`${CHAT}${item.id}`)]));
    const originalRecovery = blob(`${REWIND}${oneRequest.id}`);
    const restarted = createInboxAssistantHistoryStore(() => db);
    const listing = restarted.list();
    expect(listing.activeChatId).toBe(unset.id);
    expect(listing.chats.find(chat => chat.id === ongoing.id)).toMatchObject({ title: 'Ongoing delegation', actionMode: 'approve_for_me', pinned: true });
    expect(listing.chats.find(chat => chat.id === oneRequest.id)).toMatchObject({ actionMode: 'review', rewindAvailable: true });
    expect(listing.chats.find(chat => chat.id === review.id)?.actionMode).toBe('review');
    expect(listing.chats.find(chat => chat.id === unset.id)?.actionMode ?? 'review').toBe('review');
    const migrated = JSON.parse(blob(INDEX)!);
    expect(migrated.actionModeVersion).toBe(2);
    expect(migrated.chats.map((item: { id: string; updatedAt: number }) => [item.id, item.updatedAt]))
      .toEqual(legacy.chats.map((item: { id: string; updatedAt: number }) => [item.id, item.updatedAt]));
    for (const [id, before] of originalBodies) expect(blob(`${CHAT}${id}`)).toBe(before);
    expect(blob(`${REWIND}${oneRequest.id}`)).toBe(originalRecovery);
    const migratedIndex = blob(INDEX);
    const secondRestart = createInboxAssistantHistoryStore(() => db);
    expect(secondRestart.load(ongoing.id, { select: false }).actionMode).toBe('approve_for_me');
    expect(secondRestart.load(oneRequest.id, { select: false }).actionMode).toBe('review');
    expect(blob(INDEX)).toBe(migratedIndex);
    expect(secondRestart.restoreRewind(oneRequest.id)).toMatchObject({ actionMode: 'review', exchangeCount: 2 });
    expect(secondRestart.list().activeChatId).toBe(unset.id);
  });

  it.each(['list', 'load'] as const)('migrates an unversioned one-request approval to Ask for approval through %s', entry => {
    const chat = store.create(); store.writeChat({ ...chat, exchanges: [exchange()] });
    const legacy = JSON.parse(blob(INDEX)!);
    delete legacy.actionModeVersion; legacy.chats[0].actionMode = 'approve_for_me'; seed(INDEX, legacy);
    const restarted = createInboxAssistantHistoryStore(() => db);
    if (entry === 'list') expect(restarted.list().chats[0]?.actionMode).toBe('review');
    else expect(restarted.load(chat.id).actionMode).toBe('review');
    expect(JSON.parse(blob(INDEX)!)).toMatchObject({ actionModeVersion: 2, chats: [{ actionMode: 'review' }] });
    expect(restarted.load(chat.id).exchanges[0]?.answer).toEqual(exchange().answer);
  });

  it('creates the new action-mode marker immediately and does not reinterpret a fresh persistent approval on restart', () => {
    const chat = store.create();
    expect(JSON.parse(blob(INDEX)!).actionModeVersion).toBe(2);
    store.update(chat.id, { actionMode: 'approve_for_me' });
    store.writeChat({ ...chat, exchanges: [exchange()] });
    const restarted = createInboxAssistantHistoryStore(() => db);
    expect(restarted.load(chat.id).actionMode).toBe('approve_for_me');
    const current = restarted.load(chat.id);
    restarted.writeChat({ ...current, exchanges: [...current.exchanges, exchange(1)] });
    expect(createInboxAssistantHistoryStore(() => db).load(chat.id)).toMatchObject({ actionMode: 'approve_for_me', exchangeCount: 2 });
  });

  it('rolls back the complete mode migration if writing the private marker fails', () => {
    const chat = store.create();
    const legacy = JSON.parse(blob(INDEX)!);
    delete legacy.actionModeVersion; legacy.chats[0].actionMode = 'auto'; seed(INDEX, legacy);
    const before = blob(INDEX); const body = blob(`${CHAT}${chat.id}`);
    db.exec(`CREATE TRIGGER reject_mode_migration BEFORE UPDATE ON core_blobs WHEN NEW.key = '${INDEX}' BEGIN SELECT RAISE(ABORT, 'synthetic mode migration failure'); END`);
    expect(() => createInboxAssistantHistoryStore(() => db).list()).toThrow('synthetic mode migration failure');
    expect(blob(INDEX)).toBe(before); expect(blob(`${CHAT}${chat.id}`)).toBe(body);
    db.exec('DROP TRIGGER reject_mode_migration');
    expect(createInboxAssistantHistoryStore(() => db).list().chats[0]?.actionMode).toBe('approve_for_me');
    expect(JSON.parse(blob(INDEX)!).actionModeVersion).toBe(2);
  });

  it('rejects unsupported mode-version markers and Auto in a current index without silently broadening approval', () => {
    store.create();
    const valid = JSON.parse(blob(INDEX)!);
    for (const actionModeVersion of [1, 3, null, '2', true]) {
      seed(INDEX, { ...valid, actionModeVersion });
      const before = blob(INDEX);
      expect(() => createInboxAssistantHistoryStore(() => db).list()).toThrow('preserved');
      expect(blob(INDEX)).toBe(before);
    }
    const invalidCurrent = structuredClone(valid); invalidCurrent.chats[0].actionMode = 'auto';
    seed(INDEX, invalidCurrent);
    const before = blob(INDEX);
    expect(() => createInboxAssistantHistoryStore(() => db).list()).toThrow('preserved');
    expect(blob(INDEX)).toBe(before);
  });

  it('rewinds before the selected question and preserves its account scope, earlier turns and complete recovery receipts', () => {
    const first = store.create();
    const turns = [exchange(), { ...exchange(1), accountIds: ['sales', 'work'] }, { ...exchange(2),
      reviewResult: { reviewId: 'saved-review', items: [{ itemId: 'reviewed-item', accountId: 'work', threadId: 'reviewed-thread',
        status: 'queued' as const, appliedIds: [], queuedIds: ['changed-mail'], failedIds: [] }],
      appliedCount: 0, queuedCount: 1, failedCount: 0, skippedCount: 0 } }];
    store.writeChat({ ...first, exchanges: turns });
    store.rename(first.id, 'Retain this name');
    store.update(first.id, { pinned: true, actionMode: 'approve_for_me' });
    const other = store.create(); store.writeChat({ ...other, exchanges: [exchange(9)] });
    const otherBody = blob(`${CHAT}${other.id}`);
    const result = store.rewind(first.id, 'exchange-1');
    expect(result).toMatchObject({ question: turns[1]!.question, accountIds: ['sales', 'work'],
      chat: { id: first.id, title: 'Retain this name', pinned: true, actionMode: 'approve_for_me', rewindAvailable: true, exchangeCount: 1 } });
    expect(result.chat.exchanges.map(turn => turn.id)).toEqual(['exchange-0']);
    expect(result.chat.exchanges[0]?.answer).toEqual(turns[0]!.answer);
    expect(result.chat.exchanges[0]?.activities).toEqual(turns[0]!.activities);
    const recovery = JSON.parse(blob(`${REWIND}${first.id}`)!);
    expect(recovery.chat.exchanges.map((turn: InboxAssistantExchange) => turn.id)).toEqual(['exchange-0', 'exchange-1', 'exchange-2']);
    expect(recovery.chat.exchanges[2].reviewResult).toEqual(turns[2]!.reviewResult);
    expect(blob(INDEX)).not.toContain('SENSITIVE ANSWER');
    expect(blob(INDEX)).not.toContain('changed-mail');
    expect(blob(`${CHAT}${other.id}`)).toBe(otherBody);
    expect(store.list().activeChatId).toBe(other.id);
    expect(createInboxAssistantHistoryStore(() => db).load(first.id, { select: false }).exchanges).toHaveLength(1);
    expect(store.list().activeChatId).toBe(other.id);
  });

  it('rewinds the first question to an empty conversation while retaining its name and recovery', () => {
    const chat = store.create(); store.writeChat({ ...chat, exchanges: [exchange(), exchange(1)] });
    const before = store.load(chat.id);
    const result = store.rewind(chat.id, 'exchange-0');
    expect(result).toMatchObject({ question: before.exchanges[0]!.question, accountIds: ['work'],
      chat: { title: before.title, exchangeCount: 0, exchanges: [], rewindAvailable: true } });
    expect(store.list().chats[0]).toMatchObject({ title: before.title, exchangeCount: 0, rewindAvailable: true });
    expect(JSON.parse(blob(`${REWIND}${chat.id}`)!).chat.exchanges).toHaveLength(2);
  });

  it('restores after restart and swaps in the edited branch so newer answers and receipts stay recoverable', () => {
    const chat = store.create(); store.writeChat({ ...chat, exchanges: [exchange(), exchange(1), exchange(2)] });
    const rewound = store.rewind(chat.id, 'exchange-1');
    const edited = { ...exchange(4), reviewResult: { reviewId: 'new-review', items: [], appliedCount: 1, queuedCount: 0, failedCount: 0, skippedCount: 0 } };
    store.writeChat({ ...rewound.chat, exchanges: [...rewound.chat.exchanges, edited] });
    store.rename(chat.id, 'Current title'); store.update(chat.id, { pinned: true, actionMode: 'review' });
    const other = store.create();
    const restarted = createInboxAssistantHistoryStore(() => db);
    const restored = restarted.restoreRewind(chat.id);
    expect(restored).toMatchObject({ title: 'Current title', pinned: true, actionMode: 'review', rewindAvailable: true, exchangeCount: 3 });
    expect(restored.exchanges.map(turn => turn.id)).toEqual(['exchange-0', 'exchange-1', 'exchange-2']);
    expect(restarted.list().activeChatId).toBe(other.id);
    const editedRecovery = JSON.parse(blob(`${REWIND}${chat.id}`)!).chat;
    expect(editedRecovery.exchanges.map((turn: InboxAssistantExchange) => turn.id)).toEqual(['exchange-0', 'exchange-4']);
    expect(editedRecovery.exchanges[1].reviewResult).toEqual(edited.reviewResult);
    const swappedBack = createInboxAssistantHistoryStore(() => db).restoreRewind(chat.id);
    expect(swappedBack.exchanges.map(turn => turn.id)).toEqual(['exchange-0', 'exchange-4']);
    expect(swappedBack.exchanges[1]?.reviewResult).toEqual(edited.reviewResult);
  });

  it('keeps older action receipts in encrypted audit blobs when a later edit replaces the recovery slot', () => {
    const chat = store.create();
    const receipt = { reviewId: 'older-review', items: [{ itemId: 'older-item', accountId: 'work', threadId: 'older-thread',
      status: 'applied' as const, appliedIds: ['originally-changed-mail'], queuedIds: [], failedIds: [] }],
    appliedCount: 1, queuedCount: 0, failedCount: 0, skippedCount: 0 };
    store.writeChat({ ...chat, exchanges: [exchange(), { ...exchange(1), reviewResult: receipt }] });
    const first = store.rewind(chat.id, 'exchange-1');
    store.writeChat({ ...first.chat, exchanges: [...first.chat.exchanges, exchange(4)] });
    store.rewind(chat.id, 'exchange-4');
    const audit = db.prepare('SELECT data FROM core_blobs WHERE substr(key, 1, ?) = ?')
      .all(`${REWIND_AUDIT}${chat.id}:`.length, `${REWIND_AUDIT}${chat.id}:`) as Array<{ data: Buffer }>;
    expect(audit).toHaveLength(1);
    const saved = JSON.parse(Buffer.from(audit[0]!.data).toString('utf8'));
    expect(saved.chat.exchanges[1].reviewResult).toEqual(receipt);
    expect(blob(`${REWIND}${chat.id}`)).not.toContain('originally-changed-mail');
    expect(store.restoreRewind(chat.id).exchanges.map(turn => turn.id)).toEqual(['exchange-0', 'exchange-4']);
    expect(blob(INDEX)).not.toContain('originally-changed-mail');
    store.delete(chat.id);
    expect(db.prepare('SELECT key FROM core_blobs WHERE substr(key, 1, ?) = ?')
      .all(`${REWIND_AUDIT}${chat.id}:`.length, `${REWIND_AUDIT}${chat.id}:`)).toEqual([]);
  });

  it('rejects invalid, missing and cross-chat rewind targets without changing saved conversations', () => {
    const chat = store.create(); store.writeChat({ ...chat, exchanges: [exchange()] });
    const other = store.create(); store.writeChat({ ...other, exchanges: [exchange(1)] });
    const beforeIndex = blob(INDEX); const beforeBody = blob(`${CHAT}${chat.id}`);
    for (const [id, target] of [['../invalid', 'exchange-0'], ['missing-chat', 'exchange-0'], [chat.id, '../invalid'], [chat.id, 'missing'], [chat.id, 'exchange-1']]) {
      expect(() => store.rewind(id!, target!)).toThrow();
    }
    expect(() => store.restoreRewind(chat.id)).toThrow('no saved conversation');
    expect(() => store.restoreRewind('../invalid')).toThrow();
    expect(blob(INDEX)).toBe(beforeIndex);
    expect(blob(`${CHAT}${chat.id}`)).toBe(beforeBody);
    expect(blob(`${REWIND}${chat.id}`)).toBeUndefined();
  });

  it('rolls back both recovery and conversation if the rewind or restoration index update fails', () => {
    const chat = store.create(); store.writeChat({ ...chat, exchanges: [exchange(), exchange(1)] });
    const originalBody = blob(`${CHAT}${chat.id}`); const originalIndex = blob(INDEX);
    db.exec(`CREATE TRIGGER reject_rewind_index BEFORE UPDATE ON core_blobs WHEN NEW.key = '${INDEX}' BEGIN SELECT RAISE(ABORT, 'synthetic rewind failure'); END`);
    expect(() => store.rewind(chat.id, 'exchange-1')).toThrow('synthetic rewind failure');
    expect(blob(`${CHAT}${chat.id}`)).toBe(originalBody);
    expect(blob(INDEX)).toBe(originalIndex);
    expect(blob(`${REWIND}${chat.id}`)).toBeUndefined();
    db.exec('DROP TRIGGER reject_rewind_index');
    store.rewind(chat.id, 'exchange-1');
    const rewoundBody = blob(`${CHAT}${chat.id}`); const recovery = blob(`${REWIND}${chat.id}`); const rewoundIndex = blob(INDEX);
    db.exec(`CREATE TRIGGER reject_restore_index BEFORE UPDATE ON core_blobs WHEN NEW.key = '${INDEX}' BEGIN SELECT RAISE(ABORT, 'synthetic restore failure'); END`);
    expect(() => store.restoreRewind(chat.id)).toThrow('synthetic restore failure');
    expect(blob(`${CHAT}${chat.id}`)).toBe(rewoundBody);
    expect(blob(`${REWIND}${chat.id}`)).toBe(recovery);
    expect(blob(INDEX)).toBe(rewoundIndex);
  });

  it('preserves unreadable or incorrectly owned recovery data rather than restoring another conversation', () => {
    const chat = store.create(); store.writeChat({ ...chat, exchanges: [exchange(), exchange(1)] });
    store.rewind(chat.id, 'exchange-1');
    const beforeBody = blob(`${CHAT}${chat.id}`); const beforeIndex = blob(INDEX);
    for (const recovery of [{ version: 1, chat: { ...chat, id: 'other-chat', exchanges: [exchange()] } }, { version: 1, chat: { ...chat, exchanges: 'invalid' } }]) {
      seed(`${REWIND}${chat.id}`, recovery);
      const beforeRecovery = blob(`${REWIND}${chat.id}`);
      expect(() => store.restoreRewind(chat.id)).toThrow('preserved');
      expect(() => store.rewind(chat.id, 'exchange-0')).toThrow('preserved');
      expect(blob(`${REWIND}${chat.id}`)).toBe(beforeRecovery);
    }
    db.prepare('UPDATE core_blobs SET data = ? WHERE key = ?').run(Buffer.from('unreadable recovery'), `${REWIND}${chat.id}`);
    expect(() => store.restoreRewind(chat.id)).toThrow('preserved');
    expect(blob(`${REWIND}${chat.id}`)).toBe('unreadable recovery');
    expect(blob(`${CHAT}${chat.id}`)).toBe(beforeBody);
    expect(blob(INDEX)).toBe(beforeIndex);
  });

  it('deletes only the chosen chat recovery and leaves another chat recovery and legacy backup unchanged', () => {
    seed(LEGACY, [exchange()]);
    const first = store.load(store.list().activeChatId!); store.rewind(first.id, 'exchange-0');
    const second = store.create(); store.writeChat({ ...second, exchanges: [exchange(1)] }); store.rewind(second.id, 'exchange-1');
    const otherRecovery = blob(`${REWIND}${second.id}`); const legacy = blob(LEGACY);
    store.delete(first.id);
    expect(blob(`${REWIND}${first.id}`)).toBeUndefined();
    expect(blob(`${REWIND}${second.id}`)).toBe(otherRecovery);
    expect(blob(LEGACY)).toBe(legacy);
    expect(store.restoreRewind(second.id).exchanges[0]?.id).toBe('exchange-1');
  });

  it.each(['review', 'approve_for_me'] as const)('persists approval mode %s across restart without rewriting the conversation', actionMode => {
    const chat = store.create();
    store.writeChat({ ...chat, exchanges: [exchange()] });
    const before = blob(`${CHAT}${chat.id}`);
    expect(store.update(chat.id, { actionMode })).toMatchObject({ id: chat.id, actionMode, pinned: false, exchangeCount: 1 });
    expect(blob(`${CHAT}${chat.id}`)).toBe(before);
    const restarted = createInboxAssistantHistoryStore(() => db);
    expect(restarted.list().chats[0]).toMatchObject({ actionMode, pinned: false });
    expect(restarted.load(chat.id)).toMatchObject({ actionMode, exchanges: [expect.objectContaining({ id: 'exchange-0' })] });
    expect(restarted.load(chat.id).exchanges[0]?.answer).toEqual(exchange().answer);
    expect(JSON.parse(blob(INDEX)!).actionModeVersion).toBe(2);
  });

  it('updates pin and approval mode independently or together without losing either setting or changing the active chat', () => {
    const first = store.create(); const second = store.create();
    expect(store.update(first.id, { pinned: true, actionMode: 'approve_for_me' })).toMatchObject({ pinned: true, actionMode: 'approve_for_me' });
    expect(store.update(first.id, { pinned: false })).toMatchObject({ pinned: false, actionMode: 'approve_for_me' });
    expect(store.update(first.id, { actionMode: 'review' })).toMatchObject({ pinned: false, actionMode: 'review' });
    expect(store.list().activeChatId).toBe(second.id);
    expect(createInboxAssistantHistoryStore(() => db).load(first.id, { select: false })).toMatchObject({ pinned: false, actionMode: 'review' });
    expect(store.list().activeChatId).toBe(second.id);
  });

  it('changes approval mode using only metadata even when the saved chat body is unreadable', () => {
    const chat = store.create();
    db.prepare('UPDATE core_blobs SET data = ? WHERE key = ?').run(Buffer.from('unreadable preserved body'), `${CHAT}${chat.id}`);
    db.exec(`CREATE TRIGGER forbid_mode_body_update BEFORE UPDATE ON core_blobs WHEN NEW.key = '${CHAT}${chat.id}' BEGIN SELECT RAISE(ABORT, 'body must not be rewritten'); END`);
    expect(store.update(chat.id, { actionMode: 'approve_for_me', pinned: true })).toMatchObject({ actionMode: 'approve_for_me', pinned: true });
    expect(blob(`${CHAT}${chat.id}`)).toBe('unreadable preserved body');
    expect(createInboxAssistantHistoryStore(() => db).list().chats[0]).toMatchObject({ actionMode: 'approve_for_me', pinned: true });
  });

  it('preserves the latest approval mode across rename, stale answer completion, clear and reopening', () => {
    const chat = store.create();
    const stale = store.load(chat.id);
    store.update(chat.id, { actionMode: 'approve_for_me', pinned: true });
    store.rename(chat.id, 'Reviewed account tasks');
    store.writeChat({ ...stale, actionMode: 'review', exchanges: [exchange()] });
    expect(store.load(chat.id)).toMatchObject({ actionMode: 'approve_for_me', pinned: true, title: 'Reviewed account tasks', exchangeCount: 1 });
    expect(store.clear(chat.id)).toMatchObject({ actionMode: 'approve_for_me', pinned: true, title: 'Reviewed account tasks', exchangeCount: 0 });
    expect(createInboxAssistantHistoryStore(() => db).load(chat.id)).toMatchObject({ actionMode: 'approve_for_me', pinned: true, title: 'Reviewed account tasks', exchanges: [] });
  });

  it('keeps chats without an approval mode compatible with review behavior without rewriting their saved metadata', () => {
    const chat = store.create();
    store.writeChat({ ...chat, exchanges: [exchange()] });
    const old = JSON.parse(blob(INDEX)!);
    delete old.chats[0].actionMode;
    seed(INDEX, old);
    const beforeIndex = blob(INDEX);
    const beforeBody = blob(`${CHAT}${chat.id}`);
    const restarted = createInboxAssistantHistoryStore(() => db);
    expect(restarted.list().chats[0]?.actionMode ?? 'review').toBe('review');
    expect(restarted.load(chat.id).actionMode ?? 'review').toBe('review');
    expect(blob(INDEX)).toBe(beforeIndex);
    expect(blob(`${CHAT}${chat.id}`)).toBe(beforeBody);
    expect(restarted.load(chat.id).exchanges).toHaveLength(1);
  });

  it('rejects unknown or malformed approval settings without changing either chat or metadata', () => {
    const chat = store.create();
    store.update(chat.id, { pinned: true, actionMode: 'approve_for_me' });
    const beforeIndex = blob(INDEX); const beforeBody = blob(`${CHAT}${chat.id}`);
    const invalid: unknown[] = [
      {}, { actionMode: undefined }, { pinned: undefined }, { actionMode: 'approve' }, { actionMode: 'AUTO' }, { actionMode: 'auto' },
      { actionMode: '' }, { actionMode: null }, { actionMode: false }, { actionMode: 1 }, { actionMode: [] },
      { actionMode: {} }, { actionMode: 'auto', unknown: true }, { pinned: 'true', actionMode: 'review' },
    ];
    for (const changes of invalid) expect(() => store.update(chat.id, changes as Parameters<InboxAssistantHistoryStore['update']>[1])).toThrow();
    expect(blob(INDEX)).toBe(beforeIndex);
    expect(blob(`${CHAT}${chat.id}`)).toBe(beforeBody);
    expect(store.load(chat.id)).toMatchObject({ pinned: true, actionMode: 'approve_for_me' });
  });

  it('preserves a malformed stored approval mode rather than silently replacing it with another approval policy', () => {
    const chat = store.create();
    const valid = JSON.parse(blob(INDEX)!);
    for (const actionMode of ['approve', null, true, 1, {}, []]) {
      const invalid = structuredClone(valid); invalid.chats[0].actionMode = actionMode;
      seed(INDEX, invalid);
      const before = blob(INDEX);
      expect(() => createInboxAssistantHistoryStore(() => db).list()).toThrow('preserved');
      expect(blob(INDEX)).toBe(before);
      expect(blob(`${CHAT}${chat.id}`)).toBeDefined();
    }
  });

  it('persists pin state using only metadata while retaining every answer byte', () => {
    const chat = store.create(); store.writeChat({ ...chat, exchanges: [exchange()] });
    const before = blob(`${CHAT}${chat.id}`);
    expect(store.update(chat.id, { pinned: true })).toMatchObject({ id: chat.id, pinned: true, exchangeCount: 1 });
    expect(blob(`${CHAT}${chat.id}`)).toBe(before);
    const restarted = createInboxAssistantHistoryStore(() => db);
    expect(restarted.list().chats[0]?.pinned).toBe(true);
    expect(restarted.load(chat.id).pinned).toBe(true);
    expect(restarted.load(chat.id).exchanges[0]?.answer).toEqual(exchange().answer);
    expect(restarted.update(chat.id, { pinned: false }).pinned).toBe(false);
  });

  it('does not load or rewrite chat contents when pinning an unreadable conversation', () => {
    const chat = store.create();
    db.prepare('UPDATE core_blobs SET data = ? WHERE key = ?').run(Buffer.from('unreadable preserved body'), `${CHAT}${chat.id}`);
    db.exec(`CREATE TRIGGER forbid_chat_body_update BEFORE UPDATE ON core_blobs WHEN NEW.key = '${CHAT}${chat.id}' BEGIN SELECT RAISE(ABORT, 'body must not be rewritten'); END`);
    expect(store.update(chat.id, { pinned: true }).pinned).toBe(true);
    expect(blob(`${CHAT}${chat.id}`)).toBe('unreadable preserved body');
    expect(store.list().chats[0]?.pinned).toBe(true);
  });

  it('normalizes missing pin state from existing v2 indexes to false', () => {
    const chat = store.create();
    const old = JSON.parse(blob(INDEX)!);
    delete old.chats[0].pinned;
    seed(INDEX, old);
    expect(store.list().chats[0]?.pinned).toBe(false);
    expect(store.load(chat.id).pinned).toBe(false);
  });

  it('preserves pin state across renaming, stale answer completion and reopening', () => {
    const chat = store.create();
    const stale = store.load(chat.id);
    store.update(chat.id, { pinned: true });
    store.rename(chat.id, 'Pinned pricing');
    store.writeChat({ ...stale, exchanges: [exchange()] });
    expect(store.load(chat.id)).toMatchObject({ title: 'Pinned pricing', pinned: true, exchangeCount: 1 });
    expect(createInboxAssistantHistoryStore(() => db).list().chats[0]).toMatchObject({ title: 'Pinned pricing', pinned: true });
  });

  it('deletes only one chat body and its index entry while preserving other chat data and the legacy backup', () => {
    seed(LEGACY, [exchange()]);
    const migrated = store.list().chats[0]!;
    const other = store.create(); store.writeChat({ ...other, exchanges: [exchange(1)] });
    const keptBody = blob(`${CHAT}${other.id}`);
    const backup = blob(LEGACY);
    const result = store.delete(migrated.id);
    expect(result.chats.map(item => item.id)).toEqual([other.id]);
    expect(result.activeChatId).toBe(other.id);
    expect(blob(`${CHAT}${migrated.id}`)).toBeUndefined();
    expect(blob(`${CHAT}${other.id}`)).toBe(keptBody);
    expect(blob(LEGACY)).toBe(backup);
    expect(createInboxAssistantHistoryStore(() => db).list().chats).toHaveLength(1);
    expect(() => store.load(migrated.id)).toThrow('no longer available');
  });

  it('selects another chat only when the deleted chat was active and returns null after the last deletion', () => {
    const first = store.create(); const second = store.create(); const third = store.create();
    expect(store.delete(second.id).activeChatId).toBe(third.id);
    expect(store.delete(third.id).activeChatId).toBe(first.id);
    expect(store.delete(first.id)).toEqual({ chats: [], activeChatId: null });
    expect(store.list()).toEqual({ chats: [], activeChatId: null });
  });

  it('does not recreate a deleted migrated chat from the retained v1 backup after restart', () => {
    seed(LEGACY, [exchange()]);
    const chat = store.list().chats[0]!;
    store.delete(chat.id);
    expect(blob(LEGACY)).toContain('SENSITIVE ANSWER');
    expect(createInboxAssistantHistoryStore(() => db).list()).toEqual({ chats: [], activeChatId: null });
  });

  it('rolls back the deleted chat body if updating the index fails', () => {
    const chat = store.create(); store.writeChat({ ...chat, exchanges: [exchange()] });
    const before = blob(`${CHAT}${chat.id}`);
    db.exec(`CREATE TRIGGER reject_delete_index BEFORE UPDATE ON core_blobs WHEN NEW.key = '${INDEX}' BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END`);
    expect(() => store.delete(chat.id)).toThrow('synthetic delete failure');
    expect(blob(`${CHAT}${chat.id}`)).toBe(before);
    expect(store.list().chats[0]?.id).toBe(chat.id);
  });

  it('rejects invalid pin/delete requests without modifying other chats', () => {
    const chat = store.create();
    const before = blob(INDEX);
    expect(() => store.update('missing-chat', { pinned: true })).toThrow();
    expect(() => store.delete('missing-chat')).toThrow();
    expect(() => store.delete('../invalid')).toThrow();
    expect(blob(INDEX)).toBe(before);
    expect(store.load(chat.id).pinned).toBe(false);
  });

  it('starts with a lightweight empty chat list and creates a named conversation without destroying others', () => {
    expect(store.list()).toEqual({ chats: [], activeChatId: null });
    const first = store.create();
    store.writeChat({ ...first, exchanges: [exchange()] });
    const second = store.create();
    expect(second.title).toBe('New chat');
    expect(store.list().chats).toHaveLength(2);
    expect(store.load(first.id).exchanges).toHaveLength(1);
    expect(store.list().activeChatId).toBe(first.id);
  });

  it('keeps answers and source excerpts out of the lightweight index', () => {
    const chat = store.create();
    store.writeChat({ ...chat, exchanges: [exchange()] });
    expect(blob(INDEX)).not.toContain('SENSITIVE ANSWER');
    expect(blob(INDEX)).not.toContain('PRIVATE SOURCE');
    expect(blob(INDEX)).not.toContain('exchanges');
    expect(blob(`${CHAT}${chat.id}`)).toContain('SENSITIVE ANSWER');
    expect(store.list().chats[0]).not.toHaveProperty('exchanges');
  });

  it('loads only the selected chat, so an unreadable different chat cannot break the list or current conversation', () => {
    const first = store.create(); store.writeChat({ ...first, exchanges: [exchange()] });
    const second = store.create();
    db.prepare('UPDATE core_blobs SET data = ? WHERE key = ?').run(Buffer.from('not JSON'), `${CHAT}${second.id}`);
    expect(store.list().chats).toHaveLength(2);
    expect(store.load(first.id).exchanges[0]?.answer.text).toContain('SENSITIVE ANSWER');
    expect(() => store.load(second.id)).toThrow('preserved');
  });

  it('names a chat from its first question once and retains a manually chosen title across later answers', () => {
    const chat = store.create();
    store.writeChat({ ...chat, exchanges: [exchange()] });
    expect(store.load(chat.id).title).toBe('What quote did I send to TCS?');
    const stale = store.load(chat.id);
    store.rename(chat.id, '  TCS   pricing discussion  ');
    store.writeChat({ ...stale, exchanges: [...stale.exchanges, exchange(1)] });
    expect(store.load(chat.id).title).toBe('TCS pricing discussion');
    expect(store.load(chat.id).exchangeCount).toBe(2);
  });

  it('retains a custom name even when it was chosen before the first question', () => {
    const chat = store.create(); store.rename(chat.id, 'Important work');
    store.writeChat({ ...chat, exchanges: [exchange()] });
    expect(store.load(chat.id).title).toBe('Important work');
  });

  it('persists every conversation message beyond the provider context window', () => {
    const chat = store.create();
    const exchanges = Array.from({ length: 75 }, (_, index) => exchange(index));
    store.writeChat({ ...chat, exchanges });
    const restarted = createInboxAssistantHistoryStore(() => db);
    expect(restarted.load(chat.id).exchanges).toHaveLength(75);
    expect(restarted.load(chat.id).exchanges[0]?.id).toBe('exchange-0');
    expect(restarted.list().chats[0]?.exchangeCount).toBe(75);
  });

  it('does not change the selected chat when an earlier chat receives a late answer', () => {
    const first = store.create();
    const second = store.create();
    const origin = store.load(first.id, { select: false });
    store.writeChat({ ...origin, exchanges: [exchange()] });
    expect(store.list().activeChatId).toBe(second.id);
    expect(store.load(first.id, { select: false }).exchanges).toHaveLength(1);
    expect(store.list().activeChatId).toBe(second.id);
  });

  it('clears only the requested chat, preserving other messages and custom names', () => {
    const first = store.create(); store.writeChat({ ...first, exchanges: [exchange()] });
    const second = store.create(); store.writeChat({ ...second, exchanges: [exchange(1)] });
    store.rename(second.id, 'Keep this name');
    store.clear(second.id);
    expect(store.load(first.id).exchanges).toHaveLength(1);
    expect(store.load(second.id)).toMatchObject({ title: 'Keep this name', exchanges: [], exchangeCount: 0 });
  });

  it('migrates the original flat history once while preserving all citations, activities and the v1 backup', () => {
    const legacy = Array.from({ length: 25 }, (_, index) => exchange(index));
    seed(LEGACY, legacy);
    const before = blob(LEGACY);
    const listing = store.list();
    expect(listing.chats).toHaveLength(1);
    expect(listing.chats[0]).toMatchObject({ title: legacy[0]!.question, exchangeCount: 25, createdAt: 1_000, updatedAt: 1_024, pinned: false });
    const chat = store.load(listing.activeChatId!);
    expect(chat.exchanges).toHaveLength(25);
    expect(chat.exchanges[0]?.answer).toEqual(legacy[0]!.answer);
    expect(chat.exchanges[0]?.activities?.[0]).toMatchObject({ ...legacy[0]!.activities![0], chatId: chat.id });
    expect(blob(LEGACY)).toBe(before);
    const restarted = createInboxAssistantHistoryStore(() => db);
    expect(restarted.list().chats.map(item => item.id)).toEqual([chat.id]);
    expect(restarted.load(chat.id).exchanges).toHaveLength(25);
  });

  it('rolls back the complete migration on a write failure without damaging legacy history', () => {
    seed(LEGACY, [exchange()]);
    db.exec(`CREATE TRIGGER reject_chat_index BEFORE INSERT ON core_blobs WHEN NEW.key = '${INDEX}' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    expect(() => store.list()).toThrow('synthetic failure');
    expect(blob(LEGACY)).toContain('SENSITIVE ANSWER');
    expect(db.prepare('SELECT key FROM core_blobs WHERE key LIKE ?').all(`${CHAT}%`)).toEqual([]);
    expect(blob(INDEX)).toBeUndefined();
  });

  it('does not replace unreadable legacy or index data with an empty conversation', () => {
    seed(LEGACY, { invalid: 'preserve me' });
    expect(() => store.create()).toThrow('preserved');
    expect(blob(LEGACY)).toContain('preserve me');
    expect(blob(INDEX)).toBeUndefined();
    seed(INDEX, { invalid: 'preserve index' });
    expect(() => store.create()).toThrow('preserved');
    expect(blob(INDEX)).toContain('preserve index');
  });

  it('rejects invalid and unknown chat IDs and invalid names without changing saved conversations', () => {
    const chat = store.create();
    for (const id of ['', '../wrong', 'x'.repeat(101), 'unknown']) expect(() => store.load(id)).toThrow();
    for (const title of ['', '   ', 'x'.repeat(121)]) expect(() => store.rename(chat.id, title)).toThrow();
    expect(store.list().chats).toHaveLength(1);
    expect(store.list().chats[0]?.title).toBe('New chat');
  });
});
