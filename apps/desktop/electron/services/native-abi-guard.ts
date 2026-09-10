/**
 * Boot guard: refuse to start on a native SQLite module this process cannot load.
 *
 * `better-sqlite3` dlopens lazily — nothing fails at import, only at the first
 * `new Database(...)` — and every core-DB read absorbs that throw and answers
 * with an empty result. An unreadable store and an empty store are the same
 * value and opposite facts, so the app boots looking like a fresh install: no
 * accounts, no folders, no mail, onboarding screen. On 2026-09-09 that read
 * cost two live mailbox databases, swept as orphans of accounts the registry
 * could no longer name.
 *
 * The sweeps are guarded now, but "looks like a fresh install" is still the
 * worst possible way to report a broken toolchain: it invites the user to add
 * their account again on top of data that is still there. So we provoke the
 * load ourselves before anything opens a real database, and stop with a named
 * error instead.
 *
 * The message builder is pure so it can be asserted on without an actually
 * broken binding — the text IS the feature.
 */

import { createLogger } from '@sarvinbox/core';
import { describeNativeAbiFailure, probeBundledSqlite, type NativeSqliteProbe } from '@sarvinbox/storage-node';
import { app, dialog } from 'electron';

const logger = createLogger('native-abi-guard');

/** Title of the error dialog. Shown by name on all three platforms. */
export const ABI_FAILURE_TITLE = 'Sarv Inbox cannot open its databases';

/**
 * What the user (or the developer who flipped the ABI) is told.
 *
 * Deliberately says that nothing was deleted: the failure looks exactly like
 * data loss from the outside, and someone who believes their mail is gone does
 * destructive things to get it back.
 */
export function abiFailureReport(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return [
    describeNativeAbiFailure(cause),
    '',
    'The native SQLite module is built for exactly ONE runtime at a time: the app',
    "needs Electron's, and running the test suite builds it for Node. Nothing has",
    'been read, written or deleted — the app is stopping here rather than starting',
    'up with no accounts and no mail, which is what an unreadable database looks',
    'like from the inside.',
    '',
    'Rebuild it for Electron, then start the app again:',
    '',
    '  node scripts/native-abi.mjs electron',
    '',
    `Underlying load error: ${detail}`,
  ].join('\n');
}

export interface NativeAbiGuardDeps {
  probe?: () => NativeSqliteProbe;
  showErrorBox?: (title: string, content: string) => void;
  quit?: () => void;
  log?: (message: string) => void;
}

/**
 * Provoke the addon load. Returns true when the app may continue; on failure it
 * reports, quits, and returns false — the caller must stop initializing.
 */
export function ensureNativeSqliteLoadable(deps: NativeAbiGuardDeps = {}): boolean {
  const {
    probe = probeBundledSqlite,
    showErrorBox = (title: string, content: string) => dialog.showErrorBox(title, content),
    quit = () => app.quit(),
    log = (message: string) => logger.error(message),
  } = deps;

  const result = probe();
  if (result.ok) return true;

  const report = abiFailureReport(result.cause);
  // The log first: a headless or auto-started run may never see the dialog, and
  // an error box the user dismisses leaves nothing behind to diagnose from.
  log(`[Main] ${ABI_FAILURE_TITLE}\n${report}`);
  // Best-effort — a dialog can fail on a Linux session with no display server,
  // and a guard that throws on the way to reporting a failure reports nothing.
  try {
    showErrorBox(ABI_FAILURE_TITLE, report);
  } catch (err) {
    log(`[Main] could not show the native-module error dialog: ${(err as Error)?.message}`);
  }
  quit();
  return false;
}
