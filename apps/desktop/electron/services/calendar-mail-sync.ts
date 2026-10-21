import { authenticationFailed } from '@sarv-in/mailguard';
import { classifyFolder, createLogger, getEventBus, hasTag, sanitizeIcsText, type EmailRecord } from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { findStorageForEmail, getAccountIdForStorage, getAllAccountRuntimes, getMainWindow, getSyncEngineFor } from '../shared';

import { registryAccountEmail } from './accounts-registry';
import { getCoreDb } from './core-db';
import { CalendarInvitationValidationError, getLocalCalendarInvitationService } from './local-calendar-invitations';

const log = createLogger('calendar-mail-sync');
interface Candidate { accountId: string; emailId: string; attempts: number }
export interface CalendarMailTarget {
  accountEmail: string;
  email: EmailRecord;
  folder: { path: string; type?: string } | null;
  fetchIcs: () => Promise<string | null>;
  storeIcs: (ics: string) => Promise<void>;
}
interface Dependencies {
  database: () => Database.Database;
  resolve: (accountId: string, emailId: string) => Promise<CalendarMailTarget | null>;
  ingest: (input: { accountId: string; accountEmail: string; emailId: string; fromAddress: string; ics: string }) => { status: string };
  changed: () => void;
  clock?: () => number;
}

/** Durable, bounded mail work queue. Calendar sync never depends on AI being on. */
export class CalendarMailSync {
  private initialized?: Database.Database;
  private draining = false;
  private stopped = false;
  private readonly clock: () => number;
  constructor(private readonly deps: Dependencies) { this.clock = deps.clock ?? Date.now; }

  private database(): Database.Database {
    const db = this.deps.database();
    if (this.initialized !== db) {
      db.exec(`CREATE TABLE IF NOT EXISTS local_calendar_mail_work (
        account_id TEXT NOT NULL, email_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(account_id, email_id));`);
      this.initialized = db;
    }
    return db;
  }

  enqueue(accountId: string, emailId: string): void {
    if (!accountId || !emailId) return;
    this.database().prepare(`INSERT INTO local_calendar_mail_work(account_id,email_id) VALUES (?,?)
      ON CONFLICT(account_id,email_id) DO UPDATE SET state='pending',next_attempt=0 WHERE state='blocked'`).run(accountId, emailId);
  }

  async process(accountId: string, emailId: string, fetchIfNeeded = false): Promise<void> {
    const target = await this.deps.resolve(accountId, emailId);
    if (!target) throw new Error('The invitation account is not available yet.');
    const { email, folder } = target;
    if (!folder) throw new Error('The invitation folder is not available yet.');
    const kind = classifyFolder(folder);
    if (kind === 'spam' || kind === 'trash' || kind === 'sent' || kind === 'drafts' || hasTag(email.tags || '', 'spam')) {
      throw new BlockedCalendarMail('Invitations in Spam, Trash, Sent or Drafts do not update your calendar.');
    }
    if (email.authStatus) {
      let auth: Parameters<typeof authenticationFailed>[0];
      try { auth = JSON.parse(email.authStatus); } catch { throw new InvalidCalendarMail('The invitation authentication record could not be checked.'); }
      if (authenticationFailed(auth)) throw new BlockedCalendarMail('This invitation failed email authentication.');
    }
    let ics = sanitizeIcsText(email.calendarIcs);
    if (!ics && fetchIfNeeded) {
      ics = sanitizeIcsText(await target.fetchIcs());
      if (ics) await target.storeIcs(ics);
    }
    if (!ics) throw new InvalidCalendarMail('No supported meeting invitation was found in this email.');
    // Parser/version errors are terminal for these immutable message bytes.
    let result: { status: string };
    try { result = this.deps.ingest({ accountId, accountEmail: target.accountEmail, emailId, fromAddress: email.fromAddress, ics }); }
    catch (error) {
      if (error instanceof CalendarInvitationValidationError) throw new InvalidCalendarMail(error.message);
      throw error;
    }
    this.database().prepare("UPDATE local_calendar_mail_work SET state='done' WHERE account_id=? AND email_id=?").run(accountId, emailId);
    if (result.status === 'added' || result.status === 'updated' || result.status === 'cancelled') this.deps.changed();
  }

