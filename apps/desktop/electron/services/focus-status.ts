/**
 * Is macOS Focus / Do Not Disturb holding back notifications right now?
 *
 * While Focus is on, macOS accepts every notification into Notification Center
 * and shows no banner. The app has no way to tell: `Notification.show()`
 * succeeds and no `failed` event fires. So "Test notification" reported success
 * while the user saw nothing, and a Focus left on for weeks looked exactly like
 * a broken app.
 *
 * macOS exposes no public API for Focus state. It records manually-enabled
 * Focus modes (Control Center, the menu bar, a keyboard shortcut) as
 * "assertions" in ~/Library/DoNotDisturb/DB/Assertions.json. We read that file.
 * No maintained npm package does this: the old `do-not-disturb` style packages
 * read a `com.apple.notificationcenterui` default that Big Sur removed. So this
 * stays a small hand-rolled reader, and every unexpected shape reads as
 * 'unknown', never as 'off'.
 *
 * Known gap: a Focus turned on by a SCHEDULE or automation isn't stored as an
 * assertion, so this reports 'off' for it. The UI wording has to allow for that.
 */
import { promises as fs } from 'fs';
import * as path from 'path';

/** 'on' = a manual Focus is active; 'off' = none found; 'unknown' = couldn't tell. */
export type FocusStatus = 'on' | 'off' | 'unknown';

interface AssertionsFile {
  data?: Array<{ storeAssertionRecords?: unknown[] }>;
}

/**
 * Pure: decide Focus state from the text of Assertions.json. An active manual
 * Focus is one or more `storeAssertionRecords` entries. When Focus is turned
 * off, macOS writes an invalidation record and drops the assertions.
 */
export function parseFocusAssertions(raw: string): FocusStatus {
  let parsed: AssertionsFile;
  try {
    parsed = JSON.parse(raw) as AssertionsFile;
  } catch {
    return 'unknown';
  }
  if (!parsed || !Array.isArray(parsed.data)) return 'unknown';
  const active = parsed.data.some((entry) => Array.isArray(entry?.storeAssertionRecords) && entry.storeAssertionRecords.length > 0);
  return active ? 'on' : 'off';
}

export interface FocusStatusDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  readFile: (filePath: string) => Promise<string>;
}

/** Where macOS keeps the manual Focus assertions. */
export function focusAssertionsPath(homeDir: string): string {
  return path.join(homeDir, 'Library', 'DoNotDisturb', 'DB', 'Assertions.json');
}

/**
 * Read the current Focus state. Never throws. Returns 'unknown' off macOS and
 * whenever the file can't be read (for example, privacy settings blocking
 * access). A missing file means Focus has never been used on this Mac, so
 * that's 'off'.
 */
export async function readFocusStatus(deps: FocusStatusDeps): Promise<FocusStatus> {
  if (deps.platform !== 'darwin') return 'unknown';
  try {
    return parseFocusAssertions(await deps.readFile(focusAssertionsPath(deps.homeDir)));
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'off' : 'unknown';
  }
}

/** The real-OS dependencies, isolated here so the logic above stays testable. */
export function systemFocusStatusDeps(homeDir: string): FocusStatusDeps {
  return {
    platform: process.platform,
    homeDir,
    readFile: (filePath) => fs.readFile(filePath, 'utf8'),
  };
}
