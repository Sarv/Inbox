/**
 * Whether the user allows crash/error reports (Settings → General → Send crash
 * reports). On unless the user turned it off.
 *
 * Kept in its own tiny file in userData, NOT the core DB: Sentry starts at
 * module load in main.ts, before storage exists (and the DB may be what is
 * crashing), so the preference must be readable synchronously that early.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { app } from 'electron';

const FILE = 'crash-reports.json';

function prefPath(): string {
  return join(app.getPath('userData'), FILE);
}

/**
 * Read the saved choice. A missing file means "never chosen" → allowed. An
 * unreadable or corrupt file also reads as allowed: the only way to be opted out
 * is an explicit `{"enabled": false}` written by setCrashReportsEnabled.
 */
export function readCrashReportsEnabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(prefPath(), 'utf8')) as { enabled?: unknown };
    return parsed?.enabled !== false;
  } catch {
    return true;
  }
}

/** Persist the choice. Throws if it can't be written, so the caller can say so. */
export function writeCrashReportsEnabled(enabled: boolean): void {
  writeFileSync(prefPath(), `${JSON.stringify({ enabled })}\n`, { encoding: 'utf8', mode: 0o600 });
}
