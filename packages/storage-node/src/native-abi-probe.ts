/**
 * The one place that actually touches the compiled addon to see whether it
 * loads. Kept apart from native-abi.ts so the pure parsing and messages can be
 * imported by test helpers that mock `better-sqlite3` — see the note there.
 */

import Database from 'better-sqlite3';

import { probeNativeSqlite, type NativeSqliteProbe } from './native-abi';

/**
 * Provoke the lazy dlopen on the addon this package ships with.
 *
 * `:memory:` touches no file and needs no encryption key, so this costs a
 * handful of milliseconds and can run before anything else at startup.
 */
export function probeBundledSqlite(): NativeSqliteProbe {
  return probeNativeSqlite(() => new Database(':memory:'));
}
