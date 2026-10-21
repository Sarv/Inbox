import { messageIdKey } from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import type { LocalCalendarAvailability } from '../../src/types/local-calendar';
import { validateTimeZone } from '../../src/utils/local-calendar';

const TABLE = 'local_draft_calendar_metadata';
const invalid = () => new Error('The saved meeting availability is invalid. Prepare the meeting draft again.');
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const instant = (value: unknown): value is number => Number.isSafeInteger(value) && Number.isFinite(new Date(value as number).getTime());

/** This is app-local evidence, never an email header or part of the draft MIME. */
export function validateDraftCalendarAvailability(value: unknown): LocalCalendarAvailability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const item = value as LocalCalendarAvailability;
  if (item.scope !== 'local-only' || item.status !== 'ready' || !instant(item.startMs) || !instant(item.endMs)
    || item.endMs <= item.startMs || item.endMs - item.startMs > 400 * 86_400_000 || !instant(item.checkedAt)
    || !Number.isInteger(item.durationMinutes) || item.durationMinutes < 5 || item.durationMinutes > 480
    || !Array.isArray(item.calendarIds) || item.calendarIds.length > 100 || item.calendarIds.some(id => !text(id, 200))
    || !Array.isArray(item.calendarNames) || item.calendarNames.length > 100 || item.calendarNames.some(name => !text(name, 100))
    || !Array.isArray(item.slots) || item.slots.length > 12) throw invalid();
  const timeZone = validateTimeZone(item.timeZone);
  const slots = item.slots.map(slot => {
    if (!slot || !instant(slot.startMs) || !instant(slot.endMs) || slot.startMs < item.startMs || slot.endMs > item.endMs
      || slot.endMs - slot.startMs !== item.durationMinutes * 60_000 || !text(slot.label, 500)) throw invalid();
    return { startMs: slot.startMs, endMs: slot.endMs, label: slot.label };
  });
  if (new Set(slots.map(slot => slot.startMs)).size !== slots.length) throw invalid();
  return { startMs: item.startMs, endMs: item.endMs, checkedAt: item.checkedAt, timeZone, durationMinutes: item.durationMinutes,
    calendarIds: [...item.calendarIds], calendarNames: [...item.calendarNames], scope: 'local-only', status: 'ready', slots };
}

function key(accountId: string, messageId: string): string {
  if (!text(accountId, 500) || !text(messageId, 1000)) throw new Error('A saved meeting draft needs its owning account and Message-ID.');
  const normalized = messageIdKey(messageId);
  if (!normalized) throw new Error('A saved meeting draft needs its Message-ID.');
  return normalized;
}

function exists(db: Database.Database): boolean {
  return !!db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', TABLE);
}

export function saveDraftCalendarAvailability(db: Database.Database, accountId: string, messageId: string, proposal: LocalCalendarAvailability): void {
  const normalized = key(accountId, messageId);
  const value = validateDraftCalendarAvailability(proposal);
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (account_id TEXT NOT NULL, message_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account_id, message_id))`);
  db.prepare(`INSERT INTO ${TABLE}(account_id, message_id, data) VALUES (?, ?, ?) ON CONFLICT(account_id, message_id) DO UPDATE SET data=excluded.data`)
    .run(accountId, normalized, JSON.stringify(value));
}

/** An ordinary draft never needs a writable metadata table merely to reopen. */
export function readDraftCalendarAvailability(db: Database.Database, accountId: string, messageId: string): LocalCalendarAvailability | undefined {
  const normalized = key(accountId, messageId);
  if (!exists(db)) return undefined;
  const row = db.prepare(`SELECT data FROM ${TABLE} WHERE account_id = ? AND message_id = ?`).get(accountId, normalized) as { data: string } | undefined;
  return row ? validateDraftCalendarAvailability(JSON.parse(row.data) as unknown) : undefined;
}

export function deleteDraftCalendarAvailability(db: Database.Database, accountId: string | null, messageIds: string[]): void {
  if (!accountId || !messageIds.length || !exists(db)) return;
  const remove = db.prepare(`DELETE FROM ${TABLE} WHERE account_id = ? AND message_id = ?`);
  db.transaction(() => { for (const messageId of messageIds) remove.run(accountId, key(accountId, messageId)); })();
}
