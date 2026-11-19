import { createLogger, stringifyBounded } from '@sarvinbox/core';

import type { InboxAssistantAccount } from '../../src/types/inbox-assistant';

import type { HeldChangeSet } from './inbox-assistant-change-sets';
import type { HeldSettingChange } from './inbox-assistant-setting-changes';

const logger = createLogger('inbox-agent-journal');

/**
 * The change journal: the agent's change sets and setting changes the user
 * can still act on (approve within its window, or undo), saved so a card keeps
 * its buttons across an app restart. It holds what Undo needs: each message's
 * state before and after, a filter's earlier version, a sender's earlier
 * flags. It lives in the encrypted core database, like the chats whose cards
 * it backs.
 *
 * An unreadable journal is not an empty one: if it cannot be read at startup,
 * nothing is written over it this session (the cards then show as expired,
 * as they did before the journal existed).
 */

export interface JournalEntry<T> { chatId: string; exchangeId: string; accounts: InboxAssistantAccount[]; held: T }

export interface InboxAgentJournalState {
  sets: Array<JournalEntry<HeldChangeSet>>;
  settings: Array<JournalEntry<HeldSettingChange>>;
}

/** Where the journal is kept. `read` throws when the store cannot be read; null means there is none. */
export interface InboxAgentJournalStore {
  read(): string | null;
  write(value: string): void;
}

/** The size the journal may reach before a save is skipped (a save is a synchronous main-thread write). */
const MAX_JOURNAL_CHARS = 16 * 1024 * 1024;
const VERSION = 1;

type SavedSet = Omit<HeldChangeSet, 'items' | 'busy'> & { items: Array<[string, unknown]> };
type SavedSetting = Omit<HeldSettingChange, 'linked' | 'busy'> & { linked: SavedSet[] };

function saveSet(held: HeldChangeSet): SavedSet {
  const { busy: _busy, items, ...rest } = held;
  return { ...rest, items: [...items] };
}

function loadSet(saved: SavedSet): HeldChangeSet {
  if (!saved?.set?.id || !Array.isArray(saved.items)) throw new Error('Malformed change set');
  const items = new Map(saved.items as Array<[string, HeldChangeSet['items'] extends Map<string, infer V> ? V : never]>);
  // The display rows and the held rows are one object, as when staged.
  saved.set.items = [...items.values()].map(entry => entry.item);
  return { ...saved, items, busy: false };
}

function saveSetting(held: HeldSettingChange): SavedSetting {
  const { busy: _busy, linked, ...rest } = held;
  return { ...rest, linked: linked.map(saveSet) };
}

function loadSetting(saved: SavedSetting): HeldSettingChange {
  if (!saved?.change?.id || !saved.plan || !Array.isArray(saved.linked)) throw new Error('Malformed setting change');
  return { ...saved, linked: saved.linked.map(loadSet), busy: false };
}

export interface InboxAgentChangeJournal {
  /** What was saved and can still be acted on at `nowMs`. Empty when there is none or it cannot be read. */
  load(nowMs: number): InboxAgentJournalState;
  save(state: InboxAgentJournalState, nowMs: number): void;
}

const actionable = (approveBy: number, undoBy: number, status: string, nowMs: number) =>
  (status === 'pending' || status === 'partial') && approveBy > nowMs || undoBy > nowMs;

export function createInboxAgentChangeJournal(store: InboxAgentJournalStore, options: { maxChars?: number } = {}): InboxAgentChangeJournal {
  let unreadable = false;
  return {
    load(nowMs) {
      let text: string | null;
      try { text = store.read(); }
      catch (error) {
        unreadable = true;
        logger.warn(`Change journal could not be read; it is left as it is this session (${(error as Error)?.name ?? 'Error'}).`);
        return { sets: [], settings: [] };
      }
      if (!text) return { sets: [], settings: [] };
      let parsed: { version?: number; sets?: Array<JournalEntry<SavedSet>>; settings?: Array<JournalEntry<SavedSetting>> };
      try { parsed = JSON.parse(text); }
      catch { logger.warn('Change journal is not valid; starting without it.'); return { sets: [], settings: [] }; }
      if (parsed?.version !== VERSION) return { sets: [], settings: [] };
      const state: InboxAgentJournalState = { sets: [], settings: [] };
      let dropped = 0;
      for (const entry of parsed.sets ?? []) {
        try {
          const held = loadSet(entry.held);
          if (actionable(held.set.approveBy, held.set.undoBy, held.set.status, nowMs)) state.sets.push({ ...entry, held });
        } catch { dropped++; }
      }
      for (const entry of parsed.settings ?? []) {
        try {
          const held = loadSetting(entry.held);
          if (actionable(held.change.approveBy, held.change.undoBy, held.change.status, nowMs)) state.settings.push({ ...entry, held });
        } catch { dropped++; }
      }
      if (dropped) logger.warn(`Change journal: ${dropped} malformed entries skipped.`);
      return state;
    },
    save(state, nowMs) {
      if (unreadable) return;
      const value = {
        version: VERSION,
        sets: state.sets.filter(entry => actionable(entry.held.set.approveBy, entry.held.set.undoBy, entry.held.set.status, nowMs))
          .map(entry => ({ ...entry, held: saveSet(entry.held) })),
        settings: state.settings.filter(entry => actionable(entry.held.change.approveBy, entry.held.change.undoBy, entry.held.change.status, nowMs))
          .map(entry => ({ ...entry, held: saveSetting(entry.held) })),
      };
      // Mail subjects and senders are in it: measure before stringifying.
      const text = stringifyBounded(value, options.maxChars ?? MAX_JOURNAL_CHARS);
      if (text === null) { logger.warn(`Change journal too large to save (${value.sets.length} sets, ${value.settings.length} settings); cards keep their buttons until restart only.`); return; }
      try { store.write(text); }
      catch (error) { logger.warn(`Change journal could not be saved (${(error as Error)?.name ?? 'Error'}).`); }
    },
  };
}
