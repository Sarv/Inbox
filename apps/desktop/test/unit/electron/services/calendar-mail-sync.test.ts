import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../electron/services/core-db', () => ({ getCoreDb: vi.fn() }));
vi.mock('../../../../electron/services/accounts-registry', () => ({ registryAccountEmail: vi.fn() }));
vi.mock('../../../../electron/services/local-calendar-invitations', () => ({ getLocalCalendarInvitationService: vi.fn(), CalendarInvitationValidationError: class extends Error {} }));
vi.mock('../../../../electron/shared', () => ({ findStorageForEmail: vi.fn(), getAccountIdForStorage: vi.fn(), getAllAccountRuntimes: vi.fn(() => []), getMainWindow: vi.fn(), getSyncEngineFor: vi.fn() }));

import { CalendarMailSync, type CalendarMailTarget } from '../../../../electron/services/calendar-mail-sync';

const ICS = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR';
let db: Database.Database;
const ingest = vi.fn(() => ({ status: 'added' }));
const changed = vi.fn();
let target: CalendarMailTarget;
let now = 1_000_000;
const resolve = vi.fn(async () => target);
let service: CalendarMailSync;

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(':memory:'); now = 1_000_000;
  target = {
    accountEmail: 'other@sarv.com',
    email: { id: 'm1', folderId: 'inbox', fromAddress: 'organizer@example.com', calendarIcs: ICS, tags: '||', uid: 1 } as CalendarMailTarget['email'],
    folder: { path: 'INBOX' }, fetchIcs: vi.fn(async () => ICS), storeIcs: vi.fn(async () => {}),
  };
  resolve.mockImplementation(async () => target);
  ingest.mockImplementation(() => ({ status: 'added' }));
  service = new CalendarMailSync({ database: () => db, resolve, ingest, changed, clock: () => now });
});
afterEach(() => { service.stop(); db.close(); });
const pending = () => db.prepare('SELECT state,attempts FROM local_calendar_mail_work').all();

describe('calendar mail sync', () => {
  it('routes captured invitations to their owning account without fetching or AI', async () => {
    service.enqueue('other-account', 'm1'); await service.drain();
    expect(resolve).toHaveBeenCalledWith('other-account', 'm1');
    expect(ingest).toHaveBeenCalledWith({ accountId: 'other-account', accountEmail: 'other@sarv.com', emailId: 'm1', fromAddress: 'organizer@example.com', ics: ICS });
    expect(target.fetchIcs).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();
    expect(pending()).toEqual([{ state: 'done', attempts: 0 }]);
  });

  it('fetches an identified invite once when its body is not downloaded and survives restart', async () => {
    target.email.calendarIcs = null;
    service.enqueue('a', 'm1'); service.stop();
    service = new CalendarMailSync({ database: () => db, resolve, ingest, changed });
    await service.drain();
    expect(target.fetchIcs).toHaveBeenCalledOnce(); expect(target.storeIcs).toHaveBeenCalledWith(ICS);
    service.enqueue('a', 'm1'); await service.drain();
    expect(ingest).toHaveBeenCalledOnce();
  });

  it('retries a disconnected account without dropping its invitation', async () => {
    target.email.calendarIcs = null;
    vi.mocked(target.fetchIcs).mockRejectedValueOnce(new Error('Disconnected'));
    service.enqueue('a', 'm1'); await service.drain();
    expect(pending()).toEqual([{ state: 'pending', attempts: 1 }]); expect(ingest).not.toHaveBeenCalled();
    now += 30_000; await service.drain(); expect(ingest).toHaveBeenCalledOnce();
  });

  it.each(['Spam', 'Trash', 'Sent', 'Drafts'])('does not let %s change calendar availability', async path => {
    target.folder = { path }; service.enqueue('a', 'm1'); await service.drain();
    expect(ingest).not.toHaveBeenCalled(); expect(pending()[0]).toEqual({ state: 'blocked', attempts: 1 });
  });

  it('retries a blocked invitation when its email is restored to Inbox', async () => {
    target.folder = { path: 'Trash' }; service.enqueue('a', 'm1'); await service.drain();
    target.folder = { path: 'INBOX' }; service.enqueue('a', 'm1'); await service.drain();
    expect(ingest).toHaveBeenCalledOnce(); expect(pending()[0]).toEqual({ state: 'done', attempts: 1 });
  });

  it('does not fetch unidentified ordinary mail when resolving the invite banner', async () => {
    target.email.calendarIcs = null;
    await expect(service.process('a', 'm1')).rejects.toThrow('No supported meeting');
    expect(target.fetchIcs).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent drain requests and stops between messages', async () => {
    service.enqueue('a', 'm1'); service.enqueue('a', 'm2');
    ingest.mockImplementation(() => { service.stop(); return { status: 'added' }; });
    await Promise.all([service.drain(), service.drain()]);
    expect(ingest).toHaveBeenCalledOnce(); expect(pending()).toEqual([{ state: 'done', attempts: 0 }, { state: 'pending', attempts: 0 }]);
  });
});
