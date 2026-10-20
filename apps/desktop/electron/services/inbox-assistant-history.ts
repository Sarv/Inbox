import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { InboxAssistantActionMode, InboxAssistantChat, InboxAssistantChatList, InboxAssistantChatSummary, InboxAssistantExchange, InboxAssistantRunRecord } from '../../src/types/inbox-assistant';

import { getCoreDb } from './core-db';
import { aggregateInboxAssistantUsage } from './inbox-assistant-usage';

const LEGACY_KEY = 'inbox-assistant-history-v1';
const INDEX_KEY = 'inbox-assistant-chats-index-v2';
const CHAT_PREFIX = 'inbox-assistant-chat-v2:';
const REWIND_PREFIX = 'inbox-assistant-rewind-v1:';
const REWIND_AUDIT_PREFIX = 'inbox-assistant-rewind-audit-v1:';
const NEW_TITLE = 'New chat';
type HistoryDb = Pick<Database.Database, 'prepare' | 'transaction'>;
interface StoredSummary extends InboxAssistantChatSummary { customTitle?: boolean }
interface ChatIndex { version: 2; actionModeVersion?: 2; chats: StoredSummary[]; activeChatId: string | null }
interface RewindSnapshot { version: 1; chat: InboxAssistantChat }

export interface InboxAssistantRewindResult {
  chat: InboxAssistantChat;
  question: string;
  accountIds: string[];
}

export interface InboxAssistantHistoryStore {
  list(): InboxAssistantChatList;
  load(chatId: string, options?: { select?: boolean }): InboxAssistantChat;
  create(): InboxAssistantChat;
  rename(chatId: string, title: string): InboxAssistantChatSummary;
  update(chatId: string, changes: { pinned?: boolean; actionMode?: InboxAssistantActionMode }): InboxAssistantChatSummary;
  delete(chatId: string): InboxAssistantChatList;
  writeChat(chat: InboxAssistantChat): void;
  clear(chatId: string): InboxAssistantChat;
  /** Truncate before one question, retaining the complete prior branch for recovery. */
  rewind(chatId: string, exchangeId: string): InboxAssistantRewindResult;
  /** Restore the prior branch while retaining the current branch in its place. */
  restoreRewind(chatId: string): InboxAssistantChat;
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
    && (item.activities === undefined || Array.isArray(item.activities))
    && (item.status === undefined || ['pending', 'running', 'completed', 'stopped', 'failed'].includes(item.status))
    && (item.requestId === undefined || typeof item.requestId === 'string')
    && (item.updatedAt === undefined || Number.isFinite(item.updatedAt))
    && (item.error === undefined || typeof item.error === 'string'));
}

