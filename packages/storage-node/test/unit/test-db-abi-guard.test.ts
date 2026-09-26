import { describe, expect, it } from 'vitest';

import {
  TestDatabaseCtor,
  abiFailureMessage,
  currentRuntime,
  newMigratedDb,
  openTestDb,
} from '../../src/test-support/test-db';

// What breaks if this file fails: the diagnostic that tells a developer their
// better-sqlite3 is compiled for the other runtime's ABI, and how to fix that
// without breaking the app.
//
// This helper used to fall back to `node:sqlite` when the native addon would not
// load. The fallback ran real SQL, so most tests still passed — but the two
// drivers disagree on strictness, and the ones that noticed failed with
// `Unknown named parameter 'attachmentSizes'`: an error naming a column, in a
// repository that was not broken. The ABI was never mentioned. The guard below
// is the only thing standing between the next person and that same dead end.

describe('abiFailureMessage', () => {
  // If the message stops naming the fix, the error is just noise again — the
  // whole point is that it is actionable without reading test-db.ts. Under
  // plain Node the fix is the package's own test script, which rebuilds for
  // Node before vitest starts.
  it('sends plain Node to the package test script, which rebuilds for Node itself', () => {
    const message = abiFailureMessage(new Error('boom'), 'node');
    expect(message).toContain('pnpm test               # at the repo root: every suite');
    expect(message).toContain('pnpm test <test file>   # in the package directory');
  });

  // THE REGRESSION: the message told everyone to run `pnpm test:node-abi`, the
  // manual flip CLAUDE.md forbids. Left on Node's ABI, the desktop app cannot
  // open any database and boots as if it had no accounts, the reading that
  // made a startup sweep delete two live mailbox DBs on 2026-09-09.
  it.each(['node', 'electron'] as const)('never tells a run in %s to flip to Node by hand', (runtime) => {
    const message = abiFailureMessage(new Error('boom'), runtime);
    expect(message).not.toContain('test:node-abi');
    expect(message).not.toContain('native-abi.mjs node');
  });

  // Breaks: the only advice for someone whose dev app is running is a Node
  // rebuild, which pulls the Electron build out from under the app. Running
  // the tests inside Electron leaves the addon where the app needs it.
  it('offers plain Node the in-Electron run for while the dev app is up', () => {
    expect(abiFailureMessage(new Error('boom'), 'node')).toContain(
      'ELECTRON_RUN_AS_NODE=1 ../../node_modules/.bin/electron ../../node_modules/vitest/vitest.mjs run',
    );
  });

  // Breaks: a run inside Electron — which fails because the addon is on Node's
  // ABI — is sent to the plain-Node fix. `pnpm test` would then pass while the
  // addon stays on Node, and the dev app it was protecting cannot open a DB.
  it('tells a run inside Electron to rebuild for Electron, and nothing else', () => {
    const message = abiFailureMessage(new Error('boom'), 'electron');
    expect(message).toContain('node scripts/native-abi.mjs electron');
    expect(message).toMatch(/NOT a broken test/);
    expect(message).not.toMatch(/builds? for Node/);
  });

  // Breaks: the message stops following the process it is printed in, so an
  // Electron run is sent to the plain-Node fix (or the reverse).
  it('picks the fix for the runtime it is running in', () => {
    const cause = new Error('boom');
    expect(abiFailureMessage(cause)).toBe(abiFailureMessage(cause, currentRuntime()));
  });

  // The reader also has to get back to a runnable app, or they fix the tests
  // and then wonder why the desktop app stopped starting.
  it('names the command that switches back to Electron', () => {
    expect(abiFailureMessage(new Error('boom'))).toContain(
      'node scripts/native-abi.mjs electron',
    );
  });

  // Says "toolchain mismatch", so the reader does not go hunting for a bug in
  // the code under test — the exact wrong turn the old fallback caused.
  it('says the mismatch is not a broken test', () => {
    expect(abiFailureMessage(new Error('boom'))).toMatch(/NOT a broken test/);
  });

  // The original dlopen error must survive: without it there is nothing to
  // confirm the diagnosis against.
  it('keeps the underlying load error', () => {
    expect(abiFailureMessage(new Error('ERR_DLOPEN_FAILED: wrong ELF class'))).toContain(
      'ERR_DLOPEN_FAILED: wrong ELF class',
    );
  });

  // Non-Error causes (a thrown string, a null) must not blow up the formatter —
  // it runs on a path that is already failing.
  it('survives a non-Error cause', () => {
    expect(abiFailureMessage('plain string')).toContain('plain string');
    expect(() => abiFailureMessage(null)).not.toThrow();
  });
});

