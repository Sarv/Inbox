import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { InboxAssistantChat, InboxAssistantChatList, InboxAssistantChatSummary, InboxAssistantExchange } from '../../src/types/inbox-assistant';

import { getCoreDb } from './core-db';

const LEGACY_KEY = 'inbox-assistant-history-v1';
const INDEX_KEY = 'inbox-assistant-chats-index-v2';
const CHAT_PREFIX = 'inbox-assistant-chat-v2:';
const NEW_TITLE = 'New chat';
type HistoryDb = Pick<Database.Database, 'prepare' | 'transaction'>;
interface StoredSummary extends InboxAssistantChatSummary { customTitle?: boolean }
interface ChatIndex { version: 2; chats: StoredSummary[]; activeChatId: string | null }

export interface InboxAssistantHistoryStore {
  list(): InboxAssistantChatList;
  load(chatId: string, options?: { select?: boolean }): InboxAssistantChat;
  create(): InboxAssistantChat;
  rename(chatId: string, title: string): InboxAssistantChatSummary;
  update(chatId: string, changes: { pinned: boolean }): InboxAssistantChatSummary;
  delete(chatId: string): InboxAssistantChatList;
  writeChat(chat: InboxAssistantChat): void;
  clear(chatId: string): InboxAssistantChat;
  /** Compatibility bridge: only the selected chat, never every conversation. */
  read(): InboxAssistantExchange[];
  write(exchanges: InboxAssistantExchange[]): void;
}

export function validateInboxAssistantChatId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid Inbox Agent chat.');
  return value;
}

export function inboxAssistantChatTitle(question: string): string {
  const title = question.replace(/\s+/g, ' ').trim();
  return title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title || NEW_TITLE;
}

function validExchanges(value: unknown): value is InboxAssistantExchange[] {
  return Array.isArray(value) && value.every(item => item && typeof item.id === 'string' && typeof item.question === 'string'
    && Array.isArray(item.accountIds) && item.accountIds.every((id: unknown) => typeof id === 'string')
    && Number.isFinite(item.createdAt) && item.answer && typeof item.answer.text === 'string'
    && Array.isArray(item.answer.sources) && Array.isArray(item.answer.coverage) && Array.isArray(item.answer.warnings)
    && (item.activities === undefined || Array.isArray(item.activities)));
}

function publicSummary({ customTitle: _customTitle, ...summary }: StoredSummary): InboxAssistantChatSummary {
  return { ...summary, pinned: summary.pinned ?? false };
}

