import { sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "Compress database" orchestration — the guards around VACUUM.
 *
 * The rebuild itself is SQLite's job; everything dangerous about this feature is
 * in the sequencing, and that is what these tests pin:
 *
 *   - it must never start while the account is syncing (the exclusive lock would
 *     stall the sync until its IMAP connections time out),
 *   - it must never start without room for the full second copy VACUUM writes,
 *   - it must never run twice at once (each run wants that second copy at the
 *     same moment, so two runs can exhaust a volume that had room for either),
 *   - and above all it MUST reopen the account afterwards — on success, on
 *     failure, on a worker that dies without saying anything. A missed reopen
 *     leaves the user's mailbox silently gone until they restart the app.
 *
 * The last one is the reason this file exists. Everything else is recoverable.
 */

const KEY = 'test-passphrase-never-logged';
const MB = 1024 * 1024;
const GB = 1024 * MB;

const h = vi.hoisted(() => ({
  userData: '/fake/userData',
  pageStats: { pageSize: 4096, pageCount: 2_569_337, freelistCount: 2_128_481 },
  syncing: false,
  storageOpen: true,
  freeDisk: 75 * 1024 * 1024 * 1024,
  statfsThrows: false,
  primaryAccountId: 'primary-account',

  // How the fake worker responds: 'message' with a payload, 'error', or 'exit'.
  workerOutcome: { event: 'message' as 'message' | 'error' | 'exit', payload: null as unknown },
  // Held promise the worker waits on before responding — lets a test keep one
  // compaction in flight while it fires a second.
  gate: Promise.resolve() as Promise<unknown>,
  openGate: (() => {}) as () => void,

  workerCalls: [] as Array<{ path: string; workerData: { dbPath: string; key: string } }>,
  // Interleaving of the steps that must not swap places.
  order: [] as string[],
  quiesced: [] as Array<{ accountId: string; reason: string; hold: boolean }>,
  released: [] as string[],
  reopened: [] as string[],
  reopenThrows: false,
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

vi.mock('node:fs/promises', () => ({
  statfs: async () => {
    if (h.statfsThrows) throw new Error('ENOSYS');
    return { bsize: 4096, bavail: Math.floor(h.freeDisk / 4096) };
  },
}));

vi.mock('node:worker_threads', () => ({
  Worker: class FakeWorker {
    private handlers: Record<string, (arg: unknown) => void> = {};

    constructor(path: string, options: { workerData: { dbPath: string; key: string } }) {
      h.workerCalls.push({ path, workerData: options.workerData });
      h.order.push('worker');
      // `on()` is registered synchronously right after construction, so wait a
      // turn (plus the test's gate) before emitting.
      void Promise.resolve(h.gate).then(() => {
        this.handlers[h.workerOutcome.event]?.(h.workerOutcome.payload);
      });
    }

    on(event: string, handler: (arg: unknown) => void) {
      this.handlers[event] = handler;
      return this;
    }
  },
}));

vi.mock('@sarvinbox/core', async (importOriginal) => ({
  // The estimate/headroom arithmetic is the real thing — mocking it would test
  // the mock. Only the logger is stubbed, to keep the run quiet.
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock('../../../../electron/services/accounts-runtime', () => ({
  PRIMARY_DB_FILE: 'sarvinbox.db',
  dbFileForAccount: (accountId: string) => `sarvinbox-${accountId}.db`,
  loadPrimaryAccountId: () => h.primaryAccountId,
  quiesceAccountRuntime: async (accountId: string, reason: string, options: { hold?: boolean } = {}) => {
    h.quiesced.push({ accountId, reason, hold: options.hold === true });
    h.order.push('quiesce');
  },
  releaseAccountMaintenance: (accountId: string) => {
    h.released.push(accountId);
    h.order.push('release');
  },
  ensureAccountRuntime: async (accountId: string) => {
    h.order.push('reopen');
    if (h.reopenThrows) throw new Error('reopen exploded');
    h.reopened.push(accountId);
    return null;
  },
}));

vi.mock('../../../../electron/services/db-key-store', () => ({
  getDbEncryptionKey: () => KEY,
}));

vi.mock('../../../../electron/shared', () => ({
  getAccountRuntime: () =>
    h.storageOpen
      ? { storage: { getPageStats: () => h.pageStats }, syncEngine: { isSyncing: () => h.syncing } }
      : undefined,
}));

import {
  compactAccountDatabase,
  compactionInProgress,
  compactWorkerPath,
  estimateCompaction,
  resolveUnpacked,
} from '../../../../electron/services/db-compact';

/** The worker's reply for a rebuild that reclaimed the whole freelist. */
const successPayload = {
  ok: true,
  before: { pageSize: 4096, pageCount: 2_569_337, freelistCount: 2_128_481 },
  after: { pageSize: 4096, pageCount: 440_856, freelistCount: 0 },
  autoVacuum: 2,
  rowsBefore: 26_262,
  rowsAfter: 26_262,
};

beforeEach(() => {
  h.pageStats = { pageSize: 4096, pageCount: 2_569_337, freelistCount: 2_128_481 };
  h.syncing = false;
  h.storageOpen = true;
  h.freeDisk = 75 * GB;
  h.statfsThrows = false;
  h.primaryAccountId = 'primary-account';
  h.workerOutcome = { event: 'message', payload: successPayload };
  h.gate = Promise.resolve();
  h.workerCalls = [];
  h.order = [];
  h.quiesced = [];
  h.released = [];
  h.reopened = [];
  h.reopenThrows = false;
});

afterEach(() => {
  expect(compactionInProgress()).toBeNull();
});

describe('resolveUnpacked', () => {
  // Breaks: in a packaged build the worker sits inside app.asar. File READS see
  // through the archive, but spawning a Worker from it does not — so the feature
  // works all the way through development and is dead on release day.
  it('redirects a path inside app.asar to the unpacked copy', () => {
    expect(resolveUnpacked(`${sep}Apps${sep}S.app${sep}app.asar${sep}dist${sep}w.js`)).toBe(
      `${sep}Apps${sep}S.app${sep}app.asar.unpacked${sep}dist${sep}w.js`,
    );
  });

  // Breaks: in development the path is rewritten to a directory that does not
  // exist, and Compress fails everywhere instead of nowhere.
  it('leaves an unpackaged development path alone', () => {
    const devPath = `${sep}repo${sep}apps${sep}desktop${sep}dist-electron${sep}w.js`;

    expect(resolveUnpacked(devPath)).toBe(devPath);
  });

  // Breaks: a directory merely NAMED app.asar-backup (or the archive itself as
  // the final path segment) gets mangled by a bare substring replace.
  it('only rewrites a real app.asar directory boundary', () => {
    expect(resolveUnpacked(`${sep}x${sep}app.asar-backup${sep}w.js`)).toBe(
      `${sep}x${sep}app.asar-backup${sep}w.js`,
    );
  });

  // Breaks: the worker path stops naming the worker at all.
  it('still names the worker file', () => {
    expect(compactWorkerPath()).toMatch(/db-compact\.worker\.js$/);
  });
});

describe('estimateCompaction', () => {
  // Breaks: the settings panel shows a size for an account whose handle is gone,
  // and offers a Compress button that cannot possibly work.
  it('returns null when the account is not open', () => {
    h.storageOpen = false;

    expect(estimateCompaction('acct-a')).toBeNull();
  });

  // Breaks: the user is told the wrong saving and agrees to a minutes-long
  // rebuild on a false number.
  it('reports the live file and reclaimable bytes and flags a worthwhile rebuild', () => {
    const report = estimateCompaction('acct-a');

    expect(report).toMatchObject({ accountId: 'acct-a', worthwhile: true });
    expect(report!.fileBytes).toBe(4096 * 2_569_337);
    expect(report!.freeBytes).toBe(4096 * 2_128_481);
  });

  // Breaks: a healthy database advertises a pointless rebuild.
  it('does not flag a database with nothing to reclaim', () => {
    h.pageStats = { pageSize: 4096, pageCount: 144_750, freelistCount: 0 };

    expect(estimateCompaction('acct-a')).toMatchObject({ freeBytes: 0, worthwhile: false });
  });

  // Breaks: a pragma failure on a half-closed handle throws out of an IPC
  // handler and the whole Advanced tab fails to load.
  it('returns null instead of throwing when the pragmas fail', () => {
    h.pageStats = null as never;

    expect(estimateCompaction('acct-a')).toBeNull();
  });
});

describe('compactAccountDatabase refusals', () => {
  // Breaks: VACUUM takes the exclusive lock out from under a running sync, which
  // stalls for minutes and drops its IMAP connections.
  it('refuses while the account is syncing, without touching the runtime', async () => {
    h.syncing = true;

    await expect(compactAccountDatabase('acct-a')).rejects.toThrow(/syncing right now/i);
    expect(h.quiesced).toEqual([]);
    expect(h.workerCalls).toEqual([]);
  });

  // Breaks: the app closes the account and spends minutes rebuilding to reclaim
  // nothing.
  it('refuses when there is nothing to reclaim', async () => {
    h.pageStats = { pageSize: 4096, pageCount: 144_750, freelistCount: 0 };

    await expect(compactAccountDatabase('acct-a')).rejects.toThrow(/no wasted space/i);
    expect(h.workerCalls).toEqual([]);
  });

  // Breaks: VACUUM writes a COMPLETE second copy before swapping. Sizing the
  // check off the post-compaction figure fills the volume mid-rebuild.
  it('refuses when the volume cannot hold a second copy of the CURRENT file', async () => {
    h.freeDisk = 3 * GB; // the compacted file would fit; the rebuild will not

    await expect(compactAccountDatabase('acct-a')).rejects.toThrow(/free disk space/i);
    expect(h.workerCalls).toEqual([]);
  });

  // Breaks: an unreadable volume is treated as infinite space and the rebuild
  // starts blind.
  it('refuses when free disk space cannot be read', async () => {
    h.statfsThrows = true;

    await expect(compactAccountDatabase('acct-a')).rejects.toThrow(/free disk space/i);
    expect(h.workerCalls).toEqual([]);
  });

  // Breaks: an IPC call with no account silently compacts the wrong database.
  it('refuses an empty account id', async () => {
    await expect(compactAccountDatabase('')).rejects.toThrow(/no account/i);
  });

  // Breaks: compacting an account whose handle is already closed would read
  // stats off nothing.
  it('refuses when the account is not open', async () => {
    h.storageOpen = false;

    await expect(compactAccountDatabase('acct-a')).rejects.toThrow(/not open/i);
  });

  // Breaks: two concurrent rebuilds each reserve a full second copy at the same
  // moment and together exhaust a volume that had room for either alone.
  it('refuses a second compaction while one is in flight', async () => {
    h.gate = new Promise((resolve) => {
      h.openGate = () => resolve(undefined);
    });

    const first = compactAccountDatabase('acct-a');
    try {
      // The lock is taken after the async disk check, so wait for it rather
      // than assuming a fixed number of microtasks.
      await vi.waitFor(() => expect(compactionInProgress()).toBe('acct-a'));

      await expect(compactAccountDatabase('acct-a')).rejects.toThrow(/already being compressed/i);
      await expect(compactAccountDatabase('acct-b')).rejects.toThrow(/another database/i);
    } finally {
      // Release even on failure — a held lock would leak into every later test.
      h.openGate();
      await first.catch(() => {});
    }

    expect(h.workerCalls).toHaveLength(1);
  });
});

describe('compactAccountDatabase', () => {
  // Breaks: the reported saving disagrees with what the file actually did, so
  // the user cannot tell whether it worked.
  it('closes the account, rebuilds, and reports the bytes reclaimed', async () => {
    const outcome = await compactAccountDatabase('acct-a');

    expect(h.quiesced).toEqual([{ accountId: 'acct-a', reason: 'compact', hold: true }]);
    expect(outcome.beforeBytes).toBe(4096 * 2_569_337);
    expect(outcome.afterBytes).toBe(4096 * 440_856);
    expect(outcome.reclaimedBytes).toBe(4096 * (2_569_337 - 440_856));
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  // Breaks: the whole point. Without the reopen the account is closed and gone
  // from the UI until the app restarts.
  it('reopens the account after a successful rebuild', async () => {
    await compactAccountDatabase('acct-a');

    expect(h.reopened).toEqual(['acct-a']);
  });

  // Breaks: a failed VACUUM leaves the ORIGINAL file intact but the account
  // closed — the user loses a working mailbox to a no-op failure.
  it('reopens the account when the worker reports a failure', async () => {
    h.workerOutcome = { event: 'message', payload: { ok: false, error: 'disk I/O error' } };

    await expect(compactAccountDatabase('acct-a')).rejects.toThrow('disk I/O error');
    expect(h.reopened).toEqual(['acct-a']);
  });

  // Breaks: same, for a worker that throws before it can reply.
  it('reopens the account when the worker errors', async () => {
    h.workerOutcome = { event: 'error', payload: new Error('worker blew up') };

    await expect(compactAccountDatabase('acct-a')).rejects.toThrow('worker blew up');
    expect(h.reopened).toEqual(['acct-a']);
  });

  // Breaks: a worker killed by the OS (OOM on a huge rebuild) posts nothing, so
  // an un-handled 'exit' would leave the promise pending FOREVER with the
  // account closed behind it — the worst failure mode this code has.
  it('reopens the account when the worker exits without replying', async () => {
    h.workerOutcome = { event: 'exit', payload: 9 };

    await expect(compactAccountDatabase('acct-a')).rejects.toThrow(/exited unexpectedly/i);
    expect(h.reopened).toEqual(['acct-a']);
  });

  // Breaks: a failure inside the reopen escapes and masks the real error, and
  // the in-flight lock is never cleared, so Compress is dead until restart.
  it('clears the in-flight lock even when the reopen itself fails', async () => {
    h.reopenThrows = true;

    await expect(compactAccountDatabase('acct-a')).resolves.toMatchObject({ accountId: 'acct-a' });
    expect(compactionInProgress()).toBeNull();
  });

  // Breaks: a worker started before the app's own handle is closed cannot get
  // the exclusive lock and the rebuild fails outright.
  it('quiesces the account BEFORE starting the worker', async () => {
    await compactAccountDatabase('acct-a');

    expect(h.order).toEqual(['quiesce', 'worker', 'release', 'reopen']);
  });

  /**
   * Breaks: OBSERVED on the 9.8 GB Gmail account. Closing the handle is not the
   * same as keeping the account shut — the renderer's sync tick reopened it 2.7
   * seconds into a 31-second VACUUM, which cost two `database is locked`
   * failures and left a 1.7 GB WAL beside the 1.7 GB rebuilt file, because the
   * rebuilding connection was no longer the only one holding it. The hold is
   * what makes the quiesce stick.
   */
  it('HOLDS the account closed for the whole rebuild, not just closes it', async () => {
    await compactAccountDatabase('acct-a');

    expect(h.quiesced[0].hold).toBe(true);
  });

  // Breaks: the hold outlives the rebuild, `ensureAccountRuntime` refuses our
  // own reopen, and the user is left with a mailbox that stays gone.
  it('releases the hold BEFORE reopening', async () => {
    await compactAccountDatabase('acct-a');

    expect(h.order.indexOf('release')).toBeLessThan(h.order.indexOf('reopen'));
    expect(h.released).toEqual(['acct-a']);
  });

  // Breaks: the UI cannot make the "all N emails are still here" claim, which
  // is the answer to the only question the word "compress" raises.
  it('carries the surviving email count and the auto-vacuum mode through', async () => {
    const outcome = await compactAccountDatabase('acct-a');

    expect(outcome.emailCount).toBe(26_262);
    expect(outcome.rowsPreserved).toBe(true);
    expect(outcome.autoVacuumEnabled).toBe(true);
  });

  /**
   * Breaks: VACUUM is a lossless rebuild, so this should be impossible — but if
   * it ever happens the original file has ALREADY been replaced, and a silent
   * `rowsPreserved: true` means the user finds out by noticing missing mail.
   */
  it('flags a row count that changed across the rebuild', async () => {
    h.workerOutcome = { event: 'message', payload: { ...successPayload, rowsAfter: 26_000 } };

    const outcome = await compactAccountDatabase('acct-a');

    expect(outcome.rowsPreserved).toBe(false);
  });

  // Breaks: an account whose rows could not be counted is reported as having
  // LOST mail, which is a false alarm about the scariest possible failure.
  it('treats an uncountable database as preserved, not as a loss', async () => {
    h.workerOutcome = {
      event: 'message',
      payload: { ...successPayload, rowsBefore: null, rowsAfter: null },
    };

    const outcome = await compactAccountDatabase('acct-a');

    expect(outcome.rowsPreserved).toBe(true);
    expect(outcome.emailCount).toBeNull();
  });

  // Breaks: a file that stayed on `auto_vacuum = NONE` is reported as converted,
  // so nobody expects it to bloat again.
  it('reports a failed auto-vacuum conversion as not enabled', async () => {
    h.workerOutcome = { event: 'message', payload: { ...successPayload, autoVacuum: 0 } };

    expect((await compactAccountDatabase('acct-a')).autoVacuumEnabled).toBe(false);
  });

  // Breaks: a rebuild that throws leaves the account permanently unopenable —
  // worse than the bloat it was trying to fix.
  it('releases the hold even when the rebuild fails', async () => {
    h.workerOutcome = { event: 'error', payload: new Error('disk exploded') };

    await expect(compactAccountDatabase('acct-a')).rejects.toThrow('disk exploded');
    expect(h.released).toEqual(['acct-a']);
  });
});

describe('compactAccountDatabase database targeting', () => {
  // Breaks: the primary account adopted the legacy `sarvinbox.db`; compacting a
  // hashed path instead would rebuild a file that isn't the one in use.
  it('uses the legacy filename for the primary account', async () => {
    h.primaryAccountId = 'acct-a';

    await compactAccountDatabase('acct-a');

    expect(h.workerCalls[0].workerData.dbPath).toMatch(/sarvinbox\.db$/);
  });

  // Breaks: a secondary account's rebuild is pointed at the primary's file.
  it('uses the hashed per-account filename for a secondary account', async () => {
    await compactAccountDatabase('acct-a');

    expect(h.workerCalls[0].workerData.dbPath).toMatch(/sarvinbox-acct-a\.db$/);
  });

  // Breaks: VACUUM rewrites every page through the connection's cipher settings.
  // Handing the worker no key (or a different one) produces a rebuilt file the
  // app can never decrypt again — total loss of the account.
  it('passes the same encryption key the app opens the database with', async () => {
    await compactAccountDatabase('acct-a');

    expect(h.workerCalls[0].workerData.key).toBe(KEY);
  });

  // Breaks: the key reaches a log line or a renderer-visible error string.
  it('never puts the key in the error surfaced to the caller', async () => {
    h.workerOutcome = { event: 'message', payload: { ok: false, error: 'SQL logic error' } };

    const error = await compactAccountDatabase('acct-a').catch((e: Error) => e);

    expect((error as Error).message).toBe('SQL logic error');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(KEY);
  });
});