function validRuns(value: unknown): value is InboxAssistantRunRecord[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(item => item && typeof item.requestId === 'string'
    && typeof item.chatId === 'string' && ['question', 'draft', 'action'].includes(item.kind)
    && typeof item.question === 'string' && Array.isArray(item.accountIds) && item.accountIds.every((id: unknown) => typeof id === 'string')
    && ['pending', 'running', 'completed', 'stopped', 'failed'].includes(item.status)
    && Number.isFinite(item.startedAt) && Number.isFinite(item.updatedAt) && Array.isArray(item.activities)
    && (item.exchangeId === undefined || typeof item.exchangeId === 'string') && (item.error === undefined || typeof item.error === 'string')));
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
  const readRewind = (chatId: string): RewindSnapshot | undefined => {
    const snapshot = readBlob(`${REWIND_PREFIX}${chatId}`) as RewindSnapshot | undefined;
    if (snapshot === undefined) return undefined;
    if (!snapshot || snapshot.version !== 1 || !snapshot.chat || snapshot.chat.id !== chatId || !validExchanges(snapshot.chat.exchanges) || !validRuns(snapshot.chat.runs)) {
      throw new Error('This saved conversation recovery could not be read. Its stored data has been preserved.');
    }
    return snapshot;
  };
  const saveRewind = (chat: InboxAssistantChat): void => {
    const previous = readRewind(chat.id);
    if (previous?.chat.exchanges.some(exchange => exchange.reviewResult)) {
      // One visible recovery slot stays simple, while older action receipts must
      // survive another edit. Content addressing avoids duplicate audit copies.
      const fingerprint = createHash('sha256').update(JSON.stringify(previous)).digest('hex');
      writeBlob(`${REWIND_AUDIT_PREFIX}${chat.id}:${fingerprint}`, previous);
    }
    writeBlob(`${REWIND_PREFIX}${chat.id}`, { version: 1, chat } satisfies RewindSnapshot);
  };
  const index = (): ChatIndex => getDb().transaction(() => {
    const stored = readBlob(INDEX_KEY) as ChatIndex | undefined;
    if (stored !== undefined) {
      if (!stored || stored.version !== 2 || (stored.actionModeVersion !== undefined && stored.actionModeVersion !== 2)
        || !Array.isArray(stored.chats) || stored.chats.some(item =>
        !item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || typeof item.title !== 'string'
        || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt) || !Number.isInteger(item.exchangeCount)
        || item.exchangeCount < 0 || (item.pinned !== undefined && typeof item.pinned !== 'boolean')
        || (item.rewindAvailable !== undefined && typeof item.rewindAvailable !== 'boolean')
        || (item.actionMode !== undefined && !['review', 'approve_for_me', ...(stored.actionModeVersion === undefined ? ['auto'] : [])].includes(item.actionMode)))
        || (stored.activeChatId !== null && !stored.chats.some(chat => chat.id === stored.activeChatId))) {
        throw new Error('The saved Inbox Agent chat list could not be read. Its stored data has been preserved.');
      }
      if (stored.actionModeVersion === undefined) {
        for (const chat of stored.chats) {
          const legacyMode = chat.actionMode as string | undefined;
          // Earlier approve_for_me meant one request. Never turn that old
          // delegation into persistent approval without a fresh user choice.
          if (legacyMode === 'approve_for_me') chat.actionMode = 'review';
          else if (legacyMode === 'auto') chat.actionMode = 'approve_for_me';
        }
        stored.actionModeVersion = 2;
        writeBlob(INDEX_KEY, stored);
      }
      return stored;
    }
    const legacy = readBlob(LEGACY_KEY);
    if (legacy !== undefined && !validExchanges(legacy)) throw new Error('The previous Inbox Agent conversation could not be read. Its stored data has been preserved.');
    const initial: ChatIndex = { version: 2, actionModeVersion: 2, chats: [], activeChatId: null };
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
    if (!chat || chat.id !== chatId || !validExchanges(chat.exchanges) || !validRuns(chat.runs)) throw new Error('This saved Inbox Agent chat could not be read. Its stored data has been preserved.');
    return { ...publicSummary(summary), exchanges: chat.exchanges, ...(chat.runs ? { runs: chat.runs } : {}), ...(chat.usage ? { usage: chat.usage } : {}) };
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
      if (!changes || (changes.pinned === undefined && changes.actionMode === undefined) || !Object.keys(changes).every(key => ['pinned', 'actionMode'].includes(key))
        || (changes.pinned !== undefined && typeof changes.pinned !== 'boolean')
        || (changes.actionMode !== undefined && !['review', 'approve_for_me'].includes(changes.actionMode))) {
        throw new Error('Choose a valid conversation setting.');
      }
      return mutate(current => {
        const summary = current.chats.find(chat => chat.id === chatId);
        if (!summary) throw new Error('This Inbox Agent chat is no longer available.');
        if (changes.pinned !== undefined) summary.pinned = changes.pinned;
        if (changes.actionMode !== undefined) summary.actionMode = changes.actionMode;
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
        getDb().prepare('DELETE FROM core_blobs WHERE key = ?').run(`${REWIND_PREFIX}${chatId}`);
        const auditPrefix = `${REWIND_AUDIT_PREFIX}${chatId}:`;
        getDb().prepare('DELETE FROM core_blobs WHERE substr(key, 1, ?) = ?').run(auditPrefix.length, auditPrefix);
        writeBlob(INDEX_KEY, current);
        return { chats: summaries, activeChatId: current.activeChatId };
      });
    },
    writeChat(chat) {
      validateInboxAssistantChatId(chat.id);
      if (!validExchanges(chat.exchanges) || !validRuns(chat.runs)) throw new Error('Invalid Inbox Agent conversation.');
      mutate(current => {
        const summary = current.chats.find(item => item.id === chat.id);
        if (!summary) throw new Error('This Inbox Agent chat is no longer available.');
        if (!summary.customTitle && !summary.exchangeCount && chat.exchanges.length) summary.title = inboxAssistantChatTitle(chat.exchanges[0]!.question);
        summary.exchangeCount = chat.exchanges.length;
        summary.updatedAt = Math.max(Date.now(), summary.updatedAt + 1);
        const exchanges = chat.exchanges.map(exchange => ({ ...exchange, chatId: chat.id }));
        const prior = readChat(chat.id, current);
        const runs = chat.runs ?? prior.runs;
        if (runs?.some(run => run.chatId !== chat.id)) throw new Error('Invalid Inbox Agent run owner.');
        // The append-only spending ledger survives edits to conversation
        // branches. Only unique provider call IDs are summed; exchanged answer
        // copies of the same accounting are never charged again.
        const usageCalls = [...(prior.usage?.calls ?? []), ...(chat.usage?.calls ?? []), ...(runs ?? []).flatMap(run => run.usage?.calls ?? [])];
        const usage = usageCalls.length ? aggregateInboxAssistantUsage(usageCalls) : undefined;
        writeBlob(`${CHAT_PREFIX}${chat.id}`, { ...publicSummary(summary), exchanges, ...(runs ? { runs } : {}), ...(usage ? { usage } : {}) }); writeBlob(INDEX_KEY, current);
      });
    },
    clear(chatId) {
      return mutate(current => {
        const chat = readChat(chatId, current);
        const summary = current.chats.find(item => item.id === chatId)!;
        if (!summary.customTitle) summary.title = NEW_TITLE;
        summary.exchangeCount = 0; summary.updatedAt = Math.max(Date.now(), summary.updatedAt + 1);
        const cleared = { ...publicSummary(summary), exchanges: [], ...(chat.usage ? { usage: chat.usage } : {}) };
        writeBlob(`${CHAT_PREFIX}${chat.id}`, cleared); writeBlob(INDEX_KEY, current);
        return cleared;
      });
    },
    rewind(chatId, exchangeId) {
      validateInboxAssistantChatId(chatId);
      validateInboxAssistantChatId(exchangeId);
      return mutate(current => {
        const chat = readChat(chatId, current);
        const position = chat.exchanges.findIndex(exchange => exchange.id === exchangeId);
        if (position < 0) throw new Error('This message does not belong to the selected conversation.');
        const target = chat.exchanges[position]!;
        const summary = current.chats.find(item => item.id === chatId)!;
        // This lives in the same encrypted core database, outside the list index.
        // A rewind changes conversation context, never the real mail or receipts.
        saveRewind(chat);
        summary.exchangeCount = position;
        summary.rewindAvailable = true;
        summary.updatedAt = Math.max(Date.now(), summary.updatedAt + 1);
        const keptIds = new Set(chat.exchanges.slice(0, position).map(exchange => exchange.id));
        const rewound = { ...publicSummary(summary), exchanges: chat.exchanges.slice(0, position),
          ...(chat.runs ? { runs: chat.runs.filter(run => !run.exchangeId || keptIds.has(run.exchangeId)) } : {}), ...(chat.usage ? { usage: chat.usage } : {}) };
        writeBlob(`${CHAT_PREFIX}${chatId}`, rewound); writeBlob(INDEX_KEY, current);
        return { chat: rewound, question: target.question, accountIds: [...target.accountIds] };
      });
    },
    restoreRewind(chatId) {
      validateInboxAssistantChatId(chatId);
      return mutate(current => {
        const chat = readChat(chatId, current);
        const snapshot = readRewind(chatId);
        if (snapshot === undefined) throw new Error('There is no saved conversation to restore.');
        const summary = current.chats.find(item => item.id === chatId)!;
        // Swapping retains answers and mail-action audit receipts produced since
        // the rewind, so restoring an older branch cannot silently discard them.
        saveRewind(chat);
        summary.exchangeCount = snapshot.chat.exchanges.length;
        summary.rewindAvailable = true;
        summary.updatedAt = Math.max(Date.now(), summary.updatedAt + 1);
        const usageCalls = [...(chat.usage?.calls ?? []), ...(snapshot.chat.usage?.calls ?? [])];
        const restored = { ...publicSummary(summary), exchanges: snapshot.chat.exchanges, ...(snapshot.chat.runs ? { runs: snapshot.chat.runs } : {}),
          ...(usageCalls.length ? { usage: aggregateInboxAssistantUsage(usageCalls) } : {}) };
        writeBlob(`${CHAT_PREFIX}${chatId}`, restored); writeBlob(INDEX_KEY, current);
        return restored;
      });
    },
    read() { const current = index(); return current.activeChatId ? readChat(current.activeChatId, current).exchanges : []; },
    write(exchanges) { const current = index(); const chat = current.activeChatId ? readChat(current.activeChatId, current) : store.create(); store.writeChat({ ...chat, exchanges }); },
  };
  return store;
}

export const inboxAssistantHistory = createInboxAssistantHistoryStore(getCoreDb);