/** One encrypted blob per chat; the lightweight index never contains questions, answers or source excerpts. */
export function createInboxAssistantHistoryStore(getDb: () => HistoryDb): InboxAssistantHistoryStore {
  const readBlob = (key: string): unknown => {
    const row = getDb().prepare('SELECT data FROM core_blobs WHERE key = ?').get(key) as { data: Buffer } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(Buffer.from(row.data).toString('utf8')); }
    catch { throw new Error('A saved Inbox Agent chat could not be read. Its stored data has been preserved.'); }
  };
  const writeBlob = (key: string, value: unknown): void => {
    getDb().prepare(`INSERT INTO core_blobs (key, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .run(key, Buffer.from(JSON.stringify(value)), Date.now());
  };
  const index = (): ChatIndex => getDb().transaction(() => {
    const stored = readBlob(INDEX_KEY) as ChatIndex | undefined;
    if (stored !== undefined) {
      if (!stored || stored.version !== 2 || !Array.isArray(stored.chats) || stored.chats.some(item =>
        !item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || typeof item.title !== 'string'
        || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt) || !Number.isInteger(item.exchangeCount)
        || item.exchangeCount < 0 || (item.pinned !== undefined && typeof item.pinned !== 'boolean'))
        || (stored.activeChatId !== null && !stored.chats.some(chat => chat.id === stored.activeChatId))) {
        throw new Error('The saved Inbox Agent chat list could not be read. Its stored data has been preserved.');
      }
      return stored;
    }
    const legacy = readBlob(LEGACY_KEY);
    if (legacy !== undefined && !validExchanges(legacy)) throw new Error('The previous Inbox Agent conversation could not be read. Its stored data has been preserved.');
    const initial: ChatIndex = { version: 2, chats: [], activeChatId: null };
    getDb().transaction(() => {
      if (Array.isArray(legacy) && legacy.length) {
        const id = randomUUID();
        const exchanges = (legacy as InboxAssistantExchange[]).map(exchange => ({ ...exchange, chatId: id,
          ...(exchange.activities ? { activities: exchange.activities.map(activity => ({ ...activity, chatId: id })) } : {}) }));
        const createdAt = Math.min(...exchanges.map(exchange => exchange.createdAt));
        const updatedAt = Math.max(...exchanges.map(exchange => exchange.createdAt));
        const chat: InboxAssistantChat = { id, title: inboxAssistantChatTitle(exchanges[0]!.question), createdAt, updatedAt, exchangeCount: exchanges.length, pinned: false, exchanges };
        const { exchanges: _exchanges, ...summary } = chat;
        initial.chats.push(summary); initial.activeChatId = id;
        writeBlob(`${CHAT_PREFIX}${id}`, chat);
      }
      // The v1 blob is intentionally retained as a recoverable migration backup.
      writeBlob(INDEX_KEY, initial);
    })();
    return initial;
  })();
  const readChat = (chatId: string, current = index()): InboxAssistantChat => {
    validateInboxAssistantChatId(chatId);
    const summary = current.chats.find(chat => chat.id === chatId);
    if (!summary) throw new Error('This Inbox Agent chat is no longer available.');
    const chat = readBlob(`${CHAT_PREFIX}${chatId}`) as InboxAssistantChat | undefined;
    if (!chat || chat.id !== chatId || !validExchanges(chat.exchanges)) throw new Error('This saved Inbox Agent chat could not be read. Its stored data has been preserved.');
    return { ...publicSummary(summary), exchanges: chat.exchanges };
  };
  const mutate = <T>(run: (current: ChatIndex) => T): T => getDb().transaction(() => run(index()))();
  const store: InboxAssistantHistoryStore = {
    list() {
      const current = index();
      return { activeChatId: current.activeChatId,
        chats: current.chats.map(publicSummary).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt) };
    },
    load(chatId, options) {
      return mutate(current => {
        const chat = readChat(chatId, current);
        if (options?.select !== false && current.activeChatId !== chatId) { current.activeChatId = chatId; writeBlob(INDEX_KEY, current); }
        return chat;
      });
    },
    create() {
      return mutate(current => {
        const now = Date.now();
        const chat: InboxAssistantChat = { id: randomUUID(), title: NEW_TITLE, createdAt: now, updatedAt: now, exchangeCount: 0, pinned: false, exchanges: [] };
        const { exchanges: _exchanges, ...summary } = chat;
        writeBlob(`${CHAT_PREFIX}${chat.id}`, chat);
        current.chats.push(summary); current.activeChatId = chat.id;
        writeBlob(INDEX_KEY, current);
        return chat;
      });
    },
    rename(chatId, title) {
      validateInboxAssistantChatId(chatId);
      const normalized = title.replace(/\s+/g, ' ').trim();
      if (!normalized || normalized.length > 120) throw new Error('Chat names must contain 1 to 120 characters.');
      return mutate(current => {
        const chat = readChat(chatId, current);
        const summary = current.chats.find(item => item.id === chatId)!;
        summary.title = normalized; summary.customTitle = true;
        summary.updatedAt = Math.max(Date.now(), summary.updatedAt + 1);
        writeBlob(`${CHAT_PREFIX}${chatId}`, { ...chat, ...publicSummary(summary) }); writeBlob(INDEX_KEY, current);
        return publicSummary(summary);
      });
    },
    update(chatId, changes) {
      validateInboxAssistantChatId(chatId);
      if (!changes || !Object.keys(changes).every(key => key === 'pinned') || typeof changes.pinned !== 'boolean') {
        throw new Error('Choose whether to pin this chat.');
      }
      return mutate(current => {
        const summary = current.chats.find(chat => chat.id === chatId);
        if (!summary) throw new Error('This Inbox Agent chat is no longer available.');
        summary.pinned = changes.pinned;
        summary.updatedAt = Math.max(Date.now(), summary.updatedAt + 1);
        // Pin state is index metadata only. Never load or rewrite answers.
        writeBlob(INDEX_KEY, current);
        return publicSummary(summary);
      });
    },
    delete(chatId) {
      validateInboxAssistantChatId(chatId);
      return mutate(current => {
        if (!current.chats.some(chat => chat.id === chatId)) throw new Error('This Inbox Agent chat is no longer available.');
        current.chats = current.chats.filter(chat => chat.id !== chatId);
        const summaries = current.chats.map(publicSummary).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
        if (current.activeChatId === chatId) current.activeChatId = summaries[0]?.id ?? null;
        getDb().prepare('DELETE FROM core_blobs WHERE key = ?').run(`${CHAT_PREFIX}${chatId}`);
        writeBlob(INDEX_KEY, current);
        return { chats: summaries, activeChatId: current.activeChatId };
      });
    },
    writeChat(chat) {
      validateInboxAssistantChatId(chat.id);
      if (!validExchanges(chat.exchanges)) throw new Error('Invalid Inbox Agent conversation.');
      mutate(current => {
        const summary = current.chats.find(item => item.id === chat.id);
        if (!summary) throw new Error('This Inbox Agent chat is no longer available.');
        if (!summary.customTitle && !summary.exchangeCount && chat.exchanges.length) summary.title = inboxAssistantChatTitle(chat.exchanges[0]!.question);
        summary.exchangeCount = chat.exchanges.length;
        summary.updatedAt = Math.max(Date.now(), summary.updatedAt + 1);
        const exchanges = chat.exchanges.map(exchange => ({ ...exchange, chatId: chat.id }));
        writeBlob(`${CHAT_PREFIX}${chat.id}`, { ...publicSummary(summary), exchanges }); writeBlob(INDEX_KEY, current);
      });
    },
    clear(chatId) {
      return mutate(current => {
        const chat = readChat(chatId, current);
        const summary = current.chats.find(item => item.id === chatId)!;
        if (!summary.customTitle) summary.title = NEW_TITLE;
        summary.exchangeCount = 0; summary.updatedAt = Math.max(Date.now(), summary.updatedAt + 1);
        const cleared = { ...publicSummary(summary), exchanges: [] };
        writeBlob(`${CHAT_PREFIX}${chat.id}`, cleared); writeBlob(INDEX_KEY, current);
        return cleared;
      });
    },
    read() { const current = index(); return current.activeChatId ? readChat(current.activeChatId, current).exchanges : []; },
    write(exchanges) { const current = index(); const chat = current.activeChatId ? readChat(current.activeChatId, current) : store.create(); store.writeChat({ ...chat, exchanges }); },
  };
  return store;
}

export const inboxAssistantHistory = createInboxAssistantHistoryStore(getCoreDb);