describe('currentRuntime', () => {
  // Breaks: a run inside Electron — how the suites are run while the dev app
  // is up — read as plain Node, and so sent to `pnpm test`, which passes while
  // leaving the addon on the Node ABI the app cannot load.
  it('reads Electron from process.versions, which ELECTRON_RUN_AS_NODE keeps', () => {
    expect(currentRuntime({ ...process.versions, electron: '43.2.0' })).toBe('electron');
  });

  // Breaks: plain Node read as Electron, and told to rebuild for Electron —
  // the one ABI plain Node, and so vitest, cannot load.
  it('reads plain Node when Electron has not set its version', () => {
    const { electron: _electron, ...node } = process.versions;
    expect(currentRuntime(node)).toBe('node');
  });

  // Breaks: the default stops reading the real process, so the message never
  // matches the runtime it is printed in.
  it('reads this process by default', () => {
    expect(currentRuntime()).toBe(currentRuntime(process.versions));
  });
});

describe('test-db has no silent fallback', () => {
  // The suite must run on the REAL binding. If this fails, the environment is
  // on the wrong ABI and every other assertion here is worthless.
  it('opens a database on the native binding', () => {
    const db = openTestDb();
    try {
      expect(db.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    } finally {
      db.close();
    }
  });

  // The exact difference that produced the phantom failure, pinned in the
  // correct direction: the NATIVE binding ignores a bound parameter the
  // statement never declared, while node:sqlite throws
  // `Unknown named parameter` (ERR_INVALID_STATE) for it. So the fallback was
  // strictly harsher than production, and invented failures that the real
  // driver — the one the app ships — does not have.
  //
  // This is a characterisation test, not an endorsement: silently dropping a
  // bound value is sloppy, and if the repo ever tightens that, this assertion
  // should be updated deliberately rather than deleted.
  it('ignores a named parameter the statement does not declare, as production does', () => {
    const db = openTestDb();
    try {
      const stmt = db.prepare('SELECT @declared AS value');
      expect(stmt.get({ declared: 1, undeclared: 2 })).toEqual({ value: 1 });
    } finally {
      db.close();
    }
  });

  // newMigratedDb is the entry point the failing suite used, so it is the one
  // that must reach the real schema rather than a substitute driver.
  it('builds the production schema through the same path', () => {
    const db = newMigratedDb();
    try {
      const emails = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='emails'")
        .get();
      expect(emails).toBeTruthy();
      // The column whose absence produced the misleading error.
      const columns = db.prepare('PRAGMA table_info(emails)').all() as { name: string }[];
      expect(columns.map((c) => c.name)).toContain('attachment_sizes');
    } finally {
      db.close();
    }
  });

  // TestDatabaseCtor is handed to vi.mock() at module-graph build time, so it
  // has to stay constructible — a module-level throw would take down whole
  // files that never open a database.
  it('exports a usable constructor rather than throwing at import', () => {
    expect(typeof TestDatabaseCtor).toBe('function');
    const db = new TestDatabaseCtor(':memory:');
    try {
      expect(db.prepare('SELECT 2 AS two').get()).toEqual({ two: 2 });
    } finally {
      db.close();
    }
  });
});