  async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      const rows = this.database().prepare("SELECT account_id AS accountId,email_id AS emailId,attempts FROM local_calendar_mail_work WHERE state='pending' AND next_attempt<=? ORDER BY next_attempt,rowid LIMIT 20").all(this.clock()) as Candidate[];
      for (const row of rows) {
        if (this.stopped) break;
        try { await this.process(row.accountId, row.emailId, true); }
        catch (error) {
          const state = error instanceof BlockedCalendarMail ? 'blocked' : error instanceof InvalidCalendarMail ? 'ignored' : 'pending';
          this.database().prepare('UPDATE local_calendar_mail_work SET state=?,attempts=attempts+1,next_attempt=? WHERE account_id=? AND email_id=?')
            .run(state, this.clock() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(row.attempts, 6)), row.accountId, row.emailId);
          log.debug('Calendar invitation deferred or ignored', row.accountId, row.emailId, error instanceof Error ? error.message : 'Unavailable');
        }
      }
    } finally { this.draining = false; }
  }

  stop(): void { this.stopped = true; }
}

class InvalidCalendarMail extends Error {}
class BlockedCalendarMail extends Error {}
let singleton: CalendarMailSync | undefined;
export function getCalendarMailSync(): CalendarMailSync {
  if (!singleton) singleton = new CalendarMailSync({
    database: getCoreDb,
    resolve: async (accountId, emailId) => {
      const storage = findStorageForEmail(emailId, accountId);
      // Never fall back to the active account for a mutation.
      if (!storage || getAccountIdForStorage(storage) !== accountId) return null;
      const accountEmail = registryAccountEmail(accountId);
      if (!accountEmail) return null;
      const email = await storage.getEmail(emailId);
      if (!email) return null;
      const folder = await storage.getFolder(email.folderId);
      return { accountEmail, email, folder,
        fetchIcs: async () => {
          const engine = getSyncEngineFor(accountId);
          if (!engine?.isConnected() || !folder || !email.uid) throw new Error('Waiting for the invitation account to connect.');
          return engine.getCalendarIcs(emailId, folder.path, email.uid);
        },
        storeIcs: async ics => { await storage.updateEmail(emailId, { calendarIcs: ics }); },
      };
    },
    ingest: input => getLocalCalendarInvitationService().ingest(input),
    changed: () => { try { getMainWindow()?.webContents.send('calendar:changed'); } catch { /* Saved already. */ } },
  });
  return singleton;
}

let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribes: Array<() => void> = [];
const scanned = new Set<string>();
let catchupRunning = false;
async function catchUp(): Promise<void> {
  if (catchupRunning) return;
  catchupRunning = true;
  try {
    for (const [accountId, runtime] of getAllAccountRuntimes()) {
      if (scanned.has(accountId)) continue;
      const db = (runtime.storage as unknown as { db?: Database.Database })?.db;
      if (!db) continue;
      // Existing cached invitations work offline too. No broad body downloads.
      const rows = db.prepare("SELECT id FROM emails WHERE calendar_ics IS NOT NULL AND calendar_ics != '' ORDER BY date DESC LIMIT 5000").all() as Array<{ id: string }>;
      for (const row of rows) getCalendarMailSync().enqueue(accountId, row.id);
      scanned.add(accountId);
    }
    await getCalendarMailSync().drain();
  } catch (error) { log.warn('Calendar mail catch-up will retry', error instanceof Error ? error.message : 'Unavailable'); }
  finally { catchupRunning = false; }
}

export function startCalendarMailSync(): void {
  if (timer) return;
  const enqueue = (emailId: string) => {
    const storage = findStorageForEmail(emailId);
    const accountId = getAccountIdForStorage(storage);
    if (!accountId) return;
    getCalendarMailSync().enqueue(accountId, emailId);
    void getCalendarMailSync().drain().catch(error => log.warn('Calendar sync will retry', String(error)));
  };
  const bus = getEventBus();
  unsubscribes = [
    bus.on('email:calendar-candidate', event => { if (event.type === 'email:calendar-candidate') enqueue(event.emailId); }),
    bus.on('email:body-ready', async event => {
      if (event.type !== 'email:body-ready') return;
      const storage = findStorageForEmail(event.emailId);
      const email = await storage?.getEmail(event.emailId);
      if (email?.calendarIcs) enqueue(event.emailId);
    }),
  ];
  timer = setInterval(() => { void catchUp(); }, 30_000);
  timer.unref?.();
  void catchUp();
}

export function stopCalendarMailSync(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
  singleton?.stop(); singleton = undefined;
  scanned.clear();
}
