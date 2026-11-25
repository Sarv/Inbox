/**
 * Whether the user allows crash/error reports — asked once on first launch
 * (the consent dialog), changeable in Settings → General → Send crash reports.
 * Off until the user says yes (CASA L-8).
 *
 * Kept in its own tiny file in userData, NOT the core DB: Sentry starts at
 * module load in main.ts, before storage exists (and the DB may be what is
 * crashing), so the preference must be readable synchronously that early.
 */
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { readRegularFileSync, writePrivateFileAtomicSync } from '@sarvinbox/core';
import { app } from 'electron';

const FILE = 'crash-reports.json';
const ID_FILE = 'crash-report-id';

/**
 * The user's answer. `unasked` means no answer yet: nothing is sent, and the
 * consent dialog asks on the next launch that shows the main window.
 */
export type CrashReportChoice = 'yes' | 'no' | 'unasked';

/** The two answers a user can give (what the setter accepts). */
export type CrashReportAnswer = Exclude<CrashReportChoice, 'unasked'>;

function prefPath(): string {
  return join(app.getPath('userData'), FILE);
}

/**
 * Read the saved choice: `{"choice":"yes"|"no"}`.
 *
 * Files written before crash reporting became opt-in hold `{"enabled": …}`.
 * An explicit `false` was a real opt-out and stays a "no". A `true` was
 * written for EVERYONE who never turned it off (the renderer pushed its
 * default on every launch), so it is no evidence of consent: it reads as
 * `unasked`, and that user is asked. A missing, unreadable or corrupt file is
 * `unasked` too — never a yes.
 */
export function readCrashReportChoice(): CrashReportChoice {
  try {
    const parsed = JSON.parse(readFileSync(prefPath(), 'utf8')) as { choice?: unknown; enabled?: unknown } | null;
    if (parsed?.choice === 'yes' || parsed?.choice === 'no') return parsed.choice;
    if (parsed?.enabled === false) return 'no';
    return 'unasked';
  } catch {
    return 'unasked';
  }
}

/** Persist the answer. Throws if it can't be written, so the caller can say so. */
export function writeCrashReportChoice(choice: CrashReportAnswer): void {
  writeFileSync(prefPath(), `${JSON.stringify({ choice })}\n`, { encoding: 'utf8', mode: 0o600 });
}

// A random UUID (v4), lower-case, nothing else.
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The id crash reports from this installation carry, so reports from one
 * computer group together: a random UUID made on first use and kept in its
 * own file in userData. Random, so it is derived from nothing — it used to be
 * a truncated SHA-256 of the account's address, which anyone holding a guess
 * at the address could confirm, and which changed with whichever account
 * connected last. The same for every account on this computer.
 *
 * A missing, unreadable or malformed file gets a new id (written owner-only,
 * whole or not at all). If even that write fails, the new id is used for this
 * run only: a fresh id each launch splits one computer's reports apart, which
 * is better than tying them to anything about the user.
 */
export function crashReportInstallId(): string {
  const path = join(app.getPath('userData'), ID_FILE);
  try {
    const saved = readRegularFileSync(path, { minBytes: 36, maxBytes: 64 }).toString('utf8').trim();
    if (INSTALL_ID.test(saved)) return saved;
  } catch { /* missing or unreadable: make one */ }
  const id = randomUUID();
  try {
    writePrivateFileAtomicSync(path, `${id}\n`);
  } catch { /* this run only */ }
  return id;
}
