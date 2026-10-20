/**
 * Whether the user allows crash/error reports — asked once on first launch
 * (the consent dialog), changeable in Settings → General → Send crash reports.
 * Off until the user says yes (CASA L-8).
 *
 * Kept in its own tiny file in userData, NOT the core DB: Sentry starts at
 * module load in main.ts, before storage exists (and the DB may be what is
 * crashing), so the preference must be readable synchronously that early.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { app } from 'electron';

const FILE = 'crash-reports.json';

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
