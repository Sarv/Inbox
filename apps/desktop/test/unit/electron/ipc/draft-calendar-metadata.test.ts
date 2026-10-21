import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  sender: { mainFrame: {} as object, send: vi.fn() },
  accounts: new Map<string, any>(), append: vi.fn(async (_path: string, _body: Buffer, _flags: string[]) => 77), connected: false,
}));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => Promise<any>) => h.handlers.set(name, fn) } }));
vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => ({ webContents: h.sender }), getCurrentAccountId: () => 'account-a', getAllAccountIds: () => [...h.accounts.keys()],
  requireStorage: () => { throw new Error('No implicit profile access'); }, sendToWindow: vi.fn(),
}));
vi.mock('../../../../electron/services/account-target', () => ({
  requireTargetAccountId: (id = 'account-a') => { if (!h.accounts.has(id)) throw new Error('Account unavailable'); return id; },
  requireAccountStorage: async (id: string) => { if (!h.accounts.has(id)) throw new Error('Account unavailable'); return h.accounts.get(id); },
  resolveNamedOrActiveAccountTarget: async (id: string) => { if (!h.accounts.has(id)) throw new Error('Account unavailable'); return { storage: h.accounts.get(id), syncEngine: { isConnected: () => h.connected, getClient: () => ({ appendMessage: h.append }) } }; },
  resolveAccountTarget: async (id = 'account-a') => ({ storage: h.accounts.get(id), accountId: id, syncEngine: { isConnected: () => h.connected, getClient: () => ({ appendMessage: h.append }) } }),
}));
vi.mock('../../../../electron/services/attachment-cache', () => ({ seedAttachmentCache: vi.fn() }));
vi.mock('../../../../electron/services/read-model-poke', () => ({ pokeReadModel: vi.fn() }));
vi.mock('../../../../electron/services/pgp-outgoing', () => ({ encryptDraftMime: vi.fn() }));
vi.mock('../../../../electron/services/pgp-service', () => ({ getPgpKeyring: vi.fn() }));

import { newMigratedDb, openTestDb } from '../../../../../../packages/storage-node/src/test-support/test-db';
import { registerDraftHandlers, saveDraftToIMAP } from '../../../../electron/ipc/draft-handlers';
import { deleteDraftCalendarAvailability, readDraftCalendarAvailability, saveDraftCalendarAvailability, validateDraftCalendarAvailability } from '../../../../electron/services/draft-calendar-metadata';
import type { LocalCalendarAvailability } from '../../../../src/types/local-calendar';

const startMs = Date.parse('2026-10-22T09:00:00Z');
const proposal = (): LocalCalendarAvailability => ({ startMs, endMs: startMs + 3_600_000, checkedAt: startMs - 86_400_000, durationMinutes: 30, timeZone: 'UTC',
  scope: 'local-only', status: 'ready', calendarIds: ['private-calendar-id'], calendarNames: ['Private calendar name'],
  slots: [{ startMs, endMs: startMs + 1_800_000, label: 'Thu, 22 Oct 2026, 09:00 UTC – 09:30' }] });
const trusted = () => ({ sender: h.sender, senderFrame: h.sender.mainFrame });
const owned: Database.Database[] = [];
const directories: string[] = [];
const keep = (db: Database.Database) => { owned.push(db); return db; };
const createMailbox = () => {
  const db = keep(newMigratedDb());
  db.prepare('INSERT INTO folders(id, name, path, special_use) VALUES (?, ?, ?, ?)').run('drafts', 'Drafts', 'Drafts', '\\Drafts');
  return { db, getFolders: async () => [{ id: 'drafts', name: 'Drafts', path: 'Drafts', specialUse: '\\Drafts', type: 'drafts' }] };
};
const draft = () => ({ accountId: 'account-a', accountEmail: 'me@example.test', to: 'you@example.test', subject: 'Meeting', body: proposal().slots[0].label, calendarAvailability: proposal() });

