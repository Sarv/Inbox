// TEST-ONLY helper: opens a REAL SQLite database for the storage-node suite.
//
// This helper deliberately has NO fallback. `better-sqlite3` is a compiled addon
// valid for exactly one ABI at a time, and `pnpm install` builds it for
// ELECTRON — which plain Node, and therefore vitest, cannot dlopen. When that
// happens the only correct outcome is a loud, named failure.
//
// It used to fall back to Node's built-in `node:sqlite` behind a better-sqlite3
// facade so the suite could run anyway. That silently changed which SQLite
// driver the tests exercised, and the two disagree: `node:sqlite` rejects a
// named parameter the statement doesn't declare, so a fresh `pnpm install`
// turned 15 passing tests into `Unknown named parameter 'attachmentSizes'` —
// an error that names a column and points at the repository, with nothing
// anywhere to suggest the real cause was the ABI. Whoever hit it went looking
// for a schema bug that did not exist.
//
// Everything here is deliberately dependency-free (no vitest import) so it can
// be imported from any test file without registering suites.

import { createRequire } from 'node:module';

import type Database from 'better-sqlite3';

import { createMigrationManager } from '../migrations';
import { describeNativeAbiFailure, probeNativeSqlite } from '../native-abi';

const requireFromHere = createRequire(import.meta.url);

/**
 * The message shown when the addon cannot be loaded. Exported so a test can
 * assert on it without needing an actually-broken binding: this string IS the
 * feature — a developer who never reads this file has to be able to act on it.
 */
export function abiFailureMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return [
    describeNativeAbiFailure(cause),
    '',
    'The addon is compiled for exactly ONE ABI at a time, and `pnpm install`',
    '(scripts/postinstall.mjs) builds it for ELECTRON, which plain Node — and so',
    'vitest — cannot dlopen. This is a toolchain mismatch, NOT a broken test:',
    'rebuild for Node and run the suite again.',
    '',
    '  pnpm test:node-abi                    # build for Node, then run tests',
    '  node scripts/native-abi.mjs electron  # switch back before starting the app',
    '',
    'CI avoids the flip entirely by installing with SARVINBOX_SKIP_ELECTRON_REBUILD=1.',
    '',
    `Underlying load error: ${detail}`,
  ].join('\n');
}

type CtorLoad = { ok: true; ctor: unknown } | { ok: false; cause: unknown };

/** Loaded lazily so a broken native binding costs one try/catch, not a crash. */
function loadNativeCtor(): CtorLoad {
  try {
    const mod = requireFromHere('better-sqlite3');
    const ctor = (mod?.default ?? mod) as unknown;
    // Touch the binding — the ABI error only surfaces when a DB is opened. Same
    // provocation the app's boot guard uses, so the two cannot drift.
    const Ctor = ctor as new (path: string) => { close: () => void };
    const probe = probeNativeSqlite(() => new Ctor(':memory:'));
    return probe.ok ? { ok: true, ctor } : { ok: false, cause: probe.cause };
  } catch (cause) {
    return { ok: false, cause };
  }
}

/**
 * A stand-in constructor that throws {@link abiFailureMessage} when anything
 * tries to open a database.
 *
 * It has to be a constructor rather than a thrown error at import time, because
 * `TestDatabaseCtor` is handed to `vi.mock('better-sqlite3', ...)` while the
 * module graph is still being built. Throwing there would fail every test in
 * the file — including ones that never touch SQLite — and bury the message in a
 * mock-factory stack trace.
 */
function throwingCtor(cause: unknown): unknown {
  return class UnloadableDatabase {
    constructor() {
      throw new Error(abiFailureMessage(cause));
    }
  };
}

const nativeLoad = loadNativeCtor();

/**
 * Constructor with better-sqlite3's `new Database(path, options)` shape. Pass
 * this to `vi.mock('better-sqlite3', ...)` when the code under test constructs
 * its own connection (SQLiteStorage does).
 */
export const TestDatabaseCtor = (
  nativeLoad.ok ? nativeLoad.ctor : throwingCtor(nativeLoad.cause)
) as unknown as typeof Database;

/** Open a real SQLite database (in-memory by default). */
export function openTestDb(
  path = ':memory:',
  options: { readonly?: boolean } = {},
): Database.Database {
  // Throw from the call site rather than from inside a constructor, so the
  // stack points at the test that wanted a database.
  if (!nativeLoad.ok) throw new Error(abiFailureMessage(nativeLoad.cause));
  const Ctor = TestDatabaseCtor as unknown as new (p: string, o?: unknown) => Database.Database;
  return new Ctor(path, options);
}

/**
 * Open a database carrying the CURRENT production schema (schema.sql + every
 * incremental migration). Repositories tested against this cannot drift from the
 * real column set — a missing column or renamed table fails the test instead of
 * only failing in the app.
 */
export function newMigratedDb(path = ':memory:'): Database.Database {
  const db = openTestDb(path);
  createMigrationManager(db).migrate();
  return db;
}
