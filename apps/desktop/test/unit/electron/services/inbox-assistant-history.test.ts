import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../electron/services/core-db', () => ({ getCoreDb: () => { throw new Error('Use the isolated test database.'); } }));

import { createInboxAssistantHistoryStore, type InboxAssistantHistoryStore } from '../../../../electron/services/inbox-assistant-history';
import type { InboxAssistantExchange } from '../../../../src/types/inbox-assistant';

let db: Database.Database;
let store: InboxAssistantHistoryStore;
const LEGACY = 'inbox-assistant-history-v1';
const INDEX = 'inbox-assistant-chats-index-v2';
const CHAT = 'inbox-assistant-chat-v2:';

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