beforeEach(() => {
  vi.clearAllMocks(); h.handlers.clear(); h.accounts.clear(); h.connected = false;
  h.accounts.set('account-a', createMailbox()); h.accounts.set('account-b', createMailbox());
  registerDraftHandlers();
});
afterEach(() => {
  for (const db of owned.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('local meeting draft metadata storage', () => {
  it('survives a database reopen and normalized server Message-ID spelling', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-draft-calendar-')); directories.push(directory);
    const path = join(directory, 'mailbox.db');
    const db = keep(openTestDb(path));
    saveDraftCalendarAvailability(db, 'account-a', '<Draft-1@Example.Test>', proposal());
    db.close();
    const reopened = keep(openTestDb(path));
    expect(readDraftCalendarAvailability(reopened, 'account-a', 'draft-1@example.test')).toEqual(proposal());
    expect(readDraftCalendarAvailability(reopened, 'account-b', '<Draft-1@Example.Test>')).toBeUndefined();
    deleteDraftCalendarAvailability(reopened, 'account-b', ['draft-1@example.test']);
    expect(readDraftCalendarAvailability(reopened, 'account-a', '<Draft-1@Example.Test>')).toEqual(proposal());
    deleteDraftCalendarAvailability(reopened, 'account-a', ['draft-1@example.test']);
    expect(readDraftCalendarAvailability(reopened, 'account-a', '<Draft-1@Example.Test>')).toBeUndefined();
  });

  it('can read an ordinary draft from a readonly database without creating a table', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-ordinary-draft-')); directories.push(directory);
    const path = join(directory, 'mailbox.db');
    const db = keep(openTestDb(path)); db.exec('CREATE TABLE ordinary(id TEXT)'); db.close();
    const readonly = keep(openTestDb(path, { readonly: true }));
    expect(readDraftCalendarAvailability(readonly, 'account-a', '<ordinary@example.test>')).toBeUndefined();
    expect(readonly.prepare("SELECT name FROM sqlite_master WHERE name = 'local_draft_calendar_metadata'").get()).toBeUndefined();
  });

  it('rejects corrupt persisted metadata rather than treating it as an ordinary draft', () => {
    const db = h.accounts.get('account-a').db;
    saveDraftCalendarAvailability(db, 'account-a', '<meeting@example.test>', proposal());
    db.prepare('UPDATE local_draft_calendar_metadata SET data = ?').run('{broken json');
    expect(() => readDraftCalendarAvailability(db, 'account-a', '<meeting@example.test>')).toThrow();
  });

  it.each([
    { status: 'no_calendars' }, { scope: 'external' }, { durationMinutes: 0 }, { timeZone: 'Invalid/Zone' },
    { slots: [{ startMs, endMs: startMs + 60_000, label: 'Wrong duration' }] },
    { slots: [{ startMs: startMs - 1, endMs: startMs + 1_799_999, label: 'Outside checked range' }] },
  ])('rejects invalid proposal fields %j', changes => {
    expect(() => validateDraftCalendarAvailability({ ...proposal(), ...changes })).toThrow();
  });
});

describe('meeting draft save and reopen IPC', () => {
  it('keeps metadata alongside the actual saved Message-ID without adding it to IMAP MIME', async () => {
    h.connected = true;
    const result = await saveDraftToIMAP(draft(), { messageId: '<stable-draft@example.test>' });
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('<stable-draft@example.test>');
    expect(h.append).toHaveBeenCalledOnce();
    const mime = String(h.append.mock.calls[0][1]);
    expect(mime).not.toContain('Private calendar name');
    expect(mime).not.toContain('private-calendar-id');
    expect(mime).not.toContain('calendarAvailability');
    const reopened = await h.handlers.get('drafts:get-calendar-availability')!(trusted(), result.messageId, 'account-a');
    expect(reopened).toEqual({ success: true, data: proposal() });
    expect(await h.handlers.get('drafts:get-calendar-availability')!(trusted(), result.messageId, 'account-b')).toEqual({ success: true, data: undefined });
  });

  it('blocks iframe reads and metadata writes before touching the mailbox or sending mail', async () => {
    const iframe = { sender: h.sender, senderFrame: {} };
    expect(await h.handlers.get('drafts:get-calendar-availability')!(iframe, '<draft@example.test>', 'account-a')).toMatchObject({ success: false });
    expect(await h.handlers.get('drafts:save')!(iframe, draft())).toMatchObject({ success: false });
    expect(h.append).not.toHaveBeenCalled();
    expect(h.accounts.get('account-a').db.prepare('SELECT count(*) AS n FROM emails').get()).toEqual({ n: 0 });
  });

  it('never falls back to another account when saving or reading meeting evidence', async () => {
    await expect(saveDraftToIMAP({ ...draft(), accountId: 'removed-account' })).rejects.toThrow('Account unavailable');
    expect(await h.handlers.get('drafts:get-calendar-availability')!(trusted(), '<draft@example.test>', 'removed-account')).toEqual({ success: false, error: 'Account unavailable' });
    expect(h.accounts.get('account-a').db.prepare('SELECT count(*) AS n FROM emails').get()).toEqual({ n: 0 });
    expect(h.append).not.toHaveBeenCalled();
  });

  it('does not publish or append a meeting draft if its local evidence cannot be persisted', async () => {
    h.connected = true;
    const db = h.accounts.get('account-a').db;
    db.pragma('query_only = ON');
    await expect(saveDraftToIMAP(draft())).rejects.toThrow();
    expect(h.append).not.toHaveBeenCalled();
    expect(db.prepare('SELECT count(*) AS n FROM emails').get()).toEqual({ n: 0 });
  });

  it('retains the association for offline drafts and removes only the deleted replacement', async () => {
    const first = await saveDraftToIMAP(draft(), { messageId: '<first@example.test>' });
    const second = await saveDraftToIMAP(draft(), { messageId: '<replacement@example.test>' });
    expect(first.success && second.success).toBe(true);
    await h.handlers.get('drafts:delete')!(trusted(), { accountId: 'account-a', messageId: first.messageId });
    const db = h.accounts.get('account-a').db;
    expect(readDraftCalendarAvailability(db, 'account-a', first.messageId!)).toBeUndefined();
    expect(readDraftCalendarAvailability(db, 'account-a', second.messageId!)).toEqual(proposal());
    expect(h.append).not.toHaveBeenCalled();
  });

  it('never requires writable local metadata for a normal draft save', async () => {
    const ordinary = { ...draft(), calendarAvailability: undefined };
    const result = await saveDraftToIMAP(ordinary);
    expect(result.success).toBe(true);
    const db = h.accounts.get('account-a').db;
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'local_draft_calendar_metadata'").get()).toBeUndefined();
  });
});
