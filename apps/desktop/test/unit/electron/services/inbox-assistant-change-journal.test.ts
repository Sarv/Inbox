import { describe, expect, it, vi } from 'vitest';

import { createInboxAgentChangeJournal } from '../../../../electron/services/inbox-assistant-change-journal';
import { applyChangeSet, INBOX_AGENT_CHANGE_LIMITS, stageChangeSet, type InboxAgentMailActions } from '../../../../electron/services/inbox-assistant-change-sets';
import { stageSettingChange } from '../../../../electron/services/inbox-assistant-setting-changes';
import { emailRecord } from '../../../helpers/email-fixtures';

// The change journal keeps open cards' Approve and Undo across a restart. A
// regression here is a card that loses its Undo on restart, a restored card
// whose rows no longer match what Undo acts on, an unreadable journal
// overwritten as if empty, or a save that blocks on a huge journal.

const T0 = 1_800_000_000_000;
const FOLDERS = [{ id: 'f-inbox', name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null, totalCount: 0, unreadCount: 0, subscribed: true, createdAt: 0, updatedAt: 0 }];
const ACCOUNTS = [{ id: 'a1', email: 'a1@example.test' }];

function memory() {
  return { text: null as string | null, read: vi.fn(function (this: { text: string | null }) { return this.text; }), write: vi.fn(function (this: { text: string | null }, value: string) { this.text = value; }) };
}

function set(status: 'pending' | 'applied' = 'pending') {
  const held = stageChangeSet({ label: 'C1', action: 'mark_read', nowMs: T0, targets: [{ accountId: 'a1', accountEmail: 'a1@example.test', email: emailRecord({ id: 'm1', folderId: 'f-inbox', tags: '|INBOX|' }), folders: FOLDERS }] });
  if (status === 'applied') { held.set.status = 'applied'; held.set.undoBy = T0 + INBOX_AGENT_CHANGE_LIMITS.undoMs; held.set.items[0]!.status = 'applied'; }
  return held;
}

function setting() {
  return stageSettingChange({ label: 'R1', kind: 'add_vip', accountId: 'a1', accountEmail: 'a1@example.test', summary: 'Make a@b.test a VIP', details: [],
    plan: { kind: 'add_vip', address: 'a@b.test', flags: { vip: true } }, linked: [set()], existingText: 'x', nowMs: T0 });
}

describe('the change journal', () => {
  // Breaks: a restored set's card rows and the rows Undo acts on drift apart, so Undo reports one thing and does another.
  it('restores change sets and setting changes with their rows linked as when staged', async () => {
    const store = memory();
    const journal = createInboxAgentChangeJournal(store);
    journal.save({ sets: [{ chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: set() }], settings: [{ chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: setting() }] }, T0);
    const loaded = journal.load(T0 + 1);
    expect(loaded.sets).toHaveLength(1);
    const held = loaded.sets[0]!.held;
    expect(held.busy).toBe(false);
    expect(held.set.items[0]).toBe(held.items.get('c1-1')!.item);
    expect(loaded.settings[0]!.held.plan).toEqual({ kind: 'add_vip', address: 'a@b.test', flags: { vip: true } });
    expect(loaded.settings[0]!.held.linked[0]!.set.items[0]).toBe(loaded.settings[0]!.held.linked[0]!.items.get('c1-1')!.item);
    // Applying the restored set acts on its own rows.
    const mail = { setRead: vi.fn(async () => ({ appliedIds: ['m1'], queuedIds: [], failedIds: [] })) } as unknown as InboxAgentMailActions;
    await applyChangeSet(held, { actions: mail, readEmail: async () => ({ tags: '|INBOX|', folderId: 'f-inbox' }), nowMs: T0 + 2 });
    expect(held.set.items[0]!.status).toBe('applied');
  });

  // Breaks: the journal grows with cards that can no longer do anything.
  it('keeps only what can still be approved or undone', () => {
    const store = memory();
    const journal = createInboxAgentChangeJournal(store);
    const stale = set();
    const cancelled = set();
    cancelled.set.status = 'cancelled';
    journal.save({ sets: [{ chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: stale }, { chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: set('applied') },
      { chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: cancelled }], settings: [] }, T0 + INBOX_AGENT_CHANGE_LIMITS.approveMs + 1);
    expect(JSON.parse(store.text!).sets).toHaveLength(1);
    // Past the Undo window too, nothing is loaded.
    expect(journal.load(T0 + INBOX_AGENT_CHANGE_LIMITS.undoMs + 1).sets).toEqual([]);
  });

  // Breaks: an unreadable journal is taken as empty, and the next save destroys every card's Undo.
  it('never writes over a journal it could not read', () => {
    const store = memory();
    store.text = 'saved';
    store.read.mockImplementationOnce(() => { throw new Error('locked'); });
    const journal = createInboxAgentChangeJournal(store);
    expect(journal.load(T0)).toEqual({ sets: [], settings: [] });
    journal.save({ sets: [{ chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: set() }], settings: [] }, T0);
    expect(store.write).not.toHaveBeenCalled();
    expect(store.text).toBe('saved');
  });

  // Breaks: a damaged or older journal crashes startup, or one bad entry loses all the others.
  it('starts without a journal that is missing, damaged or of another version, and skips only malformed entries', () => {
    const store = memory();
    const journal = createInboxAgentChangeJournal(store);
    expect(journal.load(T0)).toEqual({ sets: [], settings: [] });
    store.text = '{not json';
    expect(journal.load(T0)).toEqual({ sets: [], settings: [] });
    store.text = JSON.stringify({ version: 99, sets: [] });
    expect(journal.load(T0)).toEqual({ sets: [], settings: [] });
    journal.save({ sets: [{ chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: set() }], settings: [{ chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: setting() }] }, T0);
    const saved = JSON.parse(store.text!);
    saved.sets.push({ chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: { set: null } });
    saved.settings.push({ chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: { change: { id: 'x' } } });
    store.text = JSON.stringify(saved);
    const loaded = journal.load(T0 + 1);
    expect([loaded.sets.length, loaded.settings.length]).toEqual([1, 1]);
  });

  // Breaks: a huge journal is stringified anyway (a long synchronous stall, or a fatal V8 error), or a failed write throws into the caller.
  it('skips a save that is too large, and survives a store that refuses the write', () => {
    const store = memory();
    createInboxAgentChangeJournal(store, { maxChars: 100 }).save({ sets: [{ chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: set() }], settings: [] }, T0);
    expect(store.write).not.toHaveBeenCalled();
    store.write.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => createInboxAgentChangeJournal(store).save({ sets: [{ chatId: 'c', exchangeId: 'e', accounts: ACCOUNTS, held: set() }], settings: [] }, T0)).not.toThrow();
  });
});
